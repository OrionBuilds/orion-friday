// FRIDAY — weekly client health report composer (Wave 5).
//
// Pure READ-ONLY composition for the OS-scheduled `friday.client_health_report` task (weekly
// Fri 08:00, autonomous / owner_briefing). For each ACTIVE project it assembles a per-client
// status from what FRIDAY already knows locally:
//   • tasks    — completed/delivered in the last 7 days + open/in-progress counts (tasks store;
//                the board being empty — it was recently wiped — just yields zeros, never throws)
//   • deliverables — agent runs from the last 7 days that produced artifacts (PR links, PDF reports)
//   • uptime   — the flap-damped per-project state the scheduler's uptime job persists to
//                uptime-state.json ({status, consecutiveFails, lastDownAlertAt}; legacy flat
//                "up"/"down" strings still parse)
//   • engineering — deploy/staging URLs, repo count, stack, target end date off the project record
//
// NO sending happens here — the osTasks handler owns delivery (result_summary on the run +
// team_message_send when fully active). A client-visible clone of this report would be a separate,
// approval-gated task later; this one is owner-only by construction.

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store } from "@/lib/persistence/store";
import { projectRepos } from "@/lib/friday/types";
import type { Project, Task } from "@/lib/friday/types";

const WEEK_MS = 7 * 24 * 60 * 60_000;
const OPEN_EXCLUDED = new Set(["completed", "delivered"]);

export interface UptimeSection {
  monitored: boolean;
  status?: "up" | "down";
  consecutiveFails?: number;
  lastDownAlertAt?: string;
}

export interface ClientHealthSections {
  tasks: {
    completed7d: number;
    delivered7d: number;
    open: number;
    inProgress: number;
    recentDoneTitles: string[]; // up to 3, newest first
  };
  deliverables: {
    runsWithArtifacts7d: number;
    prUrls: string[];      // up to 5
    reportLabels: string[]; // up to 5 (PDF artifacts)
  };
  uptime: UptimeSection;
  engineering: {
    deployUrl?: string;
    stagingUrl?: string;
    repoCount: number;
    stack?: string;
    targetEndDate?: string;
  };
}

export interface ClientHealthReport {
  clientId: string;
  clientName: string;
  projectId: string;
  projectName: string;
  sections: ClientHealthSections;
  text: string; // one-paragraph per-project status, owner-facing
}

export interface ClientHealthOutput {
  generatedAt: string;
  reports: ClientHealthReport[];
  ownerSummary: string; // combined owner briefing text across all clients
}

// uptime-state.json shape (written by scheduler.ts "uptime" job). Legacy rows may be flat strings.
type RawUptime = Record<string, { status: "up" | "down"; consecutiveFails: number; lastDownAlertAt?: string } | string>;

async function readUptimeState(): Promise<RawUptime> {
  try {
    return JSON.parse(await fs.readFile(path.join(FRIDAY_DATA_DIR, "uptime-state.json"), "utf8")) as RawUptime;
  } catch {
    return {};
  }
}

