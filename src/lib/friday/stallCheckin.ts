// FRIDAY — support stall check-in autopilot (Wave 1, F5).
//
// Every morning 09:00 local, for each active client with (a) no client-authored contact in >= 14
// days, (b) at least one OPEN task or request, (c) no open escalation, (d) no stall check-in
// sent/queued in the last 30 days: draft a warm one-paragraph nudge email that references ONE
// specific open item and asks if there's anything to prioritize. The draft goes through the EXISTING
// approve-to-send loop (Gmail draft + queueEmailApproval) — the owner approves or rejects on their phone.
//
// Client-facing HARD RULE: NEVER auto-sends. The draft always rides queueEmailApproval, even under
// FRIDAY_AUTHORITY=active — an unanswered client conversation is not something to autopilot into.
//
// Three-state gate (universal shadow-first pattern):
//   FRIDAY_STALL_CHECKIN=off     → skip entirely
//   FRIDAY_STALL_CHECKIN=shadow  → draft + log `stall_checkin.would_fire` with subject/body; DO NOT
//                                  create Gmail draft or queue approval. Default while soaking.
//   FRIDAY_STALL_CHECKIN=active  → normal draft + approval path.
//
// Skip rules: not active, no email, open escalation, no client-authored contact ever (new client),
// last client contact < 14d ago, no open tasks, check-in queued/sent < 30d ago (log-tail dedupe).
//
// QA is deterministic (checkinIssues): no dollar figures, no placeholders/template junk, no internal
// jargon, no dates or promised timelines, must contain the client's first name, ≤ 90 words. Same
// self-heal fix pass as weeklyUpdate — a violating draft that can't be healed is queued anyway with
// the issues attached to the summary so the owner knows to eyeball.

import { store, logEvent } from "@/lib/persistence/store";
import { complete } from "@/lib/friday/engines";
import type { Client, Task } from "@/lib/friday/types";
import { AGENCY } from "@/lib/friday/persona";

export type StallCheckinMode = "off" | "shadow" | "active";

export function stallCheckinMode(): StallCheckinMode {
  const v = (process.env.FRIDAY_STALL_CHECKIN ?? "shadow").trim().toLowerCase();
  return v === "off" || v === "active" ? v : "shadow";
}

const STALL_DAYS = 14;
const CADENCE_DAYS = 30;
const DONE = new Set(["completed", "delivered", "cancelled", "archived"]);

// Tasks the client would recognize as an open item — filter out closed/archived + FRIDAY-internal
// stage names. The client has never seen "qa_testing" — pick a stage name they'd actually recognize.
function openClientTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !DONE.has(t.status));
}

// Newest task the CLIENT is on the hook for — used as the concrete item the nudge references.
function primaryOpenItem(tasks: Task[]): Task | undefined {
  const clientVisible = openClientTasks(tasks)
    .sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1));
  // Prefer tasks the client explicitly requested (requesterClientId set) — that's a conversation
  // the client already knows about. Fall back to any open task.
  const requested = clientVisible.find((t) => !!t.requesterClientId);
  return requested ?? clientVisible[0];
}

// Titles reach the client — scrub internal task-board markers.
function clientSafeTitle(t: Task): string {
  return t.title
    .replace(/^\s*\[(?:QA|Fix(?:\s*R\d+)?|Dev handoff)\]\s*/i, "")
    .replace(/\s*—?\s*(issues from QA|failing checks)\s*—\s*/i, " — ")
    .trim();
}

interface StallSignals {
  lastClientContactAt: string | null;   // ISO or null (never heard from them)
  daysSilent: number | null;            // days since lastClientContactAt (null if never)
  openTasks: Task[];
  primary?: Task;
}

async function gatherSignals(client: Client): Promise<StallSignals> {
  const projects = await store.projects.find((p) => p.clientId === client.id && p.status !== "archived");
  const projIds = new Set(projects.map((p) => p.id));
  const tasksAll = await store.tasks.find((t) => !!t.projectId && projIds.has(t.projectId));

  // Signal A: newest task where the CLIENT is the requester — createdAt = when they asked.
  const requesterTs = tasksAll
    .filter((t) => t.requesterClientId === client.id)
    .map((t) => t.createdAt)
    .sort((a, b) => (a < b ? 1 : -1))[0];

  // Signal B: newest kind:"message" memory entry for this client (covers inbound email + chat).
  const { listClientMemory } = await import("@/lib/friday/memory");
  const mem = await listClientMemory(client.id, 40);
  // Client-authored entries — inbound email indexed as `"<Name> emailed:"` / chat as `"(client) said:"`.
  const clientAuthored = mem.filter((m) => {
    if (m.kind !== "message") return false;
    const s = m.snippet ?? "";
    return /\bemailed:/i.test(s) || /\(client\) said:/i.test(s);
  });
  const memoryTs = clientAuthored.map((m) => m.ts).sort((a, b) => (a < b ? 1 : -1))[0];

  const candidates = [requesterTs, memoryTs].filter((x): x is string => !!x);
  const lastClientContactAt = candidates.length
    ? candidates.sort((a, b) => (a < b ? 1 : -1))[0]
    : null;
  const daysSilent = lastClientContactAt
    ? Math.floor((Date.now() - Date.parse(lastClientContactAt)) / (24 * 60 * 60_000))
    : null;

  const openTasks = openClientTasks(tasksAll);
  return { lastClientContactAt, daysSilent, openTasks, primary: primaryOpenItem(tasksAll) };
}

