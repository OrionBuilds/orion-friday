// FRIDAY — pre-call briefing autopilot (Wave-2 #5, the prep half).
//
// The owner keeps meetings + sales; FRIDAY automates their shoulders. Every ~10 minutes the sweep looks
// 75 minutes ahead on the primary calendar; any event whose attendees include a known client's email
// gets ONE briefing to the owner — EMAIL ONLY (Wave-1 notification overhaul: this is the single
// pre-meeting system, and it never texts; the meeting_prep.sent log row is the in-app trace): who
// they are, every project + its stage, what shipped recently, what's moving, open asks, pending
// approvals, remembered history, and three sharp opening questions. Dedupe = one briefing per
// calendar event id, tracked in the log stream. The transcript→tasks half already lives in
// ingest.ts; this module adds the BEFORE.
//
// Owner-facing only — nothing here emails a client. Kill switch: FRIDAY_MEETING_PREP=off.

import { store, logEvent } from "@/lib/persistence/store";
import { complete } from "@/lib/friday/engines";
import type { CalEvent } from "@/lib/friday/google/calendar";
import type { Client } from "@/lib/friday/types";

export function meetingPrepEnabled(): boolean {
  return (process.env.FRIDAY_MEETING_PREP ?? "on").trim().toLowerCase() !== "off";
}

const LEAD_MS = 75 * 60_000; // how far ahead the sweep briefs

// ── Pure matchers (eval-harness locked) ────────────────────────────────────

/** The first client whose email appears in the event's attendee list (case-insensitive). */
export function matchEventClient<T extends { email?: string }>(event: { attendees?: string[] }, clients: T[]): T | null {
  const attendees = (event.attendees ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (!attendees.length) return null;
  for (const c of clients) {
    const em = c.email?.trim().toLowerCase();
    if (em && attendees.includes(em)) return c;
  }
  return null;
}

/** True when the event starts AFTER `now` and within `leadMs`. */
export function eventStartsWithin(event: { start: string }, nowMs: number, leadMs: number): boolean {
  const t = Date.parse(event.start);
  if (!Number.isFinite(t)) return false;
  return t > nowMs && t - nowMs <= leadMs;
}

// ── Briefing assembly ───────────────────────────────────────────────────────

const MOVING = new Set(["in_progress", "qa_testing", "client_review", "revisions"]);
const DONE = new Set(["completed", "delivered"]);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function buildBriefing(client: Client, event?: CalEvent, opts?: { openers?: boolean }): Promise<string> {
  const cutoff = new Date(Date.now() - WEEK_MS).toISOString();
  const projects = await store.projects.find((p) => p.clientId === client.id && p.status !== "archived");
  const projIds = new Set(projects.map((p) => p.id));
  const [tasks, requests, approvals] = await Promise.all([
    store.tasks.find((t) => !!t.projectId && projIds.has(t.projectId)),
    store.requests.find((r) => r.clientId === client.id && r.state !== "closed" && r.state !== "cancelled").catch(() => []),
    store.approvals.find((a) => a.status === "pending" && ((!!a.projectId && projIds.has(a.projectId)) || a.emailClientId === client.id)),
  ]);
  const shipped = tasks.filter((t) => DONE.has(t.status) && (t.updatedAt ?? "") >= cutoff);
  const moving = tasks.filter((t) => MOVING.has(t.status));
  const clean = (s: string) => s.replace(/^\s*\[(?:QA|Fix(?:\s*R\d+)?)\]\s*/i, "").trim();

  // Remembered history — transcripts, decisions, past replies (best-effort; empty when unindexed).
  let memory = "";
  try {
    const { recallBlock } = await import("@/lib/friday/memory");
    memory = await recallBlock(`${client.name} meeting priorities concerns`, { clientId: client.id, limit: 5 }, "Remembered history");
  } catch { /* optional */ }

  // Three sharp opening questions — one LLM call, deterministic fallback (skip section on failure).
  // Callers on a hot path (escalation briefings) pass openers:false to skip the LLM entirely.
  let questions = "";
  if (opts?.openers !== false) try {
    const q = await complete({
      system: "You prep a Technical Director for a client call. Given the account state, write EXACTLY 3 short, sharp opening questions that move the call forward. Ground every question in the provided facts; never invent work or numbers. Output the 3 questions as plain lines, no numbering preamble.",
      prompt: `Client: ${client.name}\nGoals/notes: ${client.notes ?? "—"}\nShipped this week: ${shipped.slice(0, 5).map((t) => clean(t.title)).join("; ") || "none"}\nIn motion: ${moving.slice(0, 5).map((t) => clean(t.title)).join("; ") || "none"}\nOpen asks: ${requests.slice(0, 5).map((r) => r.title).join("; ") || "none"}\nPending your decision: ${approvals.slice(0, 4).map((a) => a.action).join("; ") || "none"}`,
      temperature: 0.4, timeoutMs: 60_000,
    });
    if (q?.trim()) questions = `\n\n**Openers:**\n${q.trim().split(/\r?\n/).filter(Boolean).slice(0, 3).map((l) => `- ${l.replace(/^[-*\d.\s]+/, "")}`).join("\n")}`;
  } catch { /* optional */ }

  const when = event ? new Date(event.start).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }) : "now";
  const lines = [
    `## Prep: ${client.name}${event ? ` — "${event.summary}" at ${when}` : ""}`,
    event?.hangoutLink ? `Join: ${event.hangoutLink}` : "",
    ``,
    `**Projects:** ${projects.map((p) => `${p.name} (${p.status})`).join(" · ") || "none on file"}`,
    `**Shipped this week (${shipped.length}):** ${shipped.slice(0, 6).map((t) => clean(t.title)).join("; ") || "—"}`,
    `**In motion (${moving.length}):** ${moving.slice(0, 6).map((t) => clean(t.title)).join("; ") || "—"}`,
    `**Open asks (${requests.length}):** ${requests.slice(0, 6).map((r) => `${r.title} [${r.state}]`).join("; ") || "—"}`,
    `**Waiting on YOU (${approvals.length}):** ${approvals.slice(0, 5).map((a) => a.action).join("; ") || "nothing"}`,
    memory,
    questions,
  ];
  return lines.filter(Boolean).join("\n");
}

