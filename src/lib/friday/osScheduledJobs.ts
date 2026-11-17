// OS-scheduled SEO / AI-visibility jobs (2026-10-28 decision; contract §8).
//
// FRIDAY's 10 local SEO-audit / AI-visibility schedules moved into OS agent_task_schedules rows
// (task_keys friday.seo_weekly_audit / friday.ai_visibility_monthly — see
// ~/backups/orion/friday-seo-schedules.json). The OS now owns the cadence; FRIDAY receives each
// due run through agent_tasks_poll and fires it through the SAME runner the local schedule used
// (scheduledDispatch.ts: budget gates → createTask → dispatchTask), so behaviour is unchanged.
//
// run.config (written by the OS SQL): { local_project_id, assignee, risk, title_template, prompt,
// legacy_local_schedule_id }. subject_id = the OS project id (fallback when local_project_id is
// missing or stale: project_agent_meta_get {agent:"friday"} maps it to the local id).

import path from "node:path";
import { promises as fs } from "node:fs";
import type { DueRun, PollContext, HandlerResult } from "@autom8ionlab/agent-core";
import { FRIDAY_DATA_DIR, store } from "@/lib/persistence/store";
import { callOsTool, osRows } from "@/lib/friday/osTool";
import type { Risk } from "@/lib/friday/types";

export const OS_SEO_TASK_KEYS = ["friday.seo_weekly_audit", "friday.ai_visibility_monthly"] as const;

const DEFAULT_TITLE: Record<string, string> = {
  "friday.seo_weekly_audit": "Weekly on-site SEO audit — {project}",
  "friday.ai_visibility_monthly": "Monthly AI-search visibility check — {project}",
};

const LAST_RUNS_FILE = () => path.join(FRIDAY_DATA_DIR, "os-scheduled-last-runs.json");

async function loadLastRuns(): Promise<Record<string, string>> {
  try { return JSON.parse(await fs.readFile(LAST_RUNS_FILE(), "utf8")) as Record<string, string>; } catch { return {}; }
}
async function saveLastRuns(m: Record<string, string>): Promise<void> {
  await fs.writeFile(LAST_RUNS_FILE(), JSON.stringify(m, null, 2), "utf8");
}

export interface OsSeoJobDeps {
  budgetBlock: (dueCount: number) => Promise<string | null>;
  dispatch: (spec: { projectId: string; projectName: string; titleTemplate: string; description?: string; assignee: string; risk?: Risk }) => Promise<{ taskId: string; runId?: string; gated: boolean }>;
  runStillRunning: (runId: string | undefined) => Promise<boolean>;
}

async function defaultDeps(): Promise<OsSeoJobDeps> {
  const m = await import("@/lib/friday/scheduledDispatch");
  return { budgetBlock: m.scheduledBudgetBlock, dispatch: m.dispatchScheduledTask, runStillRunning: m.runStillRunning };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Resolve the local FRIDAY project for this run: config.local_project_id, else subject_id via project_agent_meta. */
export async function resolveLocalProject(run: DueRun, ctx: PollContext): Promise<{ id: string; name: string } | null> {
  const cfgId = str(run.config?.["local_project_id"]);
  if (cfgId) {
    const p = await store.projects.get(cfgId);
    if (p) return { id: p.id, name: p.name };
  }
  if (!run.subject_id) return null;
  const meta = await callOsTool<unknown>("project_agent_meta_get", { agent: "friday" }, { client: ctx.osClient, context: { task_key: run.task_key } });
  if (!meta.ok) return null;
  const row = osRows<{ project_id: string; local_project_id: string | null }>(meta.data).find((r) => r.project_id === run.subject_id);
  if (!row?.local_project_id) return null;
  const p = await store.projects.get(row.local_project_id);
  return p ? { id: p.id, name: p.name } : null;
}

/** Handler for friday.seo_weekly_audit / friday.ai_visibility_monthly. Throws on anything that must show as a failed run. */
export async function runOsSeoJob(run: DueRun, ctx: PollContext, deps?: OsSeoJobDeps): Promise<HandlerResult> {
  const d = deps ?? (await defaultDeps());
  const project = await resolveLocalProject(run, ctx);
  if (!project) {
    throw new Error(`${run.task_key}: no local FRIDAY project for config.local_project_id=${String(run.config?.["local_project_id"] ?? "")} / subject_id=${run.subject_id ?? ""}`);
  }
  const cfg = run.config ?? {};
  const titleTemplate = str(cfg["title_template"]) ?? DEFAULT_TITLE[run.task_key] ?? `${run.title} — {project}`;
  const description = str(cfg["prompt"]);
  const assignee = str(cfg["assignee"]) ?? "seo";
  const riskRaw = str(cfg["risk"]);
  const risk = (riskRaw === "medium" || riskRaw === "high" || riskRaw === "low" ? riskRaw : "low") as Risk;
  const title = titleTemplate.replace(/\{project\}/gi, project.name);

  if (!(ctx.mode === "active" && run.mode === "active")) {
    return { summary: `[shadow] would dispatch "${title}" (${assignee}, risk ${risk}) on ${project.name}.`, result: { would_dispatch: true, project_id: project.id, title, assignee, risk } };
  }

  const key = `${run.task_key}:${project.id}`;
  const lastRuns = await loadLastRuns();
  if (await d.runStillRunning(lastRuns[key])) {
    return { summary: `Skipped "${title}": the previous run (${lastRuns[key]}) is still running.`, result: { skipped: "previous run still running", run_id: lastRuns[key] } };
  }
  const blocked = await d.budgetBlock(1);
  if (blocked) {
    // "agent paused in OS settings" pages nobody — the owner paused FRIDAY themselves.
    const hint = blocked.startsWith("agent ") ? "set FRIDAY active in OS Settings → AI Agents to release it" : "owner paged; raise the cap to release it";
    throw new Error(`${run.task_key}: held — ${blocked} (${hint})`);
  }

  const res = await d.dispatch({ projectId: project.id, projectName: project.name, titleTemplate, description, assignee, risk });
  if (res.runId) { lastRuns[key] = res.runId; await saveLastRuns(lastRuns).catch(() => {}); }
  return {
    summary: `Dispatched "${title}" on ${project.name}${res.gated ? " — awaiting approval" : res.runId ? ` (run ${res.runId.slice(0, 8)})` : ""}.`,
    result: { task_id: res.taskId, run_id: res.runId ?? null, gated: res.gated, project_id: project.id },
  };
}
