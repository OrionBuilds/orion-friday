// FRIDAY — post-delivery feedback loop (owner ask 2026-07-19: nobody ever asks the client how we did).
//
// The ASK is one sentence appended to the review-accept confirmation ("on a 1-5, how'd we do?"),
// hard-capped to once per client per FRIDAY_FEEDBACK_MIN_DAYS (default 45) and skipped while any
// escalation is open — clients are never surveyed, they're occasionally asked. The CAPTURE is a
// deterministic parse (digit 1-5, or a narrow word map on short replies) run by a scheduler poller
// over the pending threads; no LLM classification of sentiment, ever. A ≤3 pages the owner immediately;
// a ≥4 batches into the digest. Score + words land on the client record for future context.
//
// Kill switch FRIDAY_FEEDBACK_ASK=off (stops new asks; the poller still drains pending ones).

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store, logEvent } from "@/lib/persistence/store";
import type { Client } from "@/lib/friday/types";

export function feedbackAskEnabled(): boolean {
  return (process.env.FRIDAY_FEEDBACK_ASK ?? "on").trim().toLowerCase() !== "off";
}

export function feedbackMinDays(): number {
  const n = Number(process.env.FRIDAY_FEEDBACK_MIN_DAYS ?? 45);
  return Number.isFinite(n) && n >= 1 ? n : 45;
}

export const FEEDBACK_ASK_LINE = "Quick favor before I close this out — on a 1-5, how'd we do on this one? Just the number is perfect (and any words you want to add).";
const PENDING_TTL_MS = 14 * 86_400_000;

// ── Deterministic parse (eval-locked) ───────────────────────────────────────
const DIGIT_RE = /^\s*([1-5])\s*(?:\/\s*5)?\b/;
const WORD_MAP: Array<[RegExp, number]> = [
  [/\b(amazing|fantastic|awesome|excellent|love(d)? it|great)\b/i, 5],
  [/\b(good|solid|happy|nice work)\b/i, 4],
  [/\b(okay|ok|fine|decent)\b/i, 3],
  [/\b(disappointed|poor|unhappy|not (great|good)|bad)\b/i, 2],
];

/** Parse a client's feedback reply. Digit wins; the word map only fires on SHORT replies (a long
 *  email containing "great" somewhere is conversation, not a rating). Null = not feedback. */
export function parseFeedbackScore(text: string): { score: number; via: "digit" | "word" } | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const d = t.match(DIGIT_RE);
  if (d) return { score: Number(d[1]), via: "digit" };
  if (t.length <= 120) {
    for (const [re, score] of WORD_MAP) if (re.test(t)) return { score, via: "word" };
  }
  return null;
}

/** Cadence guard: may we ask THIS client now? */
export function askEligible(client: Pick<Client, "lastFeedbackAskAt">, now = Date.now()): boolean {
  if (!client.lastFeedbackAskAt) return true;
  const last = Date.parse(client.lastFeedbackAskAt);
  return !Number.isFinite(last) || now - last >= feedbackMinDays() * 86_400_000;
}

// ── Pending-ask ledger ──────────────────────────────────────────────────────
interface PendingAsk { threadId: string; account: "owner" | "friday"; clientId: string; requestId: string; subject: string; askedAt: number }
const PENDING_FILE = path.join(FRIDAY_DATA_DIR, "feedback-pending.json");

async function loadPending(): Promise<PendingAsk[]> {
  try {
    const rows = JSON.parse(await fs.readFile(PENDING_FILE, "utf8")) as PendingAsk[];
    return rows.filter((r) => Date.now() - r.askedAt < PENDING_TTL_MS);
  } catch {
    return [];
  }
}
async function savePending(rows: PendingAsk[]): Promise<void> {
  try { await fs.writeFile(PENDING_FILE, JSON.stringify(rows)); } catch { /* best-effort */ }
}

export async function recordFeedbackAsk(input: Omit<PendingAsk, "askedAt">): Promise<void> {
  const rows = await loadPending();
  if (!rows.some((r) => r.threadId === input.threadId)) rows.push({ ...input, askedAt: Date.now() });
  await savePending(rows);
  await store.clients.update(input.clientId, { lastFeedbackAskAt: new Date().toISOString() }).catch(() => {});
  await logEvent("feedback.asked", { clientId: input.clientId, requestId: input.requestId });
}

