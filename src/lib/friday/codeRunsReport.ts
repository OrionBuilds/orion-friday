// Code runs → the OS (audit 2026-10-28 gap 6; contract §1).
//
// FRIDAY's real work — every dispatched code run — lived only in local runs.json, and its only
// report-up went to the retired CLARA app (127.0.0.1:3939). Now every run's start and finish is
// upserted into the OS with `agent_code_runs_report`, keyed by external_id = the FRIDAY run id, so
// the OS (and the OS-side FRIDAY thread answerer) can see what is running, what landed and what
// failed.
//
// Wiring: the runs collection calls our listener on every insert/update (store.ts
// setRunChangeListener). We report only STATUS TRANSITIONS (insert → running; a terminal status →
// succeeded/failed/cancelled), serialised per run so a slow "running" upsert can never land after
// the "succeeded" one. Fire-and-forget: a missing tool / OS outage is logged once and never touches
// the run. Kill switch: FRIDAY_CODE_RUNS_REPORT=off.

import path from "node:path";
import { promises as fs } from "node:fs";
import type { AgentRun, Task } from "@/lib/friday/types";
import { callOsTool, type CallOsToolOpts } from "@/lib/friday/osTool";

export type CodeRunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface CodeRunReport {
  external_id: string;
  project_id?: string;
  project_task_id?: string;
  request_ref?: string;
  kind: string;
  status: CodeRunStatus;
  started_at: string;
  finished_at?: string;
  summary?: string;
  error?: string;
  pr_url?: string;
  engine?: string;
}

export function codeRunsReportEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.FRIDAY_CODE_RUNS_REPORT ?? "").trim().toLowerCase() !== "off";
}

/** FRIDAY run status → contract status. awaiting_approval is still "running" (not settled). */
export function mapRunStatus(s: AgentRun["status"]): CodeRunStatus {
  if (s === "done") return "succeeded";
  if (s === "error") return "failed";
  if (s === "cancelled") return "cancelled";
  return "running";
}

/** Coarse run kind from the auto-round prefix / agent role / title. */
export function runKind(agentId: string | undefined, title: string | undefined): string {
  const t = (title ?? "").trim();
  const a = (agentId ?? "").toLowerCase();
  if (/^\[qa\]/i.test(t) || a === "qa") return "qa";
  if (/^\[review\]/i.test(t) || a.includes("review")) return "review";
  if (/^\[rebase\]/i.test(t)) return "rebase";
  if (/^\[deps\]/i.test(t) || a === "devops") return "maintenance";
  if (/\bdeploy\b/i.test(t)) return "deploy";
  if (/^\[fix\]/i.test(t) || /^(fix|bug)\b/i.test(t) || a === "debug") return "fix";
  if (a === "seo" || a.includes("research")) return "analysis";
  return "build";
}

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n) || undefined;

export interface ReportDeps {
  getTask: (id: string) => Promise<Task | null>;
  /** local project id → OS project id */
  osProjectId: (localId: string) => Promise<string | null>;
  /** local task id → OS project_tasks id (projectsSync sidecar) */
  osTaskId: (localTaskId: string) => Promise<string | null>;
}

/** Pure-ish: build the contract payload for one run. */
export async function buildCodeRunReport(run: AgentRun, deps: ReportDeps): Promise<CodeRunReport> {
  const task = run.taskId ? await deps.getTask(run.taskId).catch(() => null) : null;
  const status = mapRunStatus(run.status);
  const terminal = status !== "running";
  const prUrl = task?.prUrl ?? run.artifacts?.find((a) => a.kind === "pr")?.url;
  const out: CodeRunReport = {
    external_id: run.id,
    kind: runKind(run.agentId, task?.title ?? run.input),
    status,
    started_at: run.startedAt,
  };
  const projectId = run.projectId ? await deps.osProjectId(run.projectId).catch(() => null) : null;
  if (projectId) out.project_id = projectId;
  const taskId = run.taskId ? await deps.osTaskId(run.taskId).catch(() => null) : null;
  if (taskId) out.project_task_id = taskId;
  if (task?.requestId) out.request_ref = task.requestId;
  if (terminal) out.finished_at = run.endedAt ?? new Date().toISOString();
  const summary = clip(run.summary ?? (terminal ? run.result : task?.title ?? run.input), 1000);
  if (summary) out.summary = summary;
  if (run.error) out.error = clip(run.error, 1000);
  if (prUrl) out.pr_url = prUrl;
  const engine = run.servedEngine ?? run.intendedEngine;
  if (engine) out.engine = run.servedModel ? `${engine}:${run.servedModel}` : engine;
  return out;
}

