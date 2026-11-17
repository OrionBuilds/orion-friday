// FRIDAY — dependency-update sweep autopilot (Wave 1, F1).
//
// Every Wednesday, each active project with `repoUrls` gets a devops task titled
// `[Deps] <repoName> weekly patch bumps`. The devops agent runs the appropriate outdated command
// against the lockfile, applies PATCH-version bumps + security patches only, executes tests via
// the existing maybeAutoQA auto-hook, and — if all green — opens a PR labeled
// `deps: weekly patch bumps`. FRIDAY merges it herself once checks, review comments and conflicts
// are clear (PR shepherd) — the owner never merges (owner rule 2026-09-24).
//
// Weekly means weekly whoever drives it: `isSweepDay()` gates BOTH the local job and the OS
// handler (the OS schedule was daily, which opened one sibling PR per day; the siblings then
// conflicted on the same lockfile). Before opening a new PR the sweep looks at the repo's open
// upkeep PRs: a green one still awaiting merge means skip this week; a conflicting or stale one is
// closed as superseded so the fresh sweep replaces it.
//
// Three-state gate (universal shadow-first pattern):
//   FRIDAY_DEP_SWEEP=off     → skip entirely
//   FRIDAY_DEP_SWEEP=shadow  → enumerate repos + log `dep_sweep.would_fire` with the intended prompt
//                              for each; DO NOT create tasks / dispatch. Default while pattern soaks.
//   FRIDAY_DEP_SWEEP=active  → createTask + dispatchTask per repo, capped at 5 per tick. Dispatch
//                              still passes through needsApproval (medium risk = auto-run for read/
//                              analysis titles; PR merge is the human gate).
//
// Skip rules: not active, no repoUrls (and no legacy repoUrl), open escalation on the project.

import { store, logEvent } from "@/lib/persistence/store";
import { projectRepos } from "@/lib/friday/types";
import type { Project } from "@/lib/friday/types";
import { OWNER } from "@/lib/friday/persona";
import { isUpkeepPr } from "@/lib/friday/prUpkeep";
import { parseGithubRepo } from "@/lib/friday/recentWork";

export type DepSweepMode = "off" | "shadow" | "active";

export function depSweepMode(): DepSweepMode {
  const v = (process.env.FRIDAY_DEP_SWEEP ?? "shadow").trim().toLowerCase();
  return v === "off" || v === "active" ? v : "shadow";
}

// ── Single-owner rule (Wave 5) ──────────────────────────────────────────────
// The weekly dep sweep has TWO possible drivers: the local `dep-sweep-weekly` scheduler job and
// the OS `friday.devops_housekeeping` schedule (osTasks.ts). Exactly one may dispatch:
//   FRIDAY_DEP_SWEEP_OWNER=local (default) → the local scheduler job runs it; the OS handler runs
//                                            the sweep dry (reports what it WOULD do, dispatches nothing).
//   FRIDAY_DEP_SWEEP_OWNER=os             → the local job no-ops with a log; the OS handler runs it
//                                            for real (still honoring FRIDAY_DEP_SWEEP shadow/active).
export type DepSweepOwner = "local" | "os";

export function depSweepOwner(): DepSweepOwner {
  return (process.env.FRIDAY_DEP_SWEEP_OWNER ?? "local").trim().toLowerCase() === "os" ? "os" : "local";
}

/** The sweep runs on Wednesdays (local time). Injectable clock for tests. */
export function isSweepDay(now: Date = new Date()): boolean {
  return now.getDay() === 3;
}

/** Open upkeep PRs on a repo, as the sweep sees them. Injectable (tests, probes). */
export interface OpenUpkeepPr { number: number; url: string; title: string; headRefName: string; mergeable: string; checks: string; createdAt: string }
export interface SweepGh {
  listOpenPrs(owner: string, repo: string): Promise<OpenUpkeepPr[]>;
  closePr(url: string, comment: string): Promise<{ ok: boolean; error?: string }>;
}
export const STALE_UPKEEP_DAYS = 14;

async function defaultGh(): Promise<SweepGh> {
  const { listOpenPrs } = await import("@/lib/friday/releaseApprovals");
  const { closePr } = await import("@/lib/friday/codeSummary");
  return {
    listOpenPrs: async (owner, repo) => (await listOpenPrs(owner, repo)).map((p) => ({
      number: p.number, url: p.url, title: p.title, headRefName: p.headRefName ?? "", mergeable: p.mergeable, checks: p.checks, createdAt: p.createdAt ?? "",
    })),
    closePr,
  };
}