/** Thread ids with a live feedback ask — processInbox must not double-handle these. */
export async function pendingFeedbackThreads(): Promise<Set<string>> {
  return new Set((await loadPending()).map((r) => r.threadId));
}

// Local quoted-text strip (same shape as the review poller's): keep only the fresh lines.
function stripQuoted(raw: string): string {
  const out: string[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    if (/^On .{0,200}wrote:\s*$/.test(line.trim())) break;
    if (line.trim() === "--") break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * Scheduler job body: read each pending thread, parse the client's newest fresh reply, record +
 * thank + route. Returns a one-line summary for the scheduler log.
 */
export async function pollFeedbackReplies(): Promise<string> {
  const pending = await loadPending();
  if (!pending.length) return "0 pending";
  const keep: PendingAsk[] = [];
  let captured = 0;
  for (const p of pending) {
    try {
      const client = await store.clients.get(p.clientId);
      const addr = client?.email?.toLowerCase();
      if (!client || !addr) continue; // drop — unanswerable
      const { getThreadDetail } = await import("@/lib/friday/google/gmail");
      const msgs = await getThreadDetail(p.threadId, p.account).catch(() => []);
      const reply = [...msgs].reverse().find((m) => {
        const from = (m.from.match(/<([^>]+)>/)?.[1] ?? m.from).trim().toLowerCase();
        return from === addr && !m.auto && Number(m.internalDate) > p.askedAt;
      });
      if (!reply) { keep.push(p); continue; } // still waiting (TTL prunes eventually)
      const parsed = parseFeedbackScore(stripQuoted(reply.text));
      if (!parsed) { keep.push(p); continue; } // a non-rating reply → the normal pipeline owns it
      captured++;
      await store.clients.update(client.id, {
        lastFeedbackScore: parsed.score,
        lastFeedbackNote: stripQuoted(reply.text).slice(0, 240),
      }).catch(() => {});
      await logEvent("feedback.received", { clientId: client.id, score: parsed.score, via: parsed.via, requestId: p.requestId });
      const { notifyOwner } = await import("@/lib/friday/notify");
      await notifyOwner({
        kind: "feedback",
        priority: parsed.score <= 3 ? "normal" : "low",
        text: parsed.score <= 3
          ? `⚠️ Feedback from ${client.name}: ${parsed.score}/5 — "${stripQuoted(reply.text).slice(0, 160)}"`
          : `⭐ ${client.name} rated the last delivery ${parsed.score}/5.`,
        dedupeKey: `feedback:${p.requestId}`,
      }).catch(() => {});
      // Warm deterministic thank-you, through the outbound gate like every proactive send.
      const { gateOutbound, recordSent, recordBlocked, threadKeyFor } = await import("@/lib/friday/outbound");
      const om = { channel: "email" as const, to: addr, threadKey: threadKeyFor("email", addr, p.threadId), clientId: client.id, kind: "feedback" };
      const gate = await gateOutbound(om, { deferrable: false, client });
      if (gate.action === "send") {
        const { sendClientEmail } = await import("@/lib/friday/emailAgent");
        const first = client.name.trim().split(/\s+/)[0] || "there";
        const thanks = parsed.score <= 3
          ? `Thank you for the honesty, ${first} — that's genuinely useful. I've flagged it internally and we'll do better on the next one.`
          : `Thank you, ${first} — really appreciate it!`;
        const res = await sendClientEmail({
          to: addr,
          subject: `Re: ${(p.subject || "your feedback").replace(/^Re:\s*/i, "")}`,
          body: thanks,
          replyToThreadId: p.account === "friday" ? p.threadId : undefined,
          inReplyTo: reply.messageId || undefined,
          references: [reply.references, reply.messageId].filter(Boolean).join(" ") || undefined,
        });
        if (res.ok) await recordSent(om);
      } else {
        await recordBlocked(om, gate.reason ?? "capped");
      }
    } catch (e) {
      keep.push(p);
      await logEvent("feedback.poll_error", { threadId: p.threadId, error: String(e).slice(0, 160) }, { level: "warn" });
    }
  }
  await savePending(keep);
  return `${captured} captured, ${keep.length} pending`;
}
