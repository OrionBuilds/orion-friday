// M2/M3 — FRIDAY's projects are mirrored one-way into the OS Projects module, in the ONE pipeline
// FRIDAY owns (Engineering — project_pipelines.owner_agent = 'friday').
//
// The task/run engine stays LOCAL — FRIDAY's 14-stage kanban does not map onto the OS's 5-status
// project_tasks model and must not be forced to. What the OS gets is a summary mirror, driven by
// agent-core's ProjectsSync (the same engine the sibling agents use):
//   * projects: local project ↔ OS project mapped via project_agent_meta.local_project_id
//     (the M2 migration seeded all 13); new local projects are pushed up on the next sync.
//   * stage: derived from the local board (projectStage.engineeringStage) and written by NAME →
//     the engine resolves the Engineering stage id and sends ONE projects_update with whatever
//     drifted (stage / status / progress / risk / budget / dates). Never project_move_stage.
//   * milestones: Client Review / Delivered / Completed / Maintenance transitions drop an
//     idempotent portal activity card.
//   * tasks: each local task upserts one project_tasks row with a coarse status
//     (todo / in_progress / in_review / completed) so the Office/OS sees real progress.
//
// Sync is TTL-gated (5 min), single-flight, never throws, and driven by the scheduler tick.
// Task-row ids are remembered in a local JSON sidecar (~/.agentic-os/friday/os-task-map.json —
// format unchanged: { [localTaskId]: osTaskId }) so re-syncs update instead of duplicating.

import path from "node:path";
import os from "node:os";
import { ProjectsSync, type LocalProject, type LocalTaskRow } from "@autom8ionlab/agent-core";
import { store, logEvent } from "@/lib/persistence/store";
import { osClient, osEnabled } from "@/lib/friday/osClient";
import { activeEscalation } from "@/lib/friday/escalations";
import { syncConnections } from "@/lib/friday/connectionsSync";
import {
  coarseStatus, engineeringMilestone, engineeringStage, toOsEngineeringStage, osProjectStatus, progressPercent, projectRisk,
} from "@/lib/friday/projectStage";
import type { Task } from "@/lib/friday/types";

const MAP_FILE = path.join(os.homedir(), ".agentic-os", "friday", "os-task-map.json");
// The pipeline this agent owns is config (FRIDAY_OS_PIPELINE_NAME; FRIDAY_OS_PIPELINE is the older
// alias). Unset falls back to "Engineering" with a one-time warning — a broken sync is worse.
const PIPELINE_NAME = (process.env.FRIDAY_OS_PIPELINE_NAME ?? process.env.FRIDAY_OS_PIPELINE ?? "").trim() || "Engineering";
if (!(process.env.FRIDAY_OS_PIPELINE_NAME ?? process.env.FRIDAY_OS_PIPELINE ?? "").trim() && !process.env.NODE_TEST_CONTEXT) {
  console.warn("[projectsBridge] FRIDAY_OS_PIPELINE_NAME is not set — falling back to \"Engineering\"");
}

async function localProjects(): Promise<LocalProject[]> {
  const [projects, tasks, clients] = await Promise.all([store.projects.all(), store.tasks.all(), store.clients.all()]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const tasksByProject = new Map<string, Task[]>();
  for (const t of tasks) {
    const list = tasksByProject.get(t.projectId) ?? [];
    list.push(t);
    tasksByProject.set(t.projectId, list);
  }

  const out: LocalProject[] = [];
  for (const p of projects) {
    const pt = tasksByProject.get(p.id) ?? [];
    const escalated = Boolean(await activeEscalation(p.clientId).catch(() => null));
    out.push({
      id: p.id,
      name: p.name,
      description: p.description,
      contactId: clientById.get(p.clientId)?.osContactId,
      osStatus: osProjectStatus(p.status),
      osStageName: toOsEngineeringStage(engineeringStage(p, pt)),
      stats: {
        progress_percent: progressPercent(pt),
        risk_level: projectRisk(pt, escalated),
        budget_amount: p.budget,
        start_date: p.startDate,
        target_end_date: p.targetEndDate,
      },
      meta: {
        repoUrl: p.repoUrl, repoUrls: p.repoUrls, deployUrl: p.deployUrl,
        supabaseRef: p.supabaseRef, driveFolderId: p.driveFolderId, localStatus: p.status,
      },
      milestone: engineeringMilestone,
    });
  }
  return out;
}

async function localTasks(localProjectId: string): Promise<LocalTaskRow[]> {
  const tasks = await store.tasks.find((t) => t.projectId === localProjectId);
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: coarseStatus(t.status),
    priority: t.risk === "high" || t.risk === "critical" ? "high" : "medium",
  }));
}

const LOUD = /error|failed|refused|mismatch|unavailable|unknown_stage/;

export const projectsSync = new ProjectsSync({
  agent: "friday",
  pipelineName: PIPELINE_NAME,
  client: osClient,
  enabled: osEnabled,
  localProjects,
  tasks: localTasks,
  taskMapPath: MAP_FILE,
  log: (event, data) =>
    void logEvent(event, data, { level: event === "projects.sync.meta_failed" ? "error" : LOUD.test(event) ? "warn" : "info" }).catch(() => {}),
});

/**
 * TTL-gated projects/tasks mirror into the OS, then the two-way connections sync (repos, Supabase,
 * Netlify, files folder — the OS is the source of truth; connectionsSync.ts). Never throws.
 */
export async function syncProjects(force = false): Promise<void> {
  await projectsSync.refresh(force);
  await syncConnections(force);
}