/**
 * What to do about a repo's existing open upkeep PRs before opening a new one (pure).
 *   skip  — a green (or still-computing) upkeep PR is open; FRIDAY will merge it, no new sweep this week
 *   close — conflicting or older than STALE_UPKEEP_DAYS: superseded by the fresh sweep
 */
export function planUpkeepPrs(prs: OpenUpkeepPr[], now: Date = new Date()): { skipBecause?: OpenUpkeepPr; close: OpenUpkeepPr[] } {
  const upkeep = prs.filter((p) => isUpkeepPr(p));
  const staleBefore = now.getTime() - STALE_UPKEEP_DAYS * 24 * 60 * 60 * 1000;
  const close: OpenUpkeepPr[] = [];
  let skipBecause: OpenUpkeepPr | undefined;
  for (const p of upkeep) {
    const stale = !!p.createdAt && new Date(p.createdAt).getTime() < staleBefore;
    if (p.mergeable === "CONFLICTING" || stale) { close.push(p); continue; }
    if (p.checks !== "FAILURE") { if (!skipBecause || p.number > skipBecause.number) skipBecause = p; }
    else close.push(p); // red checks on an old sweep: replace it rather than heal it
  }
  return { skipBecause, close };
}

// Strip owner/organization + `.git` suffix; keep the last path segment. Used for task titles.
export function repoDisplayName(url: string): string {
  const trimmed = url.trim().replace(/\.git\/?$/i, "").replace(/\/+$/, "");
  const segs = trimmed.split(/[\/]+/);
  return segs[segs.length - 1] || url;
}

function buildDepsPrompt(project: Project, repoUrl: string, repoName: string): string {
  return [
    `[Weekly deps sweep — ${repoName}]`,
    ``,
    `Repo: ${repoUrl}`,
    `Project: ${project.name}${project.workspaceDir ? ` (workspace: ${project.workspaceDir})` : ""}`,
    ``,
    `Task:`,
    `1. Detect the lockfile — package-lock.json, yarn.lock, pnpm-lock.yaml — and run the appropriate outdated command (npm outdated, yarn outdated, pnpm outdated).`,
    `2. Apply PATCH-version bumps ONLY (semver x.y.Z). Skip minor and major bumps this pass.`,
    `3. Layer in any security advisories (npm audit fix --production, yarn npm audit, pnpm audit) — only if they can be resolved with patch or non-breaking bumps.`,
    `4. Install + run the project's test suite. If tests are missing, run the project's typecheck (tsc --noEmit) as the minimum green bar.`,
    `5. If ANYTHING is red — a test fails, typecheck fails, install errors — STOP, do not open a PR, and describe what broke in the run notes.`,
    `6. If green: commit on a branch \`friday/deps-weekly-YYYY-MM-DD\`, push, and open a PR labeled \`deps: weekly patch bumps\` describing the bumps in the body (before → after per package).`,
    ``,
    `Constraints:`,
    `- No minor/major bumps this pass (they need eyeball on breaking changes).`,
    `- No lockfile-only rewrites without an actual version change.`,
    `- Do NOT merge the PR yourself — FRIDAY merges it automatically once checks, review comments and conflicts are clear.`,
  ].join("\n");
}

export interface DepSweepEntry {
  projectId: string;
  projectName: string;
  repoUrl: string;
  repoName: string;
  outcome: "dispatched" | "queued" | "shadow" | "skipped" | "dry" | "error";
  taskId?: string;
  runId?: string;
  approvalId?: string;
  reason?: string;
  prompt?: string;
}

