// FRIDAY — weekly client update autopilot (Wave-2 #7).
//
// Every Friday afternoon, each active client with movement gets a short, warm "here's what happened
// this week" email: what shipped, what's in motion, what's next — drawn ONLY from the task board.
// Independent of any sibling agent's implementation (owner hard rule: the apps share nothing).
//
// QA is deterministic: no internal jargon ([QA]/[Fix R2]/VERDICT/agent ids), no placeholder junk,
// NO dollar figures at all (FRIDAY status mail never quotes money — commitments and pricing are
// owner-gated paths), sane length. One LLM fix pass on violations, then:
//   Delivery (2026-10): a portal Project Update (posted directly) + an email DRAFT in the owner's approval
//   queue in the OS, sent from Clara's mailbox only after they approve. FRIDAY sends no client mail.
//
// Skip rules: not active, no email, open human-handoff escalation, nothing happened, sent <6d ago.
// Kill switch: FRIDAY_WEEKLY_UPDATE=off.

import { store, logEvent } from "@/lib/persistence/store";
import { complete } from "@/lib/friday/engines";
import type { Client, Project, Task } from "@/lib/friday/types";
import { AGENCY } from "@/lib/friday/persona";

export function weeklyUpdateEnabled(): boolean {
  return (process.env.FRIDAY_WEEKLY_UPDATE ?? "on").trim().toLowerCase() !== "off";
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DONE = new Set(["completed", "delivered"]);
const MOVING = new Set(["in_progress", "qa_testing", "client_review", "revisions"]);

interface WeekWork {
  projects: Project[];
  shipped: Task[];   // completed/delivered in the window
  moving: Task[];    // currently in flight
  queued: Task[];    // waiting to start
}

async function gatherWeek(client: Client): Promise<WeekWork> {
  const cutoff = new Date(Date.now() - WEEK_MS).toISOString();
  // 2026-08-20: was `p.status !== "archived"`, which counted "paused" and "done" projects the same
  // as genuinely active ones — a client with only a paused/finished project could still produce
  // work.projects.length > 0. Requiring true "active" status means "we do not have active
  // projects on this client" reliably skips the weekly update rather than relying on the
  // shipped/moving activity check below to catch it incidentally.
  const projects = await store.projects.find((p) => p.clientId === client.id && p.status === "active");
  const ids = new Set(projects.map((p) => p.id));
  const tasks = await store.tasks.find((t) => !!t.projectId && ids.has(t.projectId));
  return {
    projects,
    shipped: tasks.filter((t) => DONE.has(t.status) && (t.updatedAt ?? "") >= cutoff),
    moving: tasks.filter((t) => MOVING.has(t.status)),
    queued: tasks.filter((t) => t.status === "planning" || t.status === "on_hold"),
  };
}

async function sentRecently(clientId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await store.logs.tail(400, (l) => l.event === "weekly_update.sent" || l.event === "weekly_update.queued");
  return rows.some((l) => (l.data as { clientId?: string } | undefined)?.clientId === clientId && l.ts >= cutoff);
}

// Titles reach the client — scrub the internal task-board markers before they enter the prompt.
function clientSafeTitle(t: Task): string {
  return t.title.replace(/^\s*\[(?:QA|Fix(?:\s*R\d+)?)\]\s*/i, "").replace(/\s*—?\s*(issues from QA|failing checks)\s*—\s*/i, " — ").trim();
}

// ── Deterministic QA (the validator the fix pass must satisfy) ─────────────
const INTERNAL_MARKERS = /\[(?:QA|Fix(?:\s*R\d+)?)\]|VERDICT:|\bauto-?merge\b|\bqa_testing\b|\brevisions\b|\bTier\s*\d\b/i;
const PLACEHOLDER = /\{[a-z0-9_ .-]+\}|\[[a-z0-9_ .-]+\]|\bTBD\b|\blorem\b|X{3,}/i;

export function weeklyUpdateIssues(text: string): string[] {
  const issues: string[] = [];
  if (!text || text.trim().length < 120) issues.push("update is too thin (<120 chars)");
  if (text.length > 2200) issues.push("update is too long (>2200 chars)");
  if (INTERNAL_MARKERS.test(text)) issues.push("contains internal task-board jargon ([QA]/[Fix]/VERDICT/stage names)");
  if (PLACEHOLDER.test(text)) issues.push("contains a placeholder/template token");
  if (/\$\s?\d/.test(text)) issues.push("contains a dollar figure (FRIDAY status mail never quotes money)");
  return issues;
}

async function draftUpdate(client: Client, work: WeekWork): Promise<string> {
  const first = client.name.trim().split(/\s+/)[0] || "there";
  const facts = [
    `shipped this week (${work.shipped.length}): ${work.shipped.slice(0, 6).map(clientSafeTitle).join("; ") || "none"}`,
    `in motion (${work.moving.length}): ${work.moving.slice(0, 5).map(clientSafeTitle).join("; ") || "none"}`,
    `queued next (${work.queued.length}): ${work.queued.slice(0, 4).map(clientSafeTitle).join("; ") || "none"}`,
    `projects: ${work.projects.map((p) => p.name).join(", ")}`,
  ].join("\n");
  const system =
    `You are FRIDAY, Technical Director at ${AGENCY}, writing a client's CASUAL weekly check-in email — 90 to 170 words, warm plain English.` +
    " Rules: use ONLY the facts provided; never invent work, dates, or promises; never mention money, internal tools, agents, QA, or process jargon;" +
    " 2 short paragraphs, no headings or bullets; if the week was quiet say so honestly and point at what's queued; sign off as FRIDAY. Output the email BODY only.";
  const prompt = `Client: ${client.name}\nFirst name: ${first}\n\nThis week on their account:\n${facts}\n\nWrite the email body now.`;
  const out = await complete({ system, prompt, temperature: 0.5, timeoutMs: 90_000 });
  return out.trim();
}

async function fixDraft(text: string, issues: string[]): Promise<string | null> {
  try {
    const out = await complete({
      system: "You edit a client-facing status email to fix the listed violations while keeping its warmth and meaning. Return the corrected email body only.",
      prompt: `Email:\n${text}\n\nViolations to fix:\n- ${issues.join("\n- ")}\n\nReturn the corrected body only.`,
      temperature: 0.2, timeoutMs: 60_000,
    });
    return out?.trim() || null;
  } catch { return null; }
}

export interface WeeklyUpdateResult {
  clientId: string;
  clientName: string;
  outcome: "sent" | "queued" | "skipped" | "dry";
  reason?: string;
  subject?: string;
  body?: string;
  qaIssues?: string[];
}

export async function runWeeklyUpdateForClient(client: Client, opts?: { dryRun?: boolean }): Promise<WeeklyUpdateResult> {
  const base = { clientId: client.id, clientName: client.name };
  if (!weeklyUpdateEnabled()) return { ...base, outcome: "skipped", reason: "FRIDAY_WEEKLY_UPDATE=off" };
  if (client.status !== "active") return { ...base, outcome: "skipped", reason: `client status ${client.status}` };
  if (!client.email) return { ...base, outcome: "skipped", reason: "no client email" };
  const escalated = await store.escalations.find((e) => e.clientId === client.id && e.status === "open");
  if (escalated.length) return { ...base, outcome: "skipped", reason: "open human-handoff escalation" };
  if (await sentRecently(client.id)) return { ...base, outcome: "skipped", reason: "update already sent/queued <6d ago" };

  const work = await gatherWeek(client);
  if (!work.projects.length || (work.shipped.length === 0 && work.moving.length === 0)) {
    return { ...base, outcome: "skipped", reason: "no activity this week" };
  }

  let bodyText = await draftUpdate(client, work);
  let issues = weeklyUpdateIssues(bodyText);
  if (issues.length) {
    const fixed = await fixDraft(bodyText, issues);
    if (fixed) {
      const fixedIssues = weeklyUpdateIssues(fixed);
      if (fixedIssues.length <= issues.length) { bodyText = fixed; issues = fixedIssues; }
    }
  }
  const subject = `This week on ${work.projects[0]?.name ?? "your project"} — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  if (opts?.dryRun) return { ...base, outcome: "dry", subject, body: bodyText, qaIssues: issues };

  // Delivery (2026-10): the portal gets the update directly; the email is a DRAFT in the owner's approval
  // queue that Clara sends from her mailbox once they approve. FRIDAY never sends client mail, whatever
  // the authority dial says: a client-facing email is not something to autopilot.
  const week = isoWeek(new Date());
  const portalPosted = await postWeeklyToPortal(client, work, subject, bodyText, week).catch(() => false);
  if (!client.osContactId) {
    return { ...base, outcome: portalPosted ? "queued" : "skipped", reason: portalPosted ? "posted to the portal; client has no OS contact to email" : "client has no OS contact (osContactId) to draft an email for", subject, body: bodyText, qaIssues: issues };
  }
  const { draftClientEmail } = await import("@/lib/friday/osClientEmail");
  const draft = await draftClientEmail({
    contactId: client.osContactId, subject, body: bodyText, externalRef: `weekly:${client.id}:${week}`,
    summary: `Weekly update for ${client.name}${issues.length ? ` (QA: ${issues.join(" · ").slice(0, 120)})` : ""}`,
  });
  if (!draft.ok) return { ...base, outcome: portalPosted ? "queued" : "skipped", reason: `email draft failed: ${draft.error}`, subject, body: bodyText, qaIssues: issues };
  await logEvent("weekly_update.queued", { clientId: client.id, qaIssues: issues.length, portal: portalPosted, created: draft.created });
  return { ...base, outcome: "queued", subject, body: bodyText, qaIssues: issues };
}

/** ISO week key (YYYY-Www), the dedupe unit for one weekly update per client. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
}

/** Post the weekly summary to the first active project's portal feed (idempotent on source_ref). */
async function postWeeklyToPortal(client: Client, work: WeekWork, subject: string, body: string, week: string): Promise<boolean> {
  const { osProjectMap } = await import("@/lib/friday/portalUpdates");
  const { osClient, osEnabled } = await import("@/lib/friday/osClient");
  if (!osEnabled()) return false;
  const map = await osProjectMap();
  const project = work.projects.find((p) => p.portalUpdates !== false && map.has(p.id));
  if (!project) return false;
  await osClient.callTool("project_activity_create", {
    project_id: map.get(project.id), title: subject.slice(0, 200), detail: body.slice(0, 4000),
    source_ref: `weekly:${client.id}:${week}`, kind: "content", is_live: false,
  });
  return true;
}

export async function runWeeklyUpdates(opts?: { dryRun?: boolean }): Promise<WeeklyUpdateResult[]> {
  const clients = await store.clients.find((c) => c.status === "active");
  const out: WeeklyUpdateResult[] = [];
  for (const c of clients) {
    try { out.push(await runWeeklyUpdateForClient(c, opts)); }
    catch (e) {
      out.push({ clientId: c.id, clientName: c.name, outcome: "skipped", reason: `error: ${String(e instanceof Error ? e.message : e).slice(0, 120)}` });
      await logEvent("weekly_update.error", { clientId: c.id, error: String(e).slice(0, 160) }, { level: "warn" }).catch(() => {});
    }
  }
  return out;
}

export function summarizeResults(rs: WeeklyUpdateResult[]): string {
  const by = (o: WeeklyUpdateResult["outcome"]) => rs.filter((r) => r.outcome === o).length;
  return `${rs.length} client(s): ${by("sent")} sent · ${by("queued")} queued · ${by("skipped")} skipped`;
}
