// Pure derivations from FRIDAY's local board → what the OS Engineering pipeline shows.
//
// FRIDAY's 14-stage TASK kanban does not map 1:1 onto the OS PROJECT pipeline (stages are per
// project there), so a project's OS stage is DERIVED from the shape of its open work: nothing
// scoped yet → Kickoff; everything closed → Delivered / Finalization / Maintenance; everything
// open stuck in a holding state → Blocked / Waiting on Client / On Hold; otherwise the stage of
// the most-advanced open task. Kept free of store/network imports so it unit-tests offline
// (projectsBridge.test.ts) — projectsBridge.ts wires it to the store and the sync engine.

import type { Project, ProjectStatus, Risk, Task, TaskStatus } from "@/lib/friday/types";
import { TASK_STAGES, isClosed } from "@/lib/friday/stages";
import type { OsProjectStatus, OsRiskLevel } from "@autom8ionlab/agent-core";

type TaskLike = Pick<Task, "title" | "status"> & Partial<Pick<Task, "risk">>;

/** Recurring maintenance/monitoring chores are not delivery scope: weekly dependency bumps
 *  ("[Deps] …") and the uptime/security sweeps' health-check tasks recur forever and would
 *  otherwise peg a delivered, live site at a low percentage or a permanent "In Progress". */
export const CHORE = /\[Deps\]|site health|health check|qa-e2e/i;

/** Task stages that mean "parked", not "moving". */
export const HOLDING_STAGES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["on_hold", "blocked", "waiting_on_client"]);

/** Local task stage → OS Engineering pipeline stage name (exact names from the OS). */
export const TASK_STAGE_TO_OS: Record<TaskStatus, string> = {
  planning: "Planning",
  on_hold: "On Hold",
  blocked: "Blocked",
  in_progress: "In Progress",
  waiting_on_client: "Waiting on Client",
  internal_review: "Internal Review",
  qa_testing: "QA / Testing",
  client_review: "Client Review",
  revisions: "Revisions",
  bug_fixes: "Revisions",
  maintenance: "Maintenance / Support",
  supporting: "Maintenance / Support",
  completed: "Finalization",
  delivered: "Delivered",
};

// The OS "Engineering" project pipeline's live stages (2026-09-25). engineeringStage speaks FRIDAY's
// richer vocabulary; toOsEngineeringStage folds it onto these so the sync never sends a name the OS
// pipeline doesn't have (it logged projects.sync.unknown_stage ~2x a minute and left portal stages
// stale). Holding states map to where the work actually sits; nothing maps to "Client Review" unless
// the work really is with the client, because that stage posts a "ready for your review" card.
export const OS_ENGINEERING_STAGES = [
  "Planning", "Kickoff", "In Progress", "QA / Testing", "Client Review", "Maintenance / Support", "Delivered",
] as const;
const OS_STAGE_FOLD: Record<string, (typeof OS_ENGINEERING_STAGES)[number]> = {
  "Internal Review": "QA / Testing",
  "Revisions": "In Progress",
  "Blocked": "In Progress",
  "On Hold": "In Progress",
  "Waiting on Client": "In Progress",
  "Finalization": "QA / Testing",
  "Completed": "Delivered",
};
const OS_STAGE_FOLD_LC: Record<string, (typeof OS_ENGINEERING_STAGES)[number]> = Object.fromEntries(
  Object.entries(OS_STAGE_FOLD).map(([k, v]) => [k.toLowerCase(), v]),
);
export function toOsEngineeringStage(localStage: string): string {
  const key = localStage.trim().toLowerCase();
  const exact = OS_ENGINEERING_STAGES.find((s) => s.toLowerCase() === key);
  return exact ?? OS_STAGE_FOLD_LC[key] ?? "In Progress";
}

// FRIDAY's 14 stages → the OS's 5 project_tasks statuses (the coarse task mirror).
export function coarseStatus(s: TaskStatus | string): "todo" | "in_progress" | "in_review" | "completed" {
  switch (s) {
    case "planning": case "on_hold": case "blocked":
      return "todo";
    case "internal_review": case "qa_testing": case "client_review":
      return "in_review";
    case "completed": case "delivered":
      return "completed";
    default:
      return "in_progress";
  }
}

