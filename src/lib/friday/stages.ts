// Single source of truth for the project pipeline (the kanban board stages a task
// moves through). Order here == column order on the project board and in the Obsidian
// mirror. Everything else (types, transitions, filters) derives from this.
import type { TaskStatus } from "@/lib/friday/types";

export const TASK_STAGES: { key: TaskStatus; label: string }[] = [
  { key: "planning",           label: "Planning" },
  { key: "on_hold",            label: "On Hold" },
  { key: "blocked",            label: "Blocked" },
  { key: "in_progress",        label: "In Progress" },
  { key: "waiting_on_client",  label: "Waiting on Client" },
  { key: "internal_review",    label: "Internal Review" },
  { key: "qa_testing",         label: "QA & Testing" },
  { key: "client_review",      label: "Client Review" },
  { key: "revisions",          label: "Revisions" },
  { key: "bug_fixes",          label: "Bug Fixes" },
  { key: "maintenance",        label: "Maintenance" },
  { key: "supporting",         label: "Supporting" },
  { key: "completed",          label: "Completed" },
  { key: "delivered",          label: "Delivered" },
];

// Where new work lands, and the terminal states that count as "closed".
export const DEFAULT_STAGE: TaskStatus = "planning";
export const CLOSED_STAGES: TaskStatus[] = ["completed", "delivered"];
export function isClosed(status: TaskStatus | string): boolean {
  return CLOSED_STAGES.includes(status as TaskStatus);
}

export function stageLabel(status: TaskStatus | string): string {
  return TASK_STAGES.find((s) => s.key === status)?.label ?? String(status);
}

// The "advance" button's happy path. Holding/parallel states resume into the main flow;
// revisions loop back to build; completed → delivered is the finish line.
export const NEXT_STAGE: Record<TaskStatus, TaskStatus> = {
  planning:          "in_progress",
  on_hold:           "in_progress",
  blocked:           "in_progress",
  in_progress:       "internal_review",
  waiting_on_client: "in_progress",
  internal_review:   "qa_testing",
  qa_testing:        "client_review",
  client_review:     "completed",
  revisions:         "in_progress",
  bug_fixes:         "qa_testing",
  maintenance:       "delivered",
  supporting:        "delivered",
  completed:         "delivered",
  delivered:         "delivered", // terminal — advance button hides here
};
