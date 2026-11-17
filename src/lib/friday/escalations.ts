// Human-handoff escalations (Artifact A). When a client asks for a person / for the owner, FRIDAY raises an
// escalation, pages the owner, and STOPS replying autonomously on that channel until the owner resolves
// it. Light module (store + types only) so both client channels can consult it without heavy deps.

import { store, newId, nowISO, logEvent } from "@/lib/persistence/store";
import type { Escalation, Channel } from "@/lib/friday/types";

/** Is there an open handoff for this client (optionally scoped to an email thread)? */
export async function activeEscalation(clientId: string, threadId?: string): Promise<Escalation | null> {
  const open = await store.escalations.find((e) => e.status === "open" && e.clientId === clientId);
  if (!open.length) return null;
  // A thread-scoped escalation suppresses only its own thread; a channel-wide one (no threadId) suppresses all.
  const hit = open.find((e) => !e.threadId || (threadId && e.threadId === threadId)) ?? open[0];
  return hit ?? null;
}

/** Raise a handoff (idempotent per client+thread) and page the owner. Returns the escalation. */
export async function openEscalation(input: { clientId: string; clientName: string; channel: Channel; threadId?: string; reason?: string }): Promise<Escalation> {
  const existing = (await store.escalations.find(
    (e) => e.status === "open" && e.clientId === input.clientId && (e.threadId ?? "") === (input.threadId ?? ""),
  ))[0];
  if (existing) return existing;
  const esc: Escalation = {
    id: newId(), clientId: input.clientId, channel: input.channel, threadId: input.threadId,
    reason: input.reason, status: "open", createdAt: nowISO(),
  };
  await store.escalations.insert(esc);
  await logEvent("escalation.opened", { client: input.clientName, channel: input.channel, reason: input.reason }, { level: "warn" });
  // Escalation intelligence (Wave-3 #10): the page's EMAIL body carries the full briefing — trigger,
  // account picture, what FRIDAY touched in 48h, how to hand back — so the owner arrives warm.
  // Store-reads only (no LLM); a build failure degrades to the plain page, never delays it.
  let briefing = "";
  try {
    const client = await store.clients.get(input.clientId);
    if (client) {
      const { buildEscalationBriefing } = await import("@/lib/friday/escalationBrief");
      briefing = await buildEscalationBriefing(esc, client);
    }
  } catch { /* plain page below */ }
  const { notifyOwner } = await import("@/lib/friday/notify");
  await notifyOwner({
    kind: "handoff", priority: "critical", // timely: immediate email, never a text
    headline: `${input.clientName} asked for a human`,
    text: `${input.clientName} asked for a human${input.reason ? ` (${input.reason})` : ""}. I've paused my autonomous replies for them — it's yours. Briefing in your email. When you're done, tell CLARA to hand ${input.clientName.split(" ")[0]} back to me, or reply "resume ${input.clientName.split(" ")[0]}" to a text from me.`,
    ...(briefing ? { email: true, emailText: briefing, subject: `Handoff briefing: ${input.clientName}` } : {}),
    dedupeKey: `handoff:${esc.id}`,
  }).catch(() => {});
  return esc;
}

/** Hours before an open handoff counts as stale and a fresh client message re-pages the owner. */
const STALE_HANDOFF_HOURS = Number(process.env.FRIDAY_HANDOFF_STALE_HOURS ?? 4);
/** Don't re-page more than once per this window, however many messages arrive. */
const NUDGE_INTERVAL_MS = Number(process.env.FRIDAY_HANDOFF_NUDGE_MINUTES ?? 60) * 60_000;

/**
 * A client messaged while their handoff is still open, so FRIDAY is about to say nothing.
 *
 * Previously that was the whole story: `return ""`, no page, no log the owner would ever see,
 * no word to the client. Taylor messaged into a 26-hour-old handoff and got silence, because
 * the original page had been demoted to email (see KIND_CATEGORY_RULES in notify.ts) and
 * nothing ever revisits an open escalation.
 *
 * So: record the swallow, re-page the owner once the handoff is stale (rate-limited), and hand
 * back a one-time acknowledgement for the client. Deliberately never auto-resumes — a human
 * decides when to give the conversation back.
 */