async function checkinSentRecently(clientId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - CADENCE_DAYS * 24 * 60 * 60_000).toISOString();
  const rows = await store.logs.tail(600, (l) => l.event === "stall_checkin.queued" || l.event === "stall_checkin.would_fire" || l.event === "stall_checkin.sent");
  return rows.some((l) => (l.data as { clientId?: string } | undefined)?.clientId === clientId && l.ts >= cutoff);
}

// ── Deterministic QA (mirrors weeklyUpdateIssues family) ────────────────────
const INTERNAL_MARKERS = /\[(?:QA|Fix(?:\s*R\d+)?|Dev handoff)\]|VERDICT:|\bqa_testing\b|\brevisions\b|\bTier\s*\d\b|\bawaiting_approval\b|\bautomerge\b/i;
const PLACEHOLDER = /\{[a-z0-9_ .-]+\}|\[[a-z0-9_ .-]+\]|\bTBD\b|\blorem\b|X{3,}/i;
const DATE_HINT = /\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(uary|ruary|ch|il|e|y|ust|tember|ober|ember)?\b|\bnext week\b|\btomorrow\b|\bby (end of|the end of|EOW|EOD|COB)\b/i;

// Strip the persona sign-off ("— FRIDAY" or a bare "FRIDAY" line at the end) so the DATE_HINT
// regex's `\bfri\b` doesn't self-trigger on our own name. Also strips any trailing "Warmly,"-style
// closer preceding the signoff.
function stripSignoff(text: string): string {
  return text.replace(/(?:—\s*)?FRIDAY\s*$/i, "").replace(/(?:—\s*)?FRIDAY[\s\r\n]*$/i, "").trim();
}

