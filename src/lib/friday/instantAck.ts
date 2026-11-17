// FRIDAY — instant receipt for held client mail. BUILT DORMANT (owner decision 2026-07-19: keep the
// silence texture; FRIDAY_INSTANT_ACK=on flips it live with no rebuild).
//
// Under the 12h reply SLA a client's email sits unanswered for hours by design. When enabled, this
// sends ONE neutral deterministic line per conversation — "got your note; it's in front of us" —
// making no claims about content or who will answer (so it can never contradict the eventual reply's
// dedup verdict or the owner answering themselves). The full reply still respects the hold; supersede /
// owner-answered / one-reply-per-conversation logic is untouched.
//
// Ordering matters for cost: the thread ledger is consulted BEFORE any Gmail fetch, so the 15-min
// triage tick doesn't re-download every still-held message. Loop-proofing is structural: auto/agent
// mail never acks, review threads are excluded upstream, trivial gratitude never acks, escalated
// clients never ack, sends ride gateOutbound (caps + breaker) and auto-CC the owner.

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store, logEvent } from "@/lib/persistence/store";

export function instantAckEnabled(): boolean {
  return (process.env.FRIDAY_INSTANT_ACK ?? "off").trim().toLowerCase() === "on";
}

export const ACK_THREAD_COOLDOWN_MS = 48 * 3_600_000;
export const ACK_DAILY_CAP = 10;

// "thanks!" / "ok great" needs no receipt — acking gratitude reads as a bot tic.
const TRIVIAL_RE = /^(thanks|thank you|thx|ty|ok(ay)?|got it|great|perfect|sounds good|awesome|will do|no problem|np)\b[\s\S]{0,40}$/i;

export function isTrivialBody(text: string): boolean {
  const t = (text ?? "").trim();
  return t.length < 40 || TRIVIAL_RE.test(t);
}

interface AckLedger {
  threads: Record<string, number>; // thread key → last-ack epoch ms
  day: string;                     // YYYY-MM-DD the counter belongs to
  count: number;                   // acks sent that day (global)
}

const LEDGER_FILE = path.join(FRIDAY_DATA_DIR, "ack-ledger.json");

async function loadLedger(): Promise<AckLedger> {
  try {
    const j = JSON.parse(await fs.readFile(LEDGER_FILE, "utf8")) as AckLedger;
    return { threads: j.threads ?? {}, day: j.day ?? "", count: j.count ?? 0 };
  } catch {
    return { threads: {}, day: "", count: 0 };
  }
}

async function saveLedger(l: AckLedger): Promise<void> {
  const cutoff = Date.now() - 7 * 86_400_000;
  for (const [k, ts] of Object.entries(l.threads)) if (ts < cutoff) delete l.threads[k];
  try { await fs.writeFile(LEDGER_FILE, JSON.stringify(l)); } catch { /* best-effort */ }
}

/** Pure decision core (eval-locked): should THIS held message get a receipt right now? */
export function ackDecision(input: {
  enabled: boolean;
  auto: boolean;
  escalated: boolean;
  body: string;
  threadKey: string;
  ledger: { threads: Record<string, number>; day: string; count: number };
  now: number;
}): "send" | "disabled" | "auto_mail" | "escalated" | "trivial" | "thread_cooldown" | "daily_cap" {
  if (!input.enabled) return "disabled";
  if (input.auto) return "auto_mail";
  if (input.escalated) return "escalated";
  if (isTrivialBody(input.body)) return "trivial";
  const last = input.ledger.threads[input.threadKey];
  if (last && input.now - last < ACK_THREAD_COOLDOWN_MS) return "thread_cooldown";
  const today = new Date(input.now).toISOString().slice(0, 10);
  if (input.ledger.day === today && input.ledger.count >= ACK_DAILY_CAP) return "daily_cap";
  return "send";
}

/**
 * Fired from processInbox's hold branch. `threadId` is the ledger key — check it before fetching
 * anything. Never throws.
 */
export async function maybeSendInstantAck(input: {
  account: "owner" | "friday";
  msgId: string;
  threadId: string;
}): Promise<boolean> {
  try {
    if (!instantAckEnabled()) return false;
    const ledger = await loadLedger();
    const now = Date.now();
    const threadKey = (input.threadId || input.msgId).trim();
    // Cheap pre-checks (no Gmail fetch): thread cooldown + daily cap.
    const pre = ackDecision({ enabled: true, auto: false, escalated: false, body: "long enough to pass the trivial screen", threadKey, ledger, now });
    if (pre !== "send") return false;

    const { getMessageBody } = await import("@/lib/friday/google/gmail");
    const body = await getMessageBody(input.msgId, input.account);
    if (!body.from) return false;
    const addr = (body.from.match(/<([^>]+)>/)?.[1] ?? body.from).trim().toLowerCase();
    const { ownerEmail, fridayEmail } = await import("@/lib/friday/emailAgent");
    const self = [await ownerEmail(), await fridayEmail()].filter(Boolean).map((a) => (a as string).toLowerCase());
    if (body.agent.trim() || self.includes(addr)) return false; // sibling-agent or self mail
    const client = (await store.clients.find((c) => (c.email ?? "").toLowerCase() === addr))[0];
    if (!client) return false;
    // Owner rule (2026-07-26): only ever send client-facing text — even this one-line receipt — for
    // mail read from FRIDAY's own inbox. Shared-inbox mail gets no ack; the owner is already there.
    if (input.account !== "friday") return false;
    const { activeEscalation } = await import("@/lib/friday/escalations");
    if (await activeEscalation(client.id, body.threadId)) return false;

    const verdict = ackDecision({ enabled: true, auto: body.auto, escalated: false, body: body.text, threadKey, ledger, now });
    if (verdict !== "send") {
      await logEvent("email.ack_skipped", { reason: verdict, client: client.name }).catch(() => {});
      return false;
    }

    // Rate safety: the same outbound gate every proactive client email rides (caps + breaker).
    const { gateOutbound, recordSent, recordBlocked, threadKeyFor } = await import("@/lib/friday/outbound");
    const om = { channel: "email" as const, to: addr, threadKey: threadKeyFor("email", addr, body.threadId), clientId: client.id, kind: "ack" };
    const gate = await gateOutbound(om, { deferrable: false, client });
    if (gate.action !== "send") {
      await recordBlocked(om, gate.reason ?? "capped");
      return false;
    }

    const first = client.name.trim().split(/\s+/)[0] || "there";
    const text = `Hi ${first} — got your note; it's in front of us. You'll hear back from us today.`;
    const subject = /^re:/i.test(body.subject) ? body.subject : `Re: ${body.subject || "(no subject)"}`;
    const references = [body.references, body.messageId].filter(Boolean).join(" ").trim() || undefined;
    const { sendClientEmail } = await import("@/lib/friday/emailAgent");
    const res = await sendClientEmail({
      to: addr, subject, body: text,
      inReplyTo: body.messageId || undefined, references,
      replyToThreadId: input.account === "friday" ? body.threadId : undefined,
    });
    if (res.ok) {
      await recordSent(om);
      const today = new Date(now).toISOString().slice(0, 10);
      ledger.threads[threadKey] = now;
      ledger.count = ledger.day === today ? ledger.count + 1 : 1;
      ledger.day = today;
      await saveLedger(ledger);
      await logEvent("email.ack_sent", { client: client.name, subject: body.subject.slice(0, 120) }).catch(() => {});
      return true;
    }
    return false;
  } catch (e) {
    await logEvent("email.ack_error", { error: String(e).slice(0, 160) }, { level: "warn" }).catch(() => {});
    return false;
  }
}