/** Local project status → OS project status. `archived` is an offboarded (finished) engagement, not a cancelled one. */
export function osProjectStatus(local: ProjectStatus | string): OsProjectStatus {
  switch (local) {
    case "paused": return "on_hold";
    case "done": case "archived": return "completed";
    default: return "active";
  }
}

const stageIndex = (s: TaskStatus | string): number => TASK_STAGES.findIndex((x) => x.key === s);

/** The OS Engineering stage this project should sit in, derived from its status + task board. */
export function engineeringStage(project: Pick<Project, "status">, tasks: TaskLike[]): string {
  if (project.status === "paused") return "On Hold";
  if (project.status === "done" || project.status === "archived") return "Completed";

  const scoped = tasks.filter((t) => !CHORE.test(t.title ?? ""));
  if (scoped.length === 0) return "Kickoff";

  const open = scoped.filter((t) => !isClosed(t.status));
  if (open.length === 0) {
    // Everything scoped is closed. Recurring upkeep still open (chores included) → Maintenance.
    if (tasks.some((t) => !isClosed(t.status) && (t.status === "maintenance" || t.status === "supporting"))) {
      return "Maintenance / Support";
    }
    return scoped.every((t) => t.status === "delivered") ? "Delivered" : "Finalization";
  }

  const moving = open.filter((t) => !HOLDING_STAGES.has(t.status as TaskStatus));
  if (moving.length === 0) {
    if (open.some((t) => t.status === "blocked")) return "Blocked";
    if (open.some((t) => t.status === "waiting_on_client")) return "Waiting on Client";
    return "On Hold";
  }

  let best = moving[0];
  for (const t of moving) if (stageIndex(t.status) > stageIndex(best.status)) best = t;
  return TASK_STAGE_TO_OS[best.status as TaskStatus] ?? "In Progress";
}

/** Progress over SCOPED work actually in flight — chores and untouched planning backlog excluded.
 *  `undefined` when nothing scoped is in flight, so a manually-set OS value sticks. */
export function progressPercent(tasks: TaskLike[]): number | undefined {
  const scoped = tasks.filter((t) => !CHORE.test(t.title ?? "") && coarseStatus(t.status) !== "todo");
  if (scoped.length === 0) return undefined;
  const done = scoped.filter((t) => coarseStatus(t.status) === "completed").length;
  return Math.round((done / scoped.length) * 100);
}

const RISK_ORDER: Risk[] = ["low", "medium", "high", "critical"];

/** Project risk from its open scoped tasks (+ an open human-handoff escalation for the client). */
export function projectRisk(tasks: TaskLike[], escalated: boolean): OsRiskLevel {
  const open = tasks.filter((t) => !CHORE.test(t.title ?? "") && !isClosed(t.status));
  if (open.some((t) => t.risk === "critical")) return "critical";
  if (escalated || open.some((t) => t.status === "blocked" || t.risk === "high")) return "high";
  let max = 0;
  for (const t of open) max = Math.max(max, RISK_ORDER.indexOf((t.risk ?? "low") as Risk));
  return RISK_ORDER[Math.max(0, max)] ?? "low";
}

/** Client-visible milestone card for the portal feed — only for stages the client cares about. */
export function engineeringMilestone(_from: string | null, to: string): { title: string; detail: string } | null {
  switch (to) {
    case "Client Review":
      return { title: "Moved to Client Review", detail: "This project is ready for your review." };
    case "Delivered":
      return { title: "Delivered", detail: "I've delivered this project. Let me know if anything needs a follow-up." };
    case "Completed":
      return { title: "Project completed", detail: "This project is complete. Thank you for working with us." };
    case "Maintenance / Support":
      return { title: "Now in Maintenance / Support", detail: "Delivery is done; I'm keeping this project maintained and monitored." };
    default:
      return null;
  }
}