/** Enumerate active projects + repos, dispatch (or shadow-log) up to MAX per tick. */
export async function runDepSweep(opts?: { dryRun?: boolean; max?: number; now?: Date; gh?: SweepGh }): Promise<DepSweepEntry[]> {
  const mode = depSweepMode();
  if (mode === "off") return [];
  const MAX = Math.max(1, opts?.max ?? 5);
  const out: DepSweepEntry[] = [];
  const now = opts?.now ?? new Date();
  const gh = opts?.gh ?? (await defaultGh());
  const openTasks = await store.tasks.find((t) => /^\s*\[deps\]/i.test(t.title) && !["completed", "delivered", "cancelled", "archived"].includes(t.status));

  const projects = (await store.projects.all()).filter((p) => p.status === "active");
  for (const p of projects) {
    if (out.length >= MAX) break;
    const escalations = await store.escalations.find((e) => e.clientId === p.clientId && e.status === "open");
    if (escalations.length) {
      out.push({ projectId: p.id, projectName: p.name, repoUrl: "-", repoName: "-", outcome: "skipped", reason: "open escalation on client" });
      continue;
    }
    const repos = projectRepos(p);
    if (!repos.length) {
      out.push({ projectId: p.id, projectName: p.name, repoUrl: "-", repoName: "-", outcome: "skipped", reason: "no repoUrls" });
      continue;
    }
    for (const repoUrl of repos) {
      if (out.length >= MAX) break;
      const repoName = repoDisplayName(repoUrl);
      const prompt = buildDepsPrompt(p, repoUrl, repoName);
      const entry: DepSweepEntry = { projectId: p.id, projectName: p.name, repoUrl, repoName, outcome: "shadow", prompt };
      // A [Deps] task for this repo is still on the board → the previous sweep isn't done yet.
      if (openTasks.some((t) => t.projectId === p.id && t.title.toLowerCase().includes(repoName.toLowerCase()))) {
        out.push({ ...entry, outcome: "skipped", reason: "previous [Deps] task still open" });
        continue;
      }
      // Existing open upkeep PRs decide whether this week's sweep is needed at all.
      const gh2 = parseGithubRepo(repoUrl);
      if (gh2) {
        const plan = planUpkeepPrs(await gh.listOpenPrs(gh2.owner, gh2.repo).catch(() => []), now);
        if (plan.skipBecause) {
          out.push({ ...entry, outcome: "skipped", reason: `open deps PR #${plan.skipBecause.number} awaiting merge` });
          continue;
        }
        for (const stale of plan.close) {
          const why = stale.mergeable === "CONFLICTING" ? "it has merge conflicts" : "it is older than two weeks";
          if (opts?.dryRun) { entry.reason = `${entry.reason ? entry.reason + "; " : ""}would close #${stale.number} (${why})`; continue; }
          const r = await gh.closePr(stale.url, `Superseded by this week's dependency sweep — ${why}. FRIDAY will open a fresh PR.`);
          await logEvent(r.ok ? "dep_sweep.superseded" : "dep_sweep.supersede_failed", { project: p.name, repo: repoName, pr: stale.number, why, error: r.error }).catch(() => {});
        }
      }
      if (opts?.dryRun) { out.push({ ...entry, outcome: "dry" }); continue; }
      if (mode === "shadow") {
        await logEvent(
          "dep_sweep.would_fire",
          { project: p.name, repo: repoName, url: repoUrl, prompt },
        ).catch(() => {});
        out.push(entry);
        continue;
      }
      // active — create the task + dispatch through the normal gate.
      try {
        const { createTask } = await import("@/lib/friday/repo");
        const { dispatchTask } = await import("@/lib/friday/orchestrator");
        const task = await createTask({
          projectId: p.id,
          title: `[Deps] ${repoName} weekly patch bumps`,
          description: prompt,
          assignee: "devops",
          risk: "medium",
          requestedBy: OWNER,
          requestOrigin: "scheduler", // OS-scheduled dep sweep — owner-sanctioned standing work (2026-09)
        });
        const res = await dispatchTask(task.id);
        if (res.run) {
          out.push({ ...entry, outcome: "dispatched", taskId: task.id, runId: res.run.id });
        } else if (res.approval) {
          out.push({ ...entry, outcome: "queued", taskId: task.id, approvalId: res.approval.id });
        } else {
          out.push({ ...entry, outcome: "error", reason: res.error ?? "no run/approval" });
        }
        await logEvent(
          "dep_sweep.sent",
          { project: p.name, repo: repoName, taskId: task.id, runId: res.run?.id, approvalId: res.approval?.id },
        ).catch(() => {});
      } catch (e) {
        out.push({ ...entry, outcome: "error", reason: String(e instanceof Error ? e.message : e).slice(0, 160) });
        await logEvent(
          "dep_sweep.error",
          { project: p.name, repo: repoName, error: String(e).slice(0, 200) },
          { level: "warn" },
        ).catch(() => {});
      }
    }
  }
  return out;
}

/** Marker used by the scheduler job note. */
export function summarizeDepSweep(rs: DepSweepEntry[]): string {
  const by = (o: DepSweepEntry["outcome"]) => rs.filter((r) => r.outcome === o).length;
  return `${rs.length} repo(s): ${by("dispatched")} dispatched · ${by("queued")} queued · ${by("shadow")} shadow · ${by("skipped")} skipped · ${by("error")} error`;
}