export function checkinIssues(text: string, firstName: string): string[] {
  const issues: string[] = [];
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const bodyForContentChecks = stripSignoff(text);
  if (!text || text.trim().length < 60) issues.push("check-in is too thin (<60 chars)");
  if (wordCount > 90) issues.push(`check-in is too long (${wordCount} words > 90)`);
  if (INTERNAL_MARKERS.test(text)) issues.push("contains internal task-board jargon");
  if (PLACEHOLDER.test(text)) issues.push("contains a placeholder/template token");
  if (/\$\s?\d/.test(text)) issues.push("contains a dollar figure (never allowed in a check-in)");
  if (DATE_HINT.test(bodyForContentChecks)) issues.push("contains a date/day/timeline promise (avoid — this is a nudge, not a commitment)");
  if (firstName && !new RegExp(`\\b${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) {
    issues.push(`missing client's first name (${firstName})`);
  }
  return issues;
}

async function draftCheckin(client: Client, primary: Task, daysSilent: number): Promise<string> {
  const first = client.name.trim().split(/\s+/)[0] || "there";
  const openItem = clientSafeTitle(primary);
  const system =
    `You are FRIDAY, Technical Director at ${AGENCY}. Write a WARM, SHORT check-in email — one paragraph, 40 to 80 words, plain English.` +
    " Rules: use the client's first name once at the start; reference the specific open item by name; ask a single open-ended question (is there anything they want prioritized, anything you should know); NO dates, NO timelines, NO dollar figures, NO internal jargon, NO promises;" +
    " tone is friendly and unhurried — you noticed they've been quiet and just wanted to check in, not to chase them. Sign off as FRIDAY. Output the email BODY only.";
  const prompt =
    `Client: ${client.name}\nFirst name: ${first}\nDays since last heard from them: ${daysSilent}\nOne open item you can reference: "${openItem}"\n\nWrite the check-in body now.`;
  const out = await complete({ system, prompt, temperature: 0.5, timeoutMs: 90_000 });
  return out.trim();
}

async function fixDraft(text: string, issues: string[]): Promise<string | null> {
  try {
    const out = await complete({
      system: "You edit a warm client check-in email to fix the listed violations while keeping its warmth and its single open-ended question. Return the corrected body only.",
      prompt: `Email:\n${text}\n\nViolations:\n- ${issues.join("\n- ")}\n\nReturn the corrected body only.`,
      temperature: 0.2, timeoutMs: 60_000,
    });
    return out?.trim() || null;
  } catch { return null; }
}

export interface StallCheckinResult {
  clientId: string;
  clientName: string;
  outcome: "queued" | "shadow" | "skipped" | "dry";
  reason?: string;
  daysSilent?: number;
  subject?: string;
  body?: string;
  qaIssues?: string[];
}

/** Draft (and queue, unless dryRun / shadow) one client's stall check-in. */
export async function runStallCheckinForClient(
  client: Client,
  opts?: { dryRun?: boolean },
): Promise<StallCheckinResult> {
  const base = { clientId: client.id, clientName: client.name };
  const mode = stallCheckinMode();
  if (mode === "off") return { ...base, outcome: "skipped", reason: "FRIDAY_STALL_CHECKIN=off" };
  if (client.status !== "active") return { ...base, outcome: "skipped", reason: `client status ${client.status}` };
  if (!client.email) return { ...base, outcome: "skipped", reason: "no client email" };
  const escalated = await store.escalations.find((e) => e.clientId === client.id && e.status === "open");
  if (escalated.length) return { ...base, outcome: "skipped", reason: "open human-handoff escalation" };
  if (await checkinSentRecently(client.id)) return { ...base, outcome: "skipped", reason: `check-in sent/queued <${CADENCE_DAYS}d ago` };

  const signals = await gatherSignals(client);
  if (signals.daysSilent === null) return { ...base, outcome: "skipped", reason: "no prior client contact — new/unknown client" };
  if (signals.daysSilent < STALL_DAYS) return { ...base, outcome: "skipped", reason: `only ${signals.daysSilent}d silent (need >= ${STALL_DAYS})`, daysSilent: signals.daysSilent };
  if (!signals.openTasks.length) return { ...base, outcome: "skipped", reason: "no open tasks for this client", daysSilent: signals.daysSilent };
  if (!signals.primary) return { ...base, outcome: "skipped", reason: "no reference-able open item", daysSilent: signals.daysSilent };

  const first = client.name.trim().split(/\s+/)[0] || "";
  let body = await draftCheckin(client, signals.primary, signals.daysSilent);
  let issues = checkinIssues(body, first);
  if (issues.length) {
    const fixed = await fixDraft(body, issues);
    if (fixed) {
      const fixedIssues = checkinIssues(fixed, first);
      if (fixedIssues.length <= issues.length) { body = fixed; issues = fixedIssues; }
    }
  }
  const subject = `Quick check-in on ${clientSafeTitle(signals.primary)}`;
  const commonResult: Omit<StallCheckinResult, "outcome"> = { ...base, daysSilent: signals.daysSilent, subject, body, qaIssues: issues };

  if (opts?.dryRun) return { ...commonResult, outcome: "dry" };

  if (mode === "shadow") {
    await logEvent(
      "stall_checkin.would_fire",
      { clientId: client.id, subject, daysSilent: signals.daysSilent, qaIssues: issues.length, body },
    ).catch(() => {});
    return { ...commonResult, outcome: "shadow" };
  }

  // active — always go through queueEmailApproval (never auto-send a client-facing check-in).
  try {
    const { createDraft } = await import("@/lib/friday/google/gmail");
    const { googleConfigured } = await import("@/lib/friday/google/auth");
    const { brandedHtmlFor } = await import("@/lib/friday/emailTheme");
    const account = googleConfigured("friday") ? ("friday" as const) : ("owner" as const);
    const draft = await createDraft({ to: client.email, subject, body, html: brandedHtmlFor(body) }, account);
    if (!draft.ok || !draft.id) {
      return { ...commonResult, outcome: "skipped", reason: `draft failed: ${draft.error}` };
    }
    const { queueEmailApproval } = await import("@/lib/friday/orchestrator");
    await queueEmailApproval({
      draftId: draft.id, account, clientName: client.name,
      summary: `Stall check-in (${signals.daysSilent}d silent)${issues.length ? ` (QA: ${issues.join(" · ").slice(0, 100)})` : ""}`,
      clientId: client.id, body,
      requestOrigin: "scheduler", // FRIDAY's own timed job — owner-sanctioned standing work (2026-09)
    });
    await logEvent("stall_checkin.queued", { clientId: client.id, daysSilent: signals.daysSilent, qaIssues: issues.length }).catch(() => {});
    return { ...commonResult, outcome: "queued" };
  } catch (e) {
    return { ...commonResult, outcome: "skipped", reason: `error: ${String(e instanceof Error ? e.message : e).slice(0, 120)}` };
  }
}

/** Daily sweep across all active clients. Serial — a handful of clients, one LLM draft each. */
export async function runStallCheckins(opts?: { dryRun?: boolean }): Promise<StallCheckinResult[]> {
  if (stallCheckinMode() === "off") return [];
  const clients = await store.clients.find((c) => c.status === "active");
  const out: StallCheckinResult[] = [];
  for (const c of clients) {
    try { out.push(await runStallCheckinForClient(c, opts)); }
    catch (e) {
      out.push({ clientId: c.id, clientName: c.name, outcome: "skipped", reason: `error: ${String(e instanceof Error ? e.message : e).slice(0, 120)}` });
      await logEvent("stall_checkin.error", { clientId: c.id, error: String(e).slice(0, 160) }, { level: "warn" }).catch(() => {});
    }
  }
  return out;
}

/** Marker used by the scheduler job note. */
export function summarizeCheckins(rs: StallCheckinResult[]): string {
  const by = (o: StallCheckinResult["outcome"]) => rs.filter((r) => r.outcome === o).length;
  return `${rs.length} client(s): ${by("queued")} queued · ${by("shadow")} shadow · ${by("skipped")} skipped`;
}
