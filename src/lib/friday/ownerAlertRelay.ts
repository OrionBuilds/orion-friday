// Outbound channels for the liveness alarm (2026-10-29 follow-up of the FRIDAY audit, item 9).
//
// 1. relayAutodeployAlerts: autodeploy.sh appends one JSON line per failure to
//    ~/.agentic-os/autodeploy.alerts ({ts, from:"autodeploy", summary}). The 5-minute liveness job
//    reads NEW lines (byte offset kept in FRIDAY_DATA_DIR), de-dupes and rate-limits them, and sends
//    them to the owner through the same OS channel as every other FRIDAY notification (notifyOwner →
//    agent_notify_owner). notifyOwner queues locally when the OS is unreachable, so an alert that
//    could not be delivered is retried and never lost; the offset therefore always advances.
// 2. localOwnerAlert: a path that does NOT need the OS session, for the case where the OS session
//    itself is the thing that broke: an append-only log (owner-alerts.log), a desktop notification
//    (notify-send, when a session bus exists) and an optional webhook (FRIDAY_ALERT_WEBHOOK_URL,
//    e.g. an ntfy.sh topic or a Slack incoming webhook) — the webhook is what actually reaches a phone.
//    Off by default: nothing leaves the machine unless that env var is set.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { FRIDAY_DATA_DIR, logEvent } from "@/lib/persistence/store";

const alertsFile = () => process.env.AUTODEPLOY_ALERTS_FILE?.trim() || path.join(os.homedir(), ".agentic-os", "autodeploy.alerts");
const stateFile = () => path.join(FRIDAY_DATA_DIR, "autodeploy-alerts-state.json");

export interface AutodeployAlert { ts: string; from: string; summary: string }
interface RelayState { offset: number; sent: Record<string, number>; hourStart: number; hourCount: number }

export const MAX_ALERTS_PER_RUN = 3;
export const MAX_ALERTS_PER_HOUR = 6;
export const DEDUPE_WINDOW_MS = 6 * 3_600_000;

