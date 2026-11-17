// Outbound governor (1.3 rate caps + global breaker, 1.4 quiet hours). Every AUTONOMOUS client-facing
// send (routine email reply, review-thread replies, proactive SMS, an approved commitment reply) passes
// through gateOutbound() BEFORE the raw transport. The gate:
//   - trips a GLOBAL breaker (>N sends/rolling hour → pause all outbound + page the owner) — 50 sends/hr
//     from a 3-client shop means something is looping;
//   - enforces per-thread (hour/day) and per-contact (day) caps — the out-of-office / QA-fix loop guard;
//   - defers "deferrable" sends that fall in a client's QUIET HOURS to the next local 08:00.
// Nothing is ever silently dropped: a capped send is recorded "blocked" (visible in the ops brief); a
// quiet-hours send is recorded "queued" and flushed in the morning by the outbound-flush scheduler job.
//
// The gate is a PRE-CHECK, separate from the raw senders (sendClientEmail / sendSMS), so the flush job
// re-sends via the raw transport with no recursion.

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store, newId, nowISO, logEvent } from "@/lib/persistence/store";
import type { Channel, Client, OutboundRecord } from "@/lib/friday/types";

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const MAX_PER_THREAD_HOUR = () => num(process.env.OUTBOUND_MAX_PER_THREAD_HOUR, 4);
const MAX_PER_THREAD_DAY  = () => num(process.env.OUTBOUND_MAX_PER_THREAD_DAY, 10);
const MAX_PER_CONTACT_DAY = () => num(process.env.OUTBOUND_MAX_PER_CONTACT_DAY, 30);
const GLOBAL_HOUR_BREAKER = () => num(process.env.OUTBOUND_GLOBAL_HOUR_BREAKER, 50);

const HOUR = 3_600_000, DAY = 86_400_000;

export function threadKeyFor(channel: Channel, to: string, emailThreadId?: string): string {
  if (channel === "email") return emailThreadId ? `mail:${emailThreadId}` : `mail:${to.toLowerCase()}`;
  return `sms:${to.replace(/[^\d+]/g, "")}`;
}

export interface OutboundMeta {
  channel: Channel;
  to: string;
  threadKey: string;
  clientId?: string;
  kind: string;
}

// ── Global breaker pause (persisted, auto-expiring) ──────────────────────────
const PAUSE_FILE = path.join(FRIDAY_DATA_DIR, "outbound-pause.json");
async function pausedUntil(): Promise<number> {
  try { return Number(JSON.parse(await fs.readFile(PAUSE_FILE, "utf8")).until) || 0; } catch { return 0; }
}
async function setPause(untilMs: number, reason: string): Promise<void> {
  try { await fs.writeFile(PAUSE_FILE, JSON.stringify({ until: untilMs, reason, at: nowISO() }, null, 2), "utf8"); } catch { /* best-effort */ }
}
/** Owner "resume sends" command clears the pause. */
export async function clearOutboundPause(): Promise<void> { await setPause(0, "cleared"); }
export async function outboundPaused(): Promise<boolean> { return (await pausedUntil()) > Date.now(); }

// ── Counting (over the "sent" ledger) ────────────────────────────────────────
async function sentSince(sinceMs: number): Promise<OutboundRecord[]> {
  const cut = sinceMs;
  return (await store.outbound.find((r) => r.status === "sent" && Date.parse(r.ts) >= cut));
}

// ── Quiet hours (client-local) ───────────────────────────────────────────────
// "19:00-08:00" => quiet from 19:00 to 08:00 next day; send window 08:00-19:00 local.
function quietWindow(): { start: number; end: number } {
  const raw = process.env.QUIET_HOURS_CLIENT_LOCAL || "19:00-08:00";
  const m = raw.match(/^(\d{1,2}):?\d{0,2}\s*-\s*(\d{1,2}):?\d{0,2}$/);
  return { start: m ? Number(m[1]) : 19, end: m ? Number(m[2]) : 8 };
}
// Wall-clock offset (ms) of a tz at an instant: (wall-time-as-UTC) - actual-UTC.
function tzOffsetMs(tz: string, atMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(atMs))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return asUtc - atMs;
}
function localHour(tz: string, atMs: number): number {
  return new Date(atMs + tzOffsetMs(tz, atMs)).getUTCHours();
}
// Epoch ms of the next local `hour`:00 in tz at/after atMs.
function nextLocalHourMs(tz: string, hour: number, atMs: number): number {
  const off = tzOffsetMs(tz, atMs);
  const local = new Date(atMs + off);
  let y = local.getUTCFullYear(), mo = local.getUTCMonth(), d = local.getUTCDate();
  if (local.getUTCHours() >= hour) { const nd = new Date(Date.UTC(y, mo, d + 1)); y = nd.getUTCFullYear(); mo = nd.getUTCMonth(); d = nd.getUTCDate(); }
  return Date.UTC(y, mo, d, hour, 0, 0) - off; // wall-clock target back to UTC
}

