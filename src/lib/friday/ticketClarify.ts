// FRIDAY — portal ticket/CR clarify reply loop (2026-09-18, "respond inside the projects module").
//
// osTickets.ts's ticketTriage/changeRequestTriage post a clarifying question (client-visible portal
// comment + a mirrored email, via postClarifyAskAndRecord) when a ticket/CR is too ambiguous to
// route. This module is what happens NEXT: polling both reply channels for the client's answer,
// re-classifying, and either resolving/asking-again/force-resolving, or — when the direct-post gate
// is closed — stashing the decision for the next ticketTriage/changeRequestTriage DueRun to turn
// into a normal approval (a bare scheduler job can't create an OS approval itself).
//
// Structurally a sibling of clientReview.ts: same "poll one thread, strip quotes, classify
// conservatively" shape for email, plus a portal-comment counterpart osTickets.ts already has the
// tools for. reviewSilenceSweep's day-N-nudge/day-N-close pattern is mirrored for the 24h SMS nudge
// and the owner escalation.
//
// Kill switch: FRIDAY_PORTAL_CLARIFY=off.

import { store, logEvent, nowISO } from "@/lib/persistence/store";
import { getThreadDetail } from "@/lib/friday/google/gmail";
import { stripQuoted } from "@/lib/friday/clientReview";
import {
  classifyItemClarity, clarifyRoundOutcome, firstClarifyReply, applyClarifyPendingAction,
  portalDirectPost, unwrap, type ClarifyCandidateReply,
} from "@/lib/friday/osTickets";
import type { Client, ClarifyPendingAction, TicketClarify } from "@/lib/friday/types";

export function clarifyEnabled(): boolean {
  return (process.env.FRIDAY_PORTAL_CLARIFY ?? "on").trim().toLowerCase() !== "off";
}

const CLARIFY_NUDGE_AFTER_MS = 24 * 3600_000;    // owner-specified: a portal reminder after 24h of silence (no text any more)
const CLARIFY_ESCALATE_AFTER_MS = 72 * 3600_000; // further silence (48h past the nudge) → page the owner

function addrOf(header: string): string {
  return (header.match(/<([^>]+)>/)?.[1] ?? header).trim().toLowerCase();
}

/** Formerly mirrored the clarifying question to the client by email from FRIDAY's own mailbox. FRIDAY sends
 *  no client mail any more (Clara owns client email), and the question is already a client-visible portal
 *  comment which the OS notifies the client about. Kept as an inert shim so callers/stored records keep
 *  working: it reports "not sent", which the clarify flow already treats as non-fatal. */
export async function sendClarifyEmail(_opts: {
  to: string; clientName?: string; subject: string; question: string;
  replyToThreadId?: string; account?: "owner" | "friday";
}): Promise<{ ok: boolean; threadId?: string; account?: "owner" | "friday" }> {
  return { ok: false };
}

/** A NEW client-authored portal comment posted after the question was asked. */
async function checkPortalReply(rec: TicketClarify): Promise<ClarifyCandidateReply | null> {
  const { osClient } = await import("@/lib/friday/osClient");
  const tool = rec.kind === "ticket" ? "project_support_ticket_comments_list" : "project_change_request_comments_list";
  const idKey = rec.kind === "ticket" ? "ticket_id" : "change_request_id";
  const raw = await osClient.callTool(tool, { [idKey]: rec.osId }).catch(() => null);
  const thread = (unwrap(raw) as Array<{ author_type?: string; author_name?: string; is_internal?: boolean; body?: string; created_at?: string }> | null) ?? [];
  const askedAtMs = Date.parse(rec.askedAt) || 0;
  const candidates = thread
    // author_type should always be "client" for a genuine reply, but it's an optional field on the
    // OS row — a client-visible comment that isn't internal, isn't system-authored, and isn't
    // FRIDAY's own (by name) is treated as a client reply even if author_type is somehow missing
    // (code-review fix: the strict-equality check alone silently dropped such a reply forever).
    .filter((c) => c.is_internal === false && c.author_type !== "system" && !/friday/i.test(c.author_name ?? ""))
    .map((c) => ({ text: (c.body ?? "").trim(), atMs: Date.parse(c.created_at ?? "") || 0 }))
    .filter((c) => c.text && c.atMs > askedAtMs)
    .sort((a, b) => a.atMs - b.atMs);
  const first = candidates[0];
  return first ? { channel: "portal", text: first.text, atMs: first.atMs } : null;
}