// ── The sweep (scheduler job body) ──────────────────────────────────────────

async function alreadyBriefed(eventId: string): Promise<boolean> {
  const rows = await store.logs.tail(300, (l) => l.event === "meeting_prep.sent");
  return rows.some((l) => (l.data as { eventId?: string } | undefined)?.eventId === eventId);
}

export async function runMeetingPrepSweep(): Promise<string> {
  if (!meetingPrepEnabled()) return "FRIDAY_MEETING_PREP=off";
  const { googleConfigured } = await import("@/lib/friday/google/auth");
  if (!googleConfigured()) return "google not configured";
  const { listEvents } = await import("@/lib/friday/google/calendar");
  const now = Date.now();
  const events = await listEvents({ timeMin: new Date(now).toISOString(), timeMax: new Date(now + LEAD_MS).toISOString(), max: 10 });
  const clients = await store.clients.find((c) => c.status === "active" && !!c.email);
  let sent = 0;
  for (const ev of events) {
    if (!eventStartsWithin(ev, now, LEAD_MS)) continue;
    const client = matchEventClient(ev, clients);
    if (!client) continue;
    if (await alreadyBriefed(ev.id)) continue;
    const briefing = await buildBriefing(client, ev);
    // Email-only: the briefing is long-form owner reading, not an interrupt — no SMS ping (Wave-1).
    // The meeting_prep.sent log row below is the durable in-app trace either way.
    try {
      const { sendEmail, getProfile } = await import("@/lib/friday/google/gmail");
      const me = (await getProfile()).email;
      // agent:"FRIDAY" keeps her own emailAgent from ingesting this as client mail (see notify.ts).
      if (me) await sendEmail({ to: me, subject: `Prep: ${client.name} — ${ev.summary}`, body: briefing, agent: "FRIDAY" });
    } catch { /* best-effort — the log trace below still lands */ }
    await logEvent("meeting_prep.sent", { eventId: ev.id, client: client.name, event: ev.summary });
    sent++;
  }
  return `${events.length} event(s) in window · ${sent} briefing(s) sent`;
}
