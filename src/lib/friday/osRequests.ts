// FRIDAY <-> Orion one-off requests. Other agents (Clara, on the owner's behalf) hand FRIDAY free-form
// work through the OS `agent_requests` queue; FRIDAY pulls it here, runs it through the normal planner
// (orchestrate) as owner-sanctioned work, and reports the outcome back so the requester can tell the
// owner. Pull model, same as osTasks: nothing is pushed to FRIDAY, there is no inbound port.
//
// Idempotency lives in a local link table keyed by the OS request id. A request is claimed with a long
// lease and re-claimed if the lease lapses; the link stops a re-claim from planning the same work twice.
// Outcomes are derived from the tasks/runs the planner created, never from what the model said:
//   completed - every task is completed/delivered        -> report completed (PR links + run recap)
//   failed    - a task's runs ended in error/cancelled and nothing is still running
//   working   - anything else; the lease is extended so the request isn't reclaimed under us
//   no tasks  - the planner answered / acted on existing data -> report COMPLETED with its reply;
//               only a genuine question (intent collect_*) is reported needs_input (audit gap 2).
//
// Audit 2026-10-28 (gaps 2, 3, 7) + contract §5:
//   * Trust: `source.requested_by` is set SERVER-side. 'owner' is the owner (owner-tier, relayed);
//     'client' is a client's ask (client-origin gates). ANYTHING else — 'team', missing, forged
//     junk — is refused without planning (default deny, never default owner).
//   * Context: `payload.history` (last ~10 thread turns) is passed to the planner, and the planner
//     gets the READ-ONLY OS tools so answers come from OS data, not the local mirror.
//   * Replies: a needs_input answer arrives as a NEW request with `payload.in_reply_to` = the old
//     id — FRIDAY resumes the original ask with the answer attached. A request re-claimed after FRIDAY
//     reported needs_input on it (the old same-row re-queue) is re-planned, not skipped.
//
// Gated by FRIDAY_OS_REQUESTS (off|active; default off until the OS migration is deployed).

import type { AgentRun, Task } from "@/lib/friday/types";

export type OsRequestsMode = "off" | "active";
export function osRequestsMode(env: Record<string, string | undefined> = process.env): OsRequestsMode {
  return (env.FRIDAY_OS_REQUESTS ?? "").trim().toLowerCase() === "active" ? "active" : "off";
}

export interface ThreadTurn { role: string; text: string; at?: string }
export interface OsRequestPayload {
  history?: ThreadTurn[]; in_reply_to?: string;
  /** "project_knowledge_refresh" = the Knowledge tab's Refresh button (contract: project-knowledge-contract.md). */
  type?: string; project_id?: string; repo_url?: string | null; slugs?: string[] | null; reason?: string;
}
export interface OsRequest {
  id: string; title: string; body: string; kind: string; attempt?: number;
  source?: {
    requested_by?: string; client_name?: string; subject?: string; channel?: string;
    // OS factory steps (channel 'factory'): the playbook step this request is, and what it must produce.
    factory_step_run_id?: string; deliverable?: string; role?: string | null; playbook?: string; step?: string;
    // Tolerated aliases until the OS ships `payload` (contract §5) — some rows carry these in source.
    history?: ThreadTurn[]; in_reply_to?: string; parent_request_id?: string;
  };
  payload?: OsRequestPayload | null;
}
export interface Link {
  id: string; title: string; taskIds: string[]; createdAt: string;
  reported?: "completed" | "failed" | "needs_input";
  /** What the planner was asked, and the question it asked back — so a reply can resume the plan. */
  message?: string; question?: string;
  /** Last reported summary, re-sent if the OS re-queues a request FRIDAY already settled. */
  summary?: string;
  /** The request id that resumed this one (needs_input → in_reply_to). */
  resumedBy?: string;
}

export interface PlanResult { reply: string; intent?: string; tasks: { id: string }[] }

/** A factory step's written result: `output` is the full deliverable, evidence/gate the step's checks. */
export type FactoryDeliverable =
  | { ok: true; output: string; evidence: { source: string; ref?: string }[]; gate: { passed: boolean; checks: { criterion: string; met: boolean; note?: string }[] } }
  | { ok: false; error: string };

/** A factory step that asks for a document (not code) is written, never planned into tasks. */
export function isFactoryDocument(r: Pick<OsRequest, "source">): boolean {
  return r.source?.channel === "factory" && Boolean(r.source?.factory_step_run_id) && r.source?.deliverable !== "code";
}

