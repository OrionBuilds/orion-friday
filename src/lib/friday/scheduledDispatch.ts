// Shared "fire a scheduled job" path — used by the local `scheduled-agent-tasks` scheduler job AND by
// the OS-scheduled SEO / AI-visibility handlers (osTasks.ts friday.seo_weekly_audit /
// friday.ai_visibility_monthly, 2026-10-28) so both run the exact same runner: the run/spend budget
// gates, createTask, dispatchTask (which applies the approval gate).

import { store } from "@/lib/persistence/store";
import { OWNER } from "@/lib/friday/persona";
import { notifyOwner } from "@/lib/friday/notify";
import type { Risk } from "@/lib/friday/types";

/**
 * The run-budget and spend-budget breakers. Returns null when work may fire, else the reason
 * ("budget cap" / "spend cap") after paging the owner with an answerable message.
 */
export async function scheduledBudgetBlock(dueCount: number): Promise<string | null> {
  // OS agent settings: FRIDAY paused/disabled → hold scheduled work. No page: the owner paused her,
  // and the scheduler would otherwise repeat this every minute. The status change itself is logged.
  const { getAgentSettings, refusalFor } = await import("@/lib/friday/agentSettings");
  const settings = await getAgentSettings({ maxWaitMs: 3_000 });
  if (refusalFor(settings)) return `agent ${settings?.root.status ?? "paused"} in OS settings`;
  const {
    withinRunBudget, runsToday, effectiveDailyRunCap, runOverrideToday,
    withinSpendBudget, spendToday, effectiveDayMaxUsd, spendOverrideToday,
    blockedWorkContext,
  } = await import("@/lib/friday/usage");
  const now = new Date();
  if (!(await withinRunBudget())) {
    // Answerable, like the spend page below it. A bare "run cap reached" is a dead end when the
    // reason it fired is that a lot of real work landed on a day with a real deadline.
    const [ran, cap, granted, atRisk] = await Promise.all([
      runsToday(), effectiveDailyRunCap(), runOverrideToday(), blockedWorkContext(3),
    ]);
    const lines = [
      `${dueCount} scheduled task(s) held — ${ran} of ${cap} runs used today${granted > 0 ? ` (includes ${granted} you already added)` : ""}.`,
    ];
    if (atRisk.length) lines.push(`Client work waiting:\n${atRisk.map((a) => `- ${a}`).join("\n")}`);
    lines.push(`Reply "raise friday runs 25" to add 25 more for today only — it resets at midnight.`);
    await notifyOwner({
      kind: "budget",
      // A held queue with client deadlines behind it is not a footnote.
      priority: "critical",
      text: lines.join("\n"),
      dedupeKey: `budget:${now.toISOString().slice(0, 10)}:${granted}`,
    });
    return "budget cap";
  }
  // Spend breaker — written to be ANSWERABLE: names what is held, what it costs so far, which
  // client deadlines are exposed, and the exact text that unblocks it.
  if (!(await withinSpendBudget())) {
    const [spent, cap, granted, atRisk] = await Promise.all([
      spendToday(), effectiveDayMaxUsd(), spendOverrideToday(), blockedWorkContext(3),
    ]);
    const lines = [
      `${dueCount} scheduled task(s) held — I've spent $${spent.toFixed(2)} of $${cap.toFixed(2)} today${granted > 0 ? ` (includes $${granted.toFixed(2)} you already added)` : ""}.`,
    ];
    if (atRisk.length) lines.push(`Client work waiting:\n${atRisk.map((a) => `- ${a}`).join("\n")}`);
    lines.push(`Reply "raise friday budget 20" to add $20 for today only — it resets at midnight.`);
    await notifyOwner({
      kind: "spend",
      priority: "critical",
      text: lines.join("\n"),
      // Re-page when a grant changes the picture rather than staying silent all day.
      dedupeKey: `spend:${now.toISOString().slice(0, 10)}:${granted.toFixed(0)}`,
    });
    return "spend cap";
  }
  return null;
}

export interface ScheduledTaskSpec {
  projectId: string;
  projectName: string;
  /** "{project}" is substituted with the project name. */
  titleTemplate: string;
  description?: string;
  assignee: string;
  risk?: Risk;
}

/** createTask + dispatchTask, exactly as a local schedule fires. */
export async function dispatchScheduledTask(spec: ScheduledTaskSpec): Promise<{ taskId: string; runId?: string; gated: boolean }> {
  const { createTask } = await import("@/lib/friday/repo");
  const { dispatchTask } = await import("@/lib/friday/orchestrator");
  const title = spec.titleTemplate.replace(/\{project\}/gi, spec.projectName);
  const description = spec.description?.replace(/\{project\}/gi, spec.projectName);
  const task = await createTask({
    projectId: spec.projectId, title, assignee: spec.assignee, risk: spec.risk ?? "low",
    description, requestedBy: OWNER, requestOrigin: "scheduler",
  });
  const res = await dispatchTask(task.id);
  return { taskId: task.id, runId: res.run?.id, gated: !res.run && !!res.approval };
}

/** Is a run still in flight? (skip-if-running guard, avoids pile-up on slow agents) */
export async function runStillRunning(runId: string | undefined): Promise<boolean> {
  if (!runId) return false;
  const prev = await store.runs.get(runId);
  return !!prev && prev.status === "running";
}

// ── migration guard: local schedules now owned by OS agent_task_schedules ─────────────────────
// Retired jobs are deleted (not moved); the SEO / AI-visibility jobs moved to the OS
// (~/backups/orion/friday-seo-schedules.json). Between FRIDAY's deploy and the apply script
// removing them from schedules.json, FRIDAY_SEO_SCHEDULES_IN_OS=1 stops the local copies firing
// so nothing double-runs. Retired ids are always skipped.
// Both id lists are deployment config (comma/space separated schedule ids), never hardcoded:
//   FRIDAY_RETIRED_SCHEDULE_IDS  — local schedules that are always skipped (retired outright);
//   FRIDAY_MIGRATED_SCHEDULE_IDS — local schedules now owned by the OS (skipped while
//                                  FRIDAY_SEO_SCHEDULES_IN_OS=1).
function scheduleIdList(v: string | undefined): string[] {
  return (v ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}
export const RETIRED_SCHEDULE_IDS: readonly string[] = scheduleIdList(process.env.FRIDAY_RETIRED_SCHEDULE_IDS);
export const MIGRATED_SEO_SCHEDULE_IDS: readonly string[] = scheduleIdList(process.env.FRIDAY_MIGRATED_SCHEDULE_IDS);

/** Pure: must the LOCAL scheduler skip this schedule (it is retired or now owned by the OS)? */
export function localScheduleRetired(s: { id: string }, env: Record<string, string | undefined> = process.env): boolean {
  if (scheduleIdList(env.FRIDAY_RETIRED_SCHEDULE_IDS).includes(s.id)) return true;
  return env.FRIDAY_SEO_SCHEDULES_IN_OS === "1" && scheduleIdList(env.FRIDAY_MIGRATED_SCHEDULE_IDS).includes(s.id);
}