async function readState(): Promise<RelayState> {
  try {
    const j = JSON.parse(await fs.readFile(stateFile(), "utf8")) as Partial<RelayState>;
    return { offset: Number(j.offset) || 0, sent: j.sent ?? {}, hourStart: Number(j.hourStart) || 0, hourCount: Number(j.hourCount) || 0 };
  } catch { return { offset: 0, sent: {}, hourStart: 0, hourCount: 0 }; }
}
async function writeState(s: RelayState): Promise<void> {
  const tmp = `${stateFile()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, stateFile());
}

/** Pure: parse complete JSON lines from `text`; returns alerts + how many bytes were consumed. */
export function parseAlertLines(text: string): { alerts: AutodeployAlert[]; consumed: number } {
  const alerts: AutodeployAlert[] = [];
  let consumed = 0;
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) break; // a partial last line is left for the next run
    const line = text.slice(start, nl).trim();
    consumed = Buffer.byteLength(text.slice(0, nl + 1));
    start = nl + 1;
    if (!line) continue;
    try {
      const j = JSON.parse(line) as Partial<AutodeployAlert>;
      if (typeof j.summary === "string" && j.summary.trim()) {
        alerts.push({ ts: String(j.ts ?? ""), from: String(j.from ?? "autodeploy"), summary: j.summary.trim().slice(0, 1500) });
      }
    } catch { /* a malformed line is skipped, never retried forever */ }
  }
  return { alerts, consumed };
}

export const alertKey = (summary: string) => createHash("sha256").update(summary.replace(/\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "").trim()).digest("hex").slice(0, 16);

type Notify = (i: { kind: string; priority: "critical"; text: string; dedupeKey: string }) => Promise<unknown>;

/** Send new autodeploy alert lines to the owner. Never throws. Returns a short status for the scheduler log. */
export async function relayAutodeployAlerts(opts: { now?: number; notify?: Notify } = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  try {
    const file = alertsFile();
    let st: fs.FileHandle | null = null;
    let size = 0;
    try { st = await fs.open(file, "r"); size = (await st.stat()).size; } catch { return "no autodeploy alerts"; }
    const state = await readState();
    try {
      if (size < state.offset) state.offset = 0; // truncated or rotated: start over
      if (size === state.offset) return "no new autodeploy alerts";
      const buf = Buffer.alloc(Math.min(size - state.offset, 256 * 1024));
      await st.read(buf, 0, buf.length, state.offset);
      const { alerts, consumed } = parseAlertLines(buf.toString("utf8"));
      for (const k of Object.keys(state.sent)) if (now - state.sent[k] > DEDUPE_WINDOW_MS) delete state.sent[k];
      if (now - state.hourStart > 3_600_000) { state.hourStart = now; state.hourCount = 0; }

      const notify: Notify = opts.notify ?? (async (i) => (await import("@/lib/friday/notify")).notifyOwner(i));
      let sent = 0, deduped = 0, suppressed = 0;
      const fresh: AutodeployAlert[] = [];
      for (const a of alerts) {
        const k = alertKey(a.summary);
        if (state.sent[k] && now - state.sent[k] <= DEDUPE_WINDOW_MS) { deduped++; continue; }
        state.sent[k] = now; // a repeat inside the same batch also collapses
        fresh.push(a);
      }
      for (const a of fresh) {
        if (sent >= MAX_ALERTS_PER_RUN || state.hourCount >= MAX_ALERTS_PER_HOUR) { suppressed++; continue; }
        await notify({ kind: "autodeploy.alert", priority: "critical", text: `Autodeploy: ${a.summary}`, dedupeKey: `autodeploy.alert:${alertKey(a.summary)}` });
        sent++; state.hourCount++;
      }
      if (suppressed > 0) {
        // Never silently drop: one summary line says how many more there were.
        await notify({ kind: "autodeploy.alert", priority: "critical", text: `Autodeploy: ${suppressed} more failure alert(s) were held back by the rate limit. See ~/.agentic-os/autodeploy.alerts.`, dedupeKey: `autodeploy.alert.overflow:${Math.floor(now / 3_600_000)}` }).catch(() => {});
      }
      state.offset += consumed;
      await writeState(state);
      if (sent || deduped || suppressed) await logEvent("autodeploy.alerts_relayed", { sent, deduped, suppressed }).catch(() => {});
      return `autodeploy alerts: ${sent} sent, ${deduped} duplicate, ${suppressed} held back`;
    } finally { await st.close().catch(() => {}); }
  } catch (e) {
    return `autodeploy alert relay failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`;
  }
}

// ── Channel that does not need the OS session ──────────────────────────────────────────────
export interface LocalAlertDeps { fetch?: typeof fetch; desktop?: (title: string, body: string) => void }

export async function localOwnerAlert(title: string, body: string, deps: LocalAlertDeps = {}): Promise<{ logged: boolean; webhook: boolean }> {
  let logged = false, webhook = false;
  try {
    await fs.appendFile(path.join(FRIDAY_DATA_DIR, "owner-alerts.log"), `${new Date().toISOString()} ${title}: ${body.replace(/\s+/g, " ").slice(0, 600)}\n`, { encoding: "utf8", mode: 0o600 });
    logged = true;
  } catch { /* best-effort */ }
  try {
    (deps.desktop ?? ((t, b) => {
      if (!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
      const c = spawn("notify-send", ["--urgency=critical", t, b], { stdio: "ignore", detached: true });
      c.on("error", () => {}); c.unref();
    }))(title, body.slice(0, 300));
  } catch { /* no desktop session */ }
  const hook = process.env.FRIDAY_ALERT_WEBHOOK_URL?.trim();
  if (hook) {
    try {
      const f = deps.fetch ?? fetch;
      const r = await f(hook, { method: "POST", headers: { "content-type": "text/plain", Title: title.slice(0, 120) }, body: body.slice(0, 1500), signal: AbortSignal.timeout(8000) });
      webhook = r.ok;
    } catch { /* best-effort */ }
  }
  return { logged, webhook };
}