// US state (abbrev or full) -> representative IANA tz. States spanning zones use the dominant zone.
const STATE_TZ: Record<string, string> = {
  al:"America/Chicago",ak:"America/Anchorage",az:"America/Phoenix",ar:"America/Chicago",ca:"America/Los_Angeles",
  co:"America/Denver",ct:"America/New_York",de:"America/New_York",fl:"America/New_York",ga:"America/New_York",
  hi:"Pacific/Honolulu",id:"America/Boise",il:"America/Chicago",in:"America/Indiana/Indianapolis",ia:"America/Chicago",
  ks:"America/Chicago",ky:"America/New_York",la:"America/Chicago",me:"America/New_York",md:"America/New_York",
  ma:"America/New_York",mi:"America/Detroit",mn:"America/Chicago",ms:"America/Chicago",mo:"America/Chicago",
  mt:"America/Denver",ne:"America/Chicago",nv:"America/Los_Angeles",nh:"America/New_York",nj:"America/New_York",
  nm:"America/Denver",ny:"America/New_York",nc:"America/New_York",nd:"America/Chicago",oh:"America/New_York",
  ok:"America/Chicago",or:"America/Los_Angeles",pa:"America/New_York",ri:"America/New_York",sc:"America/New_York",
  sd:"America/Chicago",tn:"America/Chicago",tx:"America/Chicago",ut:"America/Denver",vt:"America/New_York",
  va:"America/New_York",wa:"America/Los_Angeles",wv:"America/New_York",wi:"America/Chicago",wy:"America/Denver",dc:"America/New_York",
};
const STATE_NAMES: Record<string, string> = { alabama:"al",alaska:"ak",arizona:"az",arkansas:"ar",california:"ca",colorado:"co",connecticut:"ct",delaware:"de",florida:"fl",georgia:"ga",hawaii:"hi",idaho:"id",illinois:"il",indiana:"in",iowa:"ia",kansas:"ks",kentucky:"ky",louisiana:"la",maine:"me",maryland:"md",massachusetts:"ma",michigan:"mi",minnesota:"mn",mississippi:"ms",missouri:"mo",montana:"mt",nebraska:"ne",nevada:"nv","new hampshire":"nh","new jersey":"nj","new mexico":"nm","new york":"ny","north carolina":"nc","north dakota":"nd",ohio:"oh",oklahoma:"ok",oregon:"or",pennsylvania:"pa","rhode island":"ri","south carolina":"sc","south dakota":"sd",tennessee:"tn",texas:"tx",utah:"ut",vermont:"vt",virginia:"va",washington:"wa","west virginia":"wv",wisconsin:"wi",wyoming:"wy" };

// Resolve a client's IANA timezone: explicit field first, else derive from state, else a central-US
// default (worst-case ~2h off the coasts — still avoids the true 3am send).
export function clientTimezone(client?: Pick<Client, "timezone" | "state"> | null): string {
  if (client?.timezone) return client.timezone;
  const s = (client?.state ?? "").trim().toLowerCase();
  if (s) return STATE_TZ[s] ?? STATE_TZ[STATE_NAMES[s] ?? ""] ?? "America/Chicago";
  return "America/Chicago";
}

// ── The gate ─────────────────────────────────────────────────────────────────
export type GateAction =
  | { action: "send" }
  | { action: "queue"; sendAfterMs: number; reason: string }
  | { action: "block"; reason: string };