function uptimeFor(p: Project, raw: RawUptime): UptimeSection {
  if (!p.deployUrl || !/^https?:\/\//.test(p.deployUrl)) return { monitored: false };
  const v = raw[p.id];
  if (!v) return { monitored: true, status: "up", consecutiveFails: 0 }; // monitored, no incident recorded yet
  if (typeof v === "string") return { monitored: true, status: v === "down" ? "down" : "up", consecutiveFails: v === "down" ? 2 : 0 };
  return { monitored: true, status: v.status, consecutiveFails: v.consecutiveFails, lastDownAlertAt: v.lastDownAlertAt };
}

function doneInWindow(tasks: Task[], status: "completed" | "delivered", since: number): Task[] {
  return tasks.filter((t) => t.status === status && Date.parse(t.updatedAt) >= since);
}

function composeText(clientName: string, projectName: string, s: ClientHealthSections): string {
  const parts: string[] = [];
  const wrapped = s.tasks.completed7d + s.tasks.delivered7d;
  if (wrapped > 0) {
    const titles = s.tasks.recentDoneTitles.length ? ` (${s.tasks.recentDoneTitles.join("; ")})` : "";
    parts.push(`${wrapped} task(s) wrapped this week${titles}`);
  } else {
    parts.push("no tasks closed this week");
  }
  parts.push(s.tasks.open > 0 ? `${s.tasks.open} open (${s.tasks.inProgress} in progress)` : "board clear");
  if (s.deliverables.runsWithArtifacts7d > 0) {
    const bits: string[] = [];
    if (s.deliverables.prUrls.length) bits.push(`${s.deliverables.prUrls.length} PR(s)`);
    if (s.deliverables.reportLabels.length) bits.push(`${s.deliverables.reportLabels.length} report(s)`);
    parts.push(`deliverables: ${bits.join(" + ") || `${s.deliverables.runsWithArtifacts7d} artifact run(s)`}`);
  }
  if (s.uptime.monitored) {
    parts.push(
      s.uptime.status === "down"
        ? `site DOWN (${s.uptime.consecutiveFails ?? "?"} consecutive failed checks${s.uptime.lastDownAlertAt ? `, last paged ${s.uptime.lastDownAlertAt.slice(0, 16)}Z` : ""})`
        : "site up",
    );
  }
  if (s.engineering.targetEndDate) parts.push(`target ${s.engineering.targetEndDate}`);
  return `${clientName} — ${projectName}: ${parts.join(" · ")}.`;
}

/**
 * Build the weekly per-client health reports + a combined owner summary. Pure composition —
 * reads the local stores and uptime-state.json, never sends anything, never throws on empty data.
 */
export async function buildClientHealthReports(): Promise<ClientHealthOutput> {
  const generatedAt = new Date().toISOString();
  const since = Date.now() - WEEK_MS;
  const projects = (await store.projects.all()).filter((p) => p.status === "active");
  const uptimeRaw = await readUptimeState();
  const reports: ClientHealthReport[] = [];

  for (const p of projects) {
    const client = await store.clients.get(p.clientId).catch(() => null);
    const clientName = client?.name ?? "Unknown client";

    // Tasks — the board was recently wiped; empty results are a normal, healthy outcome here.
    const tasks = await store.tasks.find((t) => t.projectId === p.id).catch(() => [] as Task[]);
    const completed = doneInWindow(tasks, "completed", since);
    const delivered = doneInWindow(tasks, "delivered", since);
    const recentDone = [...completed, ...delivered]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 3)
      .map((t) => t.title.slice(0, 60));
    const open = tasks.filter((t) => !OPEN_EXCLUDED.has(t.status));

    // Deliverables — finished runs from the last 7d that produced artifacts (PRs, PDFs, summaries).
    const runs = await store.runs
      .find((r) => r.projectId === p.id && !!(r.artifacts ?? []).length && Date.parse(r.endedAt ?? r.startedAt) >= since)
      .catch(() => []);
    const prUrls = runs
      .flatMap((r) => (r.artifacts ?? []).filter((a) => a.kind === "pr" && a.url).map((a) => a.url!))
      .slice(0, 5);
    const reportLabels = runs
      .flatMap((r) => (r.artifacts ?? []).filter((a) => a.kind === "pdf").map((a) => a.label.slice(0, 60)))
      .slice(0, 5);

    const sections: ClientHealthSections = {
      tasks: {
        completed7d: completed.length,
        delivered7d: delivered.length,
        open: open.length,
        inProgress: open.filter((t) => t.status === "in_progress").length,
        recentDoneTitles: recentDone,
      },
      deliverables: { runsWithArtifacts7d: runs.length, prUrls, reportLabels },
      uptime: uptimeFor(p, uptimeRaw),
      engineering: {
        deployUrl: p.deployUrl,
        stagingUrl: p.stagingUrl,
        repoCount: projectRepos(p).length,
        stack: p.stack,
        targetEndDate: p.targetEndDate,
      },
    };

    reports.push({
      clientId: p.clientId,
      clientName,
      projectId: p.id,
      projectName: p.name,
      sections,
      text: composeText(clientName, p.name, sections),
    });
  }

  // Combined owner summary — headline, one line per project, incidents called out at the bottom.
  const clientCount = new Set(reports.map((r) => r.clientId)).size;
  const down = reports.filter((r) => r.sections.uptime.status === "down");
  const wrappedTotal = reports.reduce((n, r) => n + r.sections.tasks.completed7d + r.sections.tasks.delivered7d, 0);
  const lines = [
    `FRIDAY weekly client health — ${generatedAt.slice(0, 10)}: ${reports.length} active project(s) across ${clientCount} client(s), ${wrappedTotal} task(s) wrapped this week, ${down.length} site(s) down.`,
    ...reports.map((r) => `• ${r.text}`),
  ];
  if (down.length) lines.push(`⚠ Down right now: ${down.map((r) => `${r.projectName} (${r.sections.engineering.deployUrl})`).join(", ")}.`);

  return { generatedAt, reports, ownerSummary: lines.join("\n") };
}