/** A NEW client email reply in the mirrored thread, after the last-seen floor. Same candidate
 *  filter as clientReview's pollClientReviewReplies: FRIDAY's own stamped mail and auto-replies are
 *  never classified, and only the client's own address counts (never a CC'd owner). */
async function checkEmailReply(rec: TicketClarify): Promise<ClarifyCandidateReply | null> {
  if (!rec.emailThreadId || !rec.clientEmail) return null;
  const msgs = await getThreadDetail(rec.emailThreadId, rec.emailAccount ?? "owner").catch(() => []);
  if (!msgs.length) return null;
  const floorMs = rec.emailSeenMs ?? 0;
  const clientAddr = rec.clientEmail.toLowerCase();
  const candidates = msgs
    .filter((m) => Number.isFinite(m.internalDate) && m.internalDate > floorMs)
    .filter((m) => !m.agent.trim())
    .filter((m) => !m.auto)
    .filter((m) => addrOf(m.from) === clientAddr)
    .sort((a, b) => a.internalDate - b.internalDate);
  const first = candidates[0];
  if (!first) return null;
  const text = stripQuoted(first.text).trim();
  return text ? { channel: "email", text, atMs: first.internalDate } : null;
}

async function resolveLocalClient(rec: TicketClarify): Promise<Client | null> {
  if (rec.localProjectId) {
    const project = await store.projects.get(rec.localProjectId);
    if (project) {
      const client = await store.clients.get(project.clientId);
      if (client) return client;
    }
  }
  if (rec.clientEmail) {
    const hits = await store.clients.find((c: Client) => (c.email ?? "").toLowerCase() === rec.clientEmail!.toLowerCase());
    if (hits[0]) return hits[0];
  }
  return null;
}

/** ONE poll cycle over every `awaiting_reply` clarify record (tickets and CRs together). Whichever
 *  channel answers first (see firstClarifyReply) is classified together with the original text and
 *  every prior round's Q&A; the outcome is bounded to 2 rounds (clarifyRoundOutcome), then applied
 *  directly if portalDirectPost allows it, or stashed as a pendingAction for the next
 *  ticketTriage/changeRequestTriage sweep to turn into an approval. */
export async function pollClarifyReplies(): Promise<string> {
  if (!clarifyEnabled()) return "off";
  const { osEnabled, osClient } = await import("@/lib/friday/osClient");
  if (!osEnabled()) return "OS bridge disabled";

  const recs = await store.ticketClarifications.find((r: TicketClarify) => r.status === "awaiting_reply" && !r.needsApprovalFallback);
  let checked = 0;
  let resolved = 0;
  let askedAgain = 0;
  let forced = 0;
  let fallbackQueued = 0;

  for (const rec of recs) {
    checked++;
    try {
      // Concurrent — the two channel checks are independent network/tool calls (code-review perf fix).
      const [portalCandidate, emailCandidate] = await Promise.all([checkPortalReply(rec), checkEmailReply(rec)]);
      const winner = firstClarifyReply(portalCandidate, emailCandidate);
      if (!winner) continue; // still waiting on both channels

      const qa = [...rec.qa, { question: rec.question, answer: winner.text }];
      // Full round history, not just the current pair (code-review fix) — a round-2 answer can
      // need round-1's Q&A for context to judge sufficiency.
      const clarity = await classifyItemClarity({ title: rec.subject, description: rec.description }, qa);
      if (!clarity.determinable) continue; // retry next poll, never guess

      const outcome = clarifyRoundOutcome(rec.round, clarity.needsClarify);
      const patch: Partial<TicketClarify> = { qa, updatedAt: nowISO() };
      // Advance the floor to whichever email message was SEEN this poll, win or lose (code-review
      // fix) — otherwise a losing/late email reply from an earlier round sits unconsumed and gets
      // replayed as the "answer" to a LATER round's different question on a future poll.
      if (emailCandidate) patch.emailSeenMs = emailCandidate.atMs;
      await store.ticketClarifications.update(rec.id, patch);
      const freshRec: TicketClarify = { ...rec, ...patch };

      const action: ClarifyPendingAction =
        outcome === "ask_again" ? { type: "ask_again", question: clarity.clarifyQuestion as string }
        : outcome === "force_resolve" ? { type: "force_resolve" }
        : { type: "resolve" };

      const effectiveDescription = [freshRec.description, ...freshRec.qa.map((x) => `Q: ${x.question}\nA: ${x.answer}`)].join("\n\n");
      const gate = await portalDirectPost(true, `${freshRec.subject}\n${effectiveDescription}`);
      if (gate.ok) {
        await applyClarifyPendingAction(osClient, freshRec, action);
        if (outcome === "resolved") resolved++;
        else if (outcome === "ask_again") askedAgain++;
        else forced++;
      } else {
        await store.ticketClarifications.update(rec.id, { needsApprovalFallback: true, pendingAction: action, updatedAt: nowISO() });
        fallbackQueued++;
      }
    } catch (e) {
      await logEvent("ticketclarify.poll_error", { clarifyId: rec.id, error: String(e).slice(0, 200) }, { level: "warn" });
    }
  }
  return `${checked} clarify record(s) checked, ${resolved} resolved, ${askedAgain} asked again, ${forced} force-resolved, ${fallbackQueued} queued for approval`;
}