export interface RequestDeps {
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  orchestrate: (message: string, origin: "client" | "clara", opts?: { history?: { role: string; text: string }[] }) => Promise<PlanResult>;
  links: {
    get: (id: string) => Promise<Link | null>;
    insert: (l: Link) => Promise<unknown>;
    update: (id: string, patch: Partial<Link>) => Promise<unknown>;
    all: () => Promise<Link[]>;
  };
  getTask: (id: string) => Promise<Task | null>;
  runsFor: (taskId: string) => Promise<AgentRun[]>;
  log: (event: string, data?: Record<string, unknown>) => Promise<void>;
  now: () => string;
  /** Writes an OS factory step's document (scope, plan, QA report...) without planning tasks. Absent = planned. */
  writeFactoryDeliverable?: (r: OsRequest) => Promise<FactoryDeliverable>;
  /** Handles a Knowledge-tab Refresh request. Absent = such requests are planned like any other ask. */
  knowledgeRefresh?: (p: { projectId: string; repoUrl?: string | null; slugs?: string[] | null }) => Promise<{ ok: boolean; message: string; refreshed: number; stale: number; skipped: number }>;
}

/** Max requests being worked at once; more wait in the OS queue. */
export const MAX_OPEN = 5;
const DONE: Task["status"][] = ["completed", "delivered"];
const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
/** Clip an engine error keeping its END: a CLI echoes the prompt first and prints the real reason
 *  ("out of credits", "not logged in") last, so a head-only clip reported prompt text as the error. Exported for tests. */
export function clipError(s: string | undefined, n: number): string {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= n) return flat;
  const head = Math.min(60, Math.floor(n / 4));
  return `${flat.slice(0, head)} … ${flat.slice(-(n - head - 3))}`;
}

/** Who the planner should treat as the asker, or null = refuse. `requested_by` is server-set (contract
 *  §5): 'owner' → the owner's own ask relayed through the OS (owner tier); 'client' → a client's ask
 *  (scope and approval gates apply). Anything else is NOT the owner — default deny. */
export function originOf(r: Pick<OsRequest, "source">): "client" | "clara" | null {
  const by = (r.source?.requested_by ?? "").trim().toLowerCase();
  if (by === "owner") return "clara";
  if (by === "client") return "client";
  return null;
}

/** Planner intents that mean "I genuinely need an answer before I can start". */
const QUESTION_INTENTS = new Set(["collect_client", "collect_project"]);
export function isGenuineQuestion(p: Pick<PlanResult, "intent" | "tasks">): boolean {
  return p.tasks.length === 0 && QUESTION_INTENTS.has(String(p.intent ?? ""));
}

export function threadHistory(r: OsRequest): { role: string; text: string }[] {
  const raw = r.payload?.history ?? r.source?.history ?? [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && typeof t.text === "string" && t.text.trim())
    .slice(-10)
    .map((t) => ({ role: /^(user|owner|human)$/i.test(String(t.role ?? "")) ? "user" : "friday", text: clip(t.text, 1500) }));
}