export async function gateOutbound(meta: OutboundMeta, opts: { deferrable?: boolean; client?: Client | null } = {}): Promise<GateAction> {
  const now = Date.now();

  if (await outboundPaused()) return { action: "block", reason: "global outbound pause (breaker) active" };

  const hourSent = await sentSince(now - HOUR);
  if (hourSent.length >= GLOBAL_HOUR_BREAKER()) {
    await setPause(now + HOUR, "global hourly breaker tripped");
    await logEvent("outbound.breaker", { hourCount: hourSent.length, cap: GLOBAL_HOUR_BREAKER() }, { level: "error" });
    const { notifyOwner } = await import("@/lib/friday/notify");
    await notifyOwner({ kind: "outbound.breaker", priority: "critical", text: `🚨 Outbound paused — ${hourSent.length} client messages in the last hour (cap ${GLOBAL_HOUR_BREAKER()}). Something is looping. All sends held; text "resume sends" once it's sorted.`, dedupeKey: `breaker:${Math.floor(now / HOUR)}` }).catch(() => {});
    return { action: "block", reason: "global hourly breaker" };
  }

  const perThreadHour = hourSent.filter((r) => r.threadKey === meta.threadKey).length;
  if (perThreadHour >= MAX_PER_THREAD_HOUR()) return { action: "block", reason: `thread hourly cap (${MAX_PER_THREAD_HOUR()})` };

  const daySent = await sentSince(now - DAY);
  const perThreadDay = daySent.filter((r) => r.threadKey === meta.threadKey).length;
  if (perThreadDay >= MAX_PER_THREAD_DAY()) return { action: "block", reason: `thread daily cap (${MAX_PER_THREAD_DAY()})` };
  const perContactDay = daySent.filter((r) => r.to.toLowerCase() === meta.to.toLowerCase()).length;
  if (perContactDay >= MAX_PER_CONTACT_DAY()) return { action: "block", reason: `contact daily cap (${MAX_PER_CONTACT_DAY()})` };

  if (opts.deferrable) {
    const tz = clientTimezone(opts.client);
    const { start, end } = quietWindow();
    const h = localHour(tz, now);
    const inQuiet = start > end ? (h >= start || h < end) : (h >= start && h < end);
    if (inQuiet) return { action: "queue", sendAfterMs: nextLocalHourMs(tz, end, now), reason: `quiet hours (${tz}, local ${h}:00)` };
  }
  return { action: "send" };
}

// ── Ledger + queue writes ────────────────────────────────────────────────────
export async function recordSent(meta: OutboundMeta): Promise<void> {
  await store.outbound.insert({ id: newId(), ts: nowISO(), status: "sent", ...meta });
}
export async function recordBlocked(meta: OutboundMeta, reason: string): Promise<void> {
  await store.outbound.insert({ id: newId(), ts: nowISO(), status: "blocked", reason, ...meta });
  await logEvent("outbound.blocked", { channel: meta.channel, kind: meta.kind, reason }, { level: "warn" });
}
export async function enqueue(meta: OutboundMeta, sendAfterMs: number, reason: string, payload: NonNullable<OutboundRecord["payload"]>): Promise<void> {
  await store.outbound.insert({ id: newId(), ts: nowISO(), status: "queued", sendAfterMs, reason, payload, ...meta });
  await logEvent("outbound.queued", { channel: meta.channel, kind: meta.kind, reason, sendAfter: new Date(sendAfterMs).toISOString() });
}

// ── Flush (scheduler job) ─────────────────────────────────────────────────────
export async function flushOutboundQueue(): Promise<string> {
  const now = Date.now();
  const due = (await store.outbound.find((r) => r.status === "queued" && (r.sendAfterMs ?? Infinity) <= now));
  if (!due.length) return "none due";
  let sent = 0, held = 0;
  for (const r of due.slice(0, 25)) {
    // Re-gate for caps only (quiet hours has passed); a still-capped message stays queued for later.
    const gate = await gateOutbound({ channel: r.channel, to: r.to, threadKey: r.threadKey, clientId: r.clientId, kind: r.kind }, { deferrable: false });
    if (gate.action !== "send") { held++; continue; }
    const p = r.payload;
    if (!p) { await store.outbound.update(r.id, { status: "blocked", reason: "no payload" }); continue; }
    let ok = false;
    if (r.channel === "email") {
      const { sendClientEmail } = await import("@/lib/friday/emailAgent");
      const res = await sendClientEmail({ to: r.to, subject: p.subject ?? "", body: p.body, cc: p.cc, replyToThreadId: p.replyToThreadId, inReplyTo: p.inReplyTo, references: p.references }).catch(() => ({ ok: false }));
      ok = res.ok;
    } else {
      const { sendSMS } = await import("@/lib/friday/channels");
      const res = await sendSMS(r.to, p.body).catch(() => ({ ok: false }));
      ok = res.ok;
    }
    if (ok) { await store.outbound.update(r.id, { status: "sent", ts: nowISO() }); sent++; }
    else { held++; }
  }
  return `${sent} flushed, ${held} still held`;
}