export async function noteSuppressedClientMessage(input: {
  escalation: Escalation;
  clientName: string;
  channel: Channel;
  text: string;
}): Promise<{ clientAck: string | null }> {
  const { escalation: esc, clientName, channel, text } = input;
  const now = Date.now();
  const ageHours = (now - Date.parse(esc.createdAt)) / 3_600_000;
  const sinceNudge = esc.lastNudgeAt ? now - Date.parse(esc.lastNudgeAt) : Infinity;
  const count = (esc.suppressedCount ?? 0) + 1;

  const patch: Partial<Escalation> = { suppressedCount: count, lastSuppressedAt: nowISO() };

  const shouldNudge = ageHours >= STALE_HANDOFF_HOURS && sinceNudge >= NUDGE_INTERVAL_MS;
  if (shouldNudge) {
    patch.lastNudgeAt = nowISO();
    const { notifyOwner } = await import("@/lib/friday/notify");
    const firstName = clientName.split(" ")[0];
    await notifyOwner({
      kind: "escalation.stale",
      priority: "critical",
      text: `⏳ ${clientName} just messaged again on a handoff that's been open ${Math.floor(ageHours)}h — I'm still muted for them (${count} message${count === 1 ? "" : "s"} unanswered). Latest: "${text.slice(0, 120)}". Text "resume ${firstName}" to hand it back to me.`,
      // Per-escalation per-hour, so a burst of client messages is one page, not five.
      dedupeKey: `escalation.stale:${esc.id}:${new Date().toISOString().slice(0, 13)}`,
    }).catch(() => {});
    await logEvent("escalation.stale_nudge", { client: clientName, channel, ageHours: Math.floor(ageHours), suppressed: count }, { level: "warn" });
  }

  // Tell the client once that a human has it, so the silence isn't unexplained. Voice is
  // excluded: the caller is live and a canned line mid-call reads worse than the normal flow.
  let clientAck: string | null = null;
  if (!esc.clientAckedAt && channel !== "voice") {
    const { OWNER_FIRST } = await import("@/lib/friday/persona");
    clientAck = `Thanks ${clientName.split(" ")[0]} — I've looped in ${OWNER_FIRST} on this one and they're picking it up directly, so I'll hold off replying until they're caught up.`;
    patch.clientAckedAt = nowISO();
  }

  await store.escalations.update(esc.id, patch);
  return { clientAck };
}

/** Open handoffs older than `hours`, for the stale-handoff scheduler sweep. */
export async function staleEscalations(hours = STALE_HANDOFF_HOURS): Promise<Escalation[]> {
  const cutoff = Date.now() - hours * 3_600_000;
  const open = await store.escalations.find((e) => e.status === "open");
  return open.filter((e) => Date.parse(e.createdAt) <= cutoff);
}

/** Resolve all open handoffs for a client (owner has taken over / released it). */
export async function resolveEscalations(clientId: string): Promise<number> {
  const open = await store.escalations.find((e) => e.status === "open" && e.clientId === clientId);
  for (const e of open) await store.escalations.update(e.id, { status: "resolved", resolvedAt: nowISO() });
  if (open.length) await logEvent("escalation.resolved", { clientId, count: open.length });
  return open.length;
}

// Owner text command to hand a client back to FRIDAY: "resume <name>" / "resume all". Deliberately uses
// "resume" (not "release", which collides with the approval verbs). Returns a confirmation string when
// it handled the text, else null so the caller falls through to normal command parsing.
export async function tryResolveHandoffCommand(text: string): Promise<string | null> {
  const t = text.trim();
  const m = t.match(/^\s*(resume|unmute|reopen)\s+(.+)$/i);
  if (!m) return null;
  const who = m[2].trim();
  const open = await store.escalations.find((e) => e.status === "open");
  if (!open.length) return "No client is on manual handoff right now.";
  if (/^all$/i.test(who)) {
    for (const e of open) await store.escalations.update(e.id, { status: "resolved", resolvedAt: nowISO() });
    await logEvent("escalation.resolved", { count: open.length, via: "owner-resume-all" });
    return `Resumed autonomous replies for all ${open.length} client(s) on handoff.`;
  }
  const clients = await store.clients.all();
  const matchIds = new Set(clients.filter((c) => c.name.toLowerCase().includes(who.toLowerCase())).map((c) => c.id));
  const hits = open.filter((e) => matchIds.has(e.clientId));
  if (!hits.length) return `No handoff matches "${who}". On handoff: ${open.map((e) => clients.find((c) => c.id === e.clientId)?.name ?? e.clientId).join(", ")}.`;
  for (const e of hits) await store.escalations.update(e.id, { status: "resolved", resolvedAt: nowISO() });
  const name = clients.find((c) => c.id === hits[0].clientId)?.name ?? who;
  await logEvent("escalation.resolved", { client: name, via: "owner-resume" });
  return `Resumed — I'll handle ${name} again from here.`;
}