export function inReplyTo(r: OsRequest): string | null {
  const v = r.payload?.in_reply_to ?? r.source?.in_reply_to ?? r.source?.parent_request_id;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** What FRIDAY is asked to do. Provenance is stated so the planner knows who is really asking. */
export function requestMessage(r: OsRequest): string {
  const by = originOf(r) === "client"
    ? `Triaged by Clara from a CLIENT email${r.source?.client_name ? ` from ${r.source.client_name}` : ""}; this is a client's ask, not the owner's.`
    : r.source?.channel === "agent_thread" ? "From the owner in their FRIDAY thread in the OS." : "Relayed by Clara for the owner.";
  return `${r.title}\n\n${r.body}\n\n(${by} OS request ${r.id}, kind: ${r.kind}.)`.trim();
}

/** A reply to an earlier needs_input: the original ask, the question FRIDAY asked, and the answer. */
export function resumeMessage(r: OsRequest, original: Link | null): string {
  const head = original?.message
    ? `Resuming an earlier request (OS ${original.id}).\n\nOriginal ask:\n${original.message}\n\nYou asked: ${original.question ?? "(question not recorded)"}\n\nThe owner's answer:`
    : `This answers an earlier question (OS request ${inReplyTo(r)}).`;
  return `${head}\n${r.body}\n\n(${requestMessage(r).split("\n\n").slice(-1)[0]})`;
}

export type Assessment =
  | { state: "working" }
  | { state: "completed"; summary: string; result: Record<string, unknown> }
  | { state: "failed"; summary: string; error: string };

/** Pure: what became of the tasks. Derived from task/run state only. */
export function assess(tasks: Task[], runsByTask: Record<string, AgentRun[]>): Assessment {
  if (tasks.length === 0) return { state: "working" };
  const running = tasks.some((t) => (runsByTask[t.id] ?? []).some((r) => r.status === "queued" || r.status === "running" || r.status === "awaiting_approval"));
  if (tasks.every((t) => DONE.includes(t.status))) {
    const bits = tasks.map((t) => {
      const last = [...(runsByTask[t.id] ?? [])].reverse().find((r) => r.status === "done");
      return [`${t.title}${t.prUrl ? ` (${t.prUrl})` : ""}`, last?.summary && clip(last.summary, 300)].filter(Boolean).join(": ");
    });
    return {
      state: "completed",
      summary: clip(bits.join(" | "), 900),
      result: { tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, prUrl: t.prUrl ?? null })) },
    };
  }
  if (!running) {
    const failedTask = tasks.find((t) => {
      const runs = runsByTask[t.id] ?? [];
      const last = runs[runs.length - 1];
      return last && (last.status === "error" || last.status === "cancelled") && !DONE.includes(t.status);
    });
    if (failedTask) {
      const last = (runsByTask[failedTask.id] ?? []).slice(-1)[0];
      return { state: "failed", summary: clip(`"${failedTask.title}" did not finish.`, 300), error: clipError(last?.error ?? `run ${last?.status}`, 400) };
    }
  }
  return { state: "working" };
}

async function report(d: RequestDeps, id: string, status: "completed" | "failed" | "needs_input", summary: string, extra: { result?: Record<string, unknown>; error?: string } = {}): Promise<boolean> {
  try {
    await d.call("agent_request_report", { request_id: id, status, summary: clip(summary, 1000), result: extra.result, error: extra.error });
    await d.links.update(id, { reported: status, summary: clip(summary, 1000) });
    return true;
  } catch (e) {
    // The OS refuses a report for a request we no longer hold (lease lost). Keep the link unreported and
    // retry; if it was reclaimed meanwhile it will show up in the next poll and be reported then.
    await d.log("os-requests.report_failed", { id, status, e: String(e).slice(0, 200) });
    return false;
  }
}

const asArray = (v: unknown): OsRequest[] => (Array.isArray(v) ? (v as OsRequest[]) : []);