/** 24h-silence SMS nudge, then a further-silence owner page — reviewSilenceSweep's elapsed-time-only
 *  philosophy, not its numbers (a ticket/CR clarify is more time-sensitive than a review sign-off). */
export function clarifySilenceAction(
  askedAtMs: number, nowMs: number, nudgedAt: number | null, escalatedAt: number | null,
): "none" | "nudge" | "escalate" {
  const age = nowMs - askedAtMs;
  if (age >= CLARIFY_ESCALATE_AFTER_MS && !escalatedAt) return "escalate";
  if (age >= CLARIFY_NUDGE_AFTER_MS && !nudgedAt) return "nudge";
  return "none";
}

export async function clarifySilenceSweep(): Promise<string> {
  if (!clarifyEnabled()) return "off";
  const recs = await store.ticketClarifications.find((r: TicketClarify) => r.status === "awaiting_reply" && !r.needsApprovalFallback);
  let nudged = 0;
  let noPhone = 0;
  let escalated = 0;
  for (const rec of recs) {
    try {
      const askedAtMs = Date.parse(rec.askedAt) || 0;
      if (!askedAtMs) continue;
      const action = clarifySilenceAction(
        askedAtMs, Date.now(),
        rec.nudgedAt ? Date.parse(rec.nudgedAt) || 0 : null,
        rec.escalatedAt ? Date.parse(rec.escalatedAt) || 0 : null,
      );
      if (action === "none") continue;

      if (action === "nudge") {
        // A gentle reminder on the portal thread (client-visible; the OS notifies the client). No text.
        const { osClient } = await import("@/lib/friday/osClient");
        const first = (rec.clientName ?? "").split(" ")[0] || "there";
        const body = `Hi ${first} — just floating this back up on "${rec.subject}": ${rec.question} You can reply right here in the portal.`;
        const posted = rec.kind === "ticket"
          ? await osClient.callTool("project_ticket_comment_create", { ticket_id: rec.osId, body, is_internal: false, author_name: "FRIDAY" }).then(() => true).catch(() => false)
          : await osClient.callTool("project_change_request_comments_create", { change_request_id: rec.osId, body, is_internal: false, client_visible: true, author_name: "FRIDAY" }).then(() => true).catch(() => false);
        if (!posted) noPhone++;
        await store.ticketClarifications.update(rec.id, { nudgedAt: nowISO(), updatedAt: nowISO() });
        nudged++;
      } else {
        const { notifyOwner } = await import("@/lib/friday/notify");
        await notifyOwner({
          kind: rec.kind === "ticket" ? "ticket.clarify.stale" : "cr.clarify.stale",
          priority: "critical",
          text: `⏳ No answer on the clarifying question for "${rec.subject}" (${rec.clientName ?? "client"}) after 3 days — might be worth a direct follow-up.`,
          dedupeKey: `clarify-stale:${rec.id}`,
        }).catch(() => {});
        await store.ticketClarifications.update(rec.id, { escalatedAt: nowISO(), updatedAt: nowISO() });
        escalated++;
      }
    } catch (e) {
      await logEvent("ticketclarify.sweep_error", { clarifyId: rec.id, error: String(e).slice(0, 200) }, { level: "warn" });
    }
  }
  return `${nudged} nudged${noPhone ? ` (${noPhone} reminders could not be posted)` : ""}, ${escalated} escalated`;
}
