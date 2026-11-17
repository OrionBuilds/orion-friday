// Client-request lifecycle — the persisted entity that owns a client's ask and moves it through
// review (logged → … → client_review → client_accepted → closed). This module is deliberately LIGHT
// (store + types only) so taskIntake and the orchestrator can import it without pulling in Gmail/LLM
// deps; the heavy review-email machinery lives in clientReview.ts, which imports this.
//
// State transitions are recorded here; the review email loop (send/poll/classify/nudge/close) and the
// changes-requested revision loop live in clientReview.ts.

import { store, newId, nowISO, logEvent } from "@/lib/persistence/store";
import type { Request, RequestState, Task, Channel } from "@/lib/friday/types";

export async function getRequest(id: string): Promise<Request | null> {
  return store.requests.get(id);
}

export async function updateRequest(id: string, patch: Partial<Request>): Promise<Request | null> {
  return store.requests.update(id, { ...patch, updatedAt: nowISO() });
}

/** Create the Request that owns a client ask (one per extracted ask). Starts in `logged`. */
export async function createRequest(input: {
  projectId: string;
  clientId: string;
  title: string;
  scope: "in_scope" | "new";
  scopeVerdict?: Request["scopeVerdict"];
  taskId: string;
  origin?: Channel;
  originContact?: string;
}): Promise<Request> {
  const now = nowISO();
  const req: Request = {
    id: newId(),
    projectId: input.projectId,
    clientId: input.clientId,
    title: input.title.slice(0, 140),
    state: "logged",
    scope: input.scope,
    scopeVerdict: input.scopeVerdict,
    revisionRound: 0,
    taskIds: [input.taskId],
    origin: input.origin,
    originContact: input.originContact,
    createdAt: now,
    updatedAt: now,
  };
  await store.requests.insert(req);
  return req;
}

/** Move a request to a new state (best-effort log; never throws into the caller's happy path). */
export async function transition(id: string, state: RequestState, patch: Partial<Request> = {}): Promise<void> {
  const req = await store.requests.get(id);
  if (!req) return;
  if (req.state === state && Object.keys(patch).length === 0) return;
  await store.requests.update(id, { ...patch, state, updatedAt: nowISO() });
  await logEvent("request.transition", { id, from: req.state, to: state, project: req.projectId }, { projectId: req.projectId });
}

/** Append a task (a revision/fix) to a request's owned-task list, de-duplicated. */
export async function linkTask(id: string, taskId: string): Promise<void> {
  const req = await store.requests.get(id);
  if (!req || req.taskIds.includes(taskId)) return;
  await store.requests.update(id, { taskIds: [...req.taskIds, taskId], updatedAt: nowISO() });
}

// A request is ready to show the client when its LATEST owned task (revisions/fixes append newer ones)
// has reached a done-ish state. Using the latest task — not "all tasks" — sidesteps the QA-fail quirk
// where the original task is parked in `revisions` while its [Fix] task carries the work forward.
const DONEISH: ReadonlyArray<Task["status"]> = ["completed", "delivered", "client_review"];

export async function requestReadyForReview(req: Request): Promise<boolean> {
  const tasks = (await Promise.all(req.taskIds.map((id) => store.tasks.get(id)))).filter(Boolean) as Task[];
  if (!tasks.length) return false;
  const latest = tasks.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[tasks.length - 1];
  return DONEISH.includes(latest.status);
}

/** Find the Request that owns a given task id (for the QA-completion hook). */
export async function requestForTask(taskId?: string): Promise<Request | null> {
  if (!taskId) return null;
  const t = await store.tasks.get(taskId);
  if (t?.requestId) return store.requests.get(t.requestId);
  // Fallback: a task created before requestId plumbing, but still owned via taskIds.
  const owning = await store.requests.find((r) => r.taskIds.includes(taskId));
  return owning[0] ?? null;
}