/** One heartbeat: claim new work, plan it, track what is running, report what finished. */
export async function pollOsRequests(d: RequestDeps): Promise<{ claimed: number; started: number; reported: number; open: number }> {
  const links = await d.links.all();
  const open = links.filter((l) => !l.reported);
  let claimed = 0, started = 0, reportedN = 0;

  // 1. claim (only if there is room).
  if (open.length < MAX_OPEN) {
    const got = asArray(await d.call("agent_requests_poll", { limit: Math.min(2, MAX_OPEN - open.length), lease_minutes: 240 }));
    claimed = got.length;
    for (const r of got) {
      const seen = await d.links.get(r.id);
      if (seen && !seen.reported && seen.taskIds.length) continue; // in flight: tracking keeps it moving (never planned twice)
      // (seen, unreported, no tasks = an earlier report never landed — fall through and settle it now.)
      if (seen && (seen.reported === "completed" || seen.reported === "failed")) {
        // Already settled but handed back (e.g. our report was lost) — re-send the same outcome.
        if (await report(d, r.id, seen.reported, seen.summary || `"${clip(r.title, 80)}" was already ${seen.reported}.`)) reportedN++;
        continue;
      }
      // seen.reported === "needs_input": the OS re-queued the SAME row with an answer (legacy
      // answer_friday path) — re-plan it with the current body instead of skipping it forever.

      const origin = originOf(r);
      if (!origin) {
        await d.log("os-requests.refused", { id: r.id, requested_by: r.source?.requested_by ?? null });
        if (!seen) await d.links.insert({ id: r.id, title: r.title, taskIds: [], createdAt: d.now() });
        if (await report(d, r.id, "failed", "Not accepted: FRIDAY only takes work from the owner (or a client request the owner's assistant triaged).", { error: `requested_by=${r.source?.requested_by ?? "(missing)"} is not owner/client` })) reportedN++;
        continue;
      }

      if (isFactoryDocument(r) && d.writeFactoryDeliverable) {
        // An OS playbook step asking for a document (scope, plan, QA evidence, review): write it and report
        // it with its evidence and gate. Planning it would turn a scoping ask into real build tasks.
        if (!seen) await d.links.insert({ id: r.id, title: r.title, taskIds: [], createdAt: d.now() });
        try {
          const w = await d.writeFactoryDeliverable(r);
          if (w.ok) {
            const summary = `${w.gate.passed ? "Gate passed" : "Gate NOT passed"}: ${w.output}`;
            if (await report(d, r.id, "completed", summary, { result: { output: w.output.slice(0, 20_000), evidence: w.evidence, gate: w.gate } })) reportedN++;
          } else if (await report(d, r.id, "failed", `I couldn't write "${clip(r.title, 80)}".`, { error: clipError(w.error, 300) })) reportedN++;
        } catch (e) {
          if (await report(d, r.id, "failed", `I couldn't write "${clip(r.title, 80)}".`, { error: clipError(String(e), 300) })) reportedN++;
        }
        continue;
      }

      if (r.payload?.type === "project_knowledge_refresh" && r.payload.project_id && d.knowledgeRefresh) {
        // Not planner work: refresh the notes directly and report the counts. Owner-origin only (checked above).
        if (!seen) await d.links.insert({ id: r.id, title: r.title, taskIds: [], createdAt: d.now() });
        try {
          const k = await d.knowledgeRefresh({ projectId: r.payload.project_id, repoUrl: r.payload.repo_url, slugs: r.payload.slugs });
          const result = { refreshed: k.refreshed, stale: k.stale, skipped: k.skipped };
          if (await report(d, r.id, k.ok ? "completed" : "failed", k.message, k.ok ? { result } : { error: k.message, result })) reportedN++;
        } catch (e) {
          if (await report(d, r.id, "failed", "The knowledge refresh failed.", { error: clipError(String(e), 300) })) reportedN++;
        }
        continue;
      }

      const parentId = inReplyTo(r);
      const parent = parentId ? await d.links.get(parentId) : null;
      const message = parentId ? resumeMessage(r, parent) : requestMessage(r);
      let planned: PlanResult;
      try {
        planned = await d.orchestrate(message, origin, { history: threadHistory(r) });
      } catch (e) {
        await d.log("os-requests.plan_failed", { id: r.id, e: String(e).slice(0, 200) });
        if (seen) await d.links.update(r.id, { taskIds: [], reported: undefined, message });
        else await d.links.insert({ id: r.id, title: r.title, taskIds: [], createdAt: d.now(), message });
        if (await report(d, r.id, "failed", `I couldn't plan "${clip(r.title, 80)}".`, { error: clipError(String(e), 300) })) reportedN++;
        continue;
      }
      const link: Link = { id: r.id, title: r.title, taskIds: planned.tasks.map((t) => t.id), createdAt: d.now(), message };
      if (seen) await d.links.update(r.id, { ...link, reported: undefined, question: undefined });
      else await d.links.insert(link);
      if (parentId && parent) await d.links.update(parentId, { resumedBy: r.id });

      if (planned.tasks.length === 0) {
        if (isGenuineQuestion(planned)) {
          const question = planned.reply || "I need more detail to start this.";
          await d.links.update(r.id, { question });
          if (await report(d, r.id, "needs_input", question)) reportedN++;
        } else {
          // A plain answer / status / action on existing data: that IS the result.
          if (await report(d, r.id, "completed", planned.reply || "Done.", { result: { intent: planned.intent ?? "chat", answer: true } })) reportedN++;
        }
      } else {
        started++;
        await d.log("os-requests.started", { id: r.id, tasks: planned.tasks.length, resumed: parentId ?? undefined });
      }
    }
  }

  // 2. track everything still open
  for (const l of (await d.links.all()).filter((x) => !x.reported && x.taskIds.length)) {
    const tasks = (await Promise.all(l.taskIds.map((id) => d.getTask(id)))).filter((t): t is Task => Boolean(t));
    const runsByTask: Record<string, AgentRun[]> = {};
    for (const t of tasks) runsByTask[t.id] = await d.runsFor(t.id);
    const a = assess(tasks, runsByTask);
    if (a.state === "completed") { if (await report(d, l.id, "completed", a.summary, { result: a.result })) reportedN++; }
    else if (a.state === "failed") { if (await report(d, l.id, "failed", a.summary, { error: a.error })) reportedN++; }
    else await d.call("agent_request_extend_lease", { request_id: l.id, minutes: 240 }).catch(() => {});
  }
  return { claimed, started, reported: reportedN, open: (await d.links.all()).filter((x) => !x.reported).length };
}