// ── reporter (stateful) ──────────────────────────────────────────────────────────────────────
export class CodeRunsReporter {
  private lastReported = new Map<string, CodeRunStatus>();
  private chains = new Map<string, Promise<void>>();

  constructor(private deps: ReportDeps, private callOpts: CallOsToolOpts = {}) {}

  /** Store listener: decides whether this change is a reportable transition, then queues it. */
  onRunChange(run: AgentRun, change: { inserted: boolean; patch?: Partial<AgentRun> }): Promise<void> | null {
    const status = mapRunStatus(run.status);
    if (!change.inserted && change.patch?.status === undefined && change.patch?.endedAt === undefined) return null;
    if (this.lastReported.get(run.id) === status) return null;
    this.lastReported.set(run.id, status);
    if (this.lastReported.size > 2000) {
      // bounded memory: forget the oldest entries (a re-report is an idempotent upsert anyway)
      for (const k of [...this.lastReported.keys()].slice(0, 500)) this.lastReported.delete(k);
    }
    const prev = this.chains.get(run.id) ?? Promise.resolve();
    const next = prev.then(() => this.send(run)).catch(() => {});
    this.chains.set(run.id, next);
    void next.finally(() => { if (this.chains.get(run.id) === next) this.chains.delete(run.id); });
    return next;
  }

  private async send(run: AgentRun): Promise<void> {
    const payload = await buildCodeRunReport(run, this.deps);
    await callOsTool("agent_code_runs_report", payload as unknown as Record<string, unknown>, {
      ...this.callOpts,
      context: { runId: run.id, status: payload.status },
    });
  }
}

// ── live wiring ──────────────────────────────────────────────────────────────────────────────
let taskMapCache: { at: number; map: Record<string, unknown> } | null = null;
async function osTaskIdFromSidecar(localTaskId: string): Promise<string | null> {
  if (!taskMapCache || Date.now() - taskMapCache.at > 5 * 60_000) {
    const { FRIDAY_DATA_DIR } = await import("@/lib/persistence/store");
    try {
      taskMapCache = { at: Date.now(), map: JSON.parse(await fs.readFile(path.join(FRIDAY_DATA_DIR, "os-task-map.json"), "utf8")) };
    } catch {
      taskMapCache = { at: Date.now(), map: {} };
    }
  }
  const v = taskMapCache.map[localTaskId];
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { os?: unknown }).os === "string") return (v as { os: string }).os;
  return null;
}

let installed = false;
/** Register the store listener once per process (called at server boot). */
export async function installCodeRunsReporter(): Promise<void> {
  if (installed || !codeRunsReportEnabled()) return;
  installed = true;
  const { setRunChangeListener, store } = await import("@/lib/persistence/store");
  const { refreshOsProjectUrls } = await import("@/lib/friday/projectUrls");
  const reporter = new CodeRunsReporter({
    getTask: (id) => store.tasks.get(id),
    osProjectId: async (localId) => (await refreshOsProjectUrls()).get(localId)?.osProjectId ?? null,
    osTaskId: osTaskIdFromSidecar,
  });
  setRunChangeListener((run, change) => { void reporter.onRunChange(run, change); });
}
