// Live wiring for the project-knowledge updater (projectKnowledgeUpdater.ts): the OS tools, a read-only
// git checkout, one tool-less model call and the daily token ledger. The logic stays in the updater so
// it is unit-testable without git, the OS or an engine.
//
// Nothing here runs unless FRIDAY_PROJECT_KNOWLEDGE=on; the weekly job and the owner's Refresh button
// both check knowledgeEnabled() first.
//
// Checkout safety (same rule as delivery.ts): the ONLY command run inside the owner's own checkout is
// `git fetch`; the code is read through a detached worktree under ~/.agentic-os/friday/worktrees that
// is removed afterwards. The model is never given the worktree (no cwd, no tools) — it sees a scrubbed
// text diff only.

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dial } from "@/lib/friday/dials";
import { localCheckoutFor, repoDirName } from "@/lib/friday/delivery";
import { completeWithMeta, extractJSON } from "@/lib/friday/engines";
import { guardWorkspace } from "@/lib/friday/wormGuard";
import { callOsTool } from "@/lib/friday/osTool";
import { FRIDAY_DATA_DIR, logEvent, store } from "@/lib/persistence/store";
import { projectRepos, type Project } from "@/lib/friday/types";
import {
  fileTokenLedger, moduleTokenCap, runKnowledgeUpdate,
  type ChangedFile, type UpdateReport, type UpdaterDeps,
} from "@/lib/friday/projectKnowledgeUpdater";
import { runKnowledgeExplore, type ExplorerCheckout, type ExplorerDeps, type ExploreReport, type RepoFile } from "@/lib/friday/projectKnowledgeExplorer";

const WORKTREES_ROOT = path.join(os.homedir(), ".agentic-os", "friday", "worktrees");

function git(args: string[], cwd: string, timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || stderr || "") });
    });
  });
}

/** Pure. `git diff --numstat` output → changed files (binary files report "-" and count as 0 lines). */
export function parseNumstat(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    let file = m[3];
    const rename = file.match(/^(.*)\{.* => (.*)\}(.*)$/) ?? null; // a/{b => c}/d
    if (rename) file = `${rename[1]}${rename[2]}${rename[3]}`.replace(/\/\//g, "/");
    else if (file.includes(" => ")) file = file.split(" => ").pop()!;
    files.push({ file, added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return files;
}

/** Pure. `git ls-tree -r -l -z` output → tracked regular files with sizes (symlinks and submodules are skipped). */
export function parseLsTree(out: string): RepoFile[] {
  const files: RepoFile[] = [];
  for (const rec of out.split("\0")) {
    const m = rec.match(/^(\d{6}) (\w+) [0-9a-f]+ +(\d+|-)\t([\s\S]+)$/);
    if (!m || m[2] !== "blob" || m[1] === "120000") continue;
    files.push({ file: m[4], bytes: Number(m[3]) });
  }
  return files;
}

const MAX_MANIFEST_BYTES = 64 * 1024;

async function readOnlyCheckout(project: Project, repoUrl: string): Promise<ExplorerCheckout | null> {
  const base = localCheckoutFor(project, repoUrl);
  if (!base) return null;
  await git(["fetch", "--quiet", "origin"], base, 120_000); // the only command run in the owner's checkout
  let ref = "";
  for (const r of ["origin/HEAD", "origin/main", "origin/master"]) {
    if ((await git(["rev-parse", "--verify", "--quiet", `${r}^{commit}`], base)).ok) { ref = r; break; }
  }
  if (!ref) return null;
  const head = (await git(["rev-parse", ref], base)).out.trim();
  if (!head) return null;
  const dir = path.join(WORKTREES_ROOT, repoDirName(repoUrl || project.name), `knowledge-${Date.now()}`);
  await git(["worktree", "prune"], base);
  const add = await git(["worktree", "add", "--detach", dir, head], base, 120_000);
  if (!add.ok) return null;
  return {
    dir,
    head,
    changed: async (from, to) => {
      const known = await git(["cat-file", "-e", `${from}^{commit}`], dir);
      if (!known.ok) throw new Error(`commit ${from.slice(0, 8)} not found`);
      const r = await git(["diff", "--numstat", "--no-color", `${from}..${to}`], dir, 120_000);
      if (!r.ok) throw new Error("git diff failed");
      return parseNumstat(r.out);
    },
    diff: async (from, to, files) => {
      const r = await git(["diff", "--no-color", "--unified=2", `${from}..${to}`, "--", ...files], dir, 120_000);
      return r.ok ? r.out : "";
    },
    cleanup: async () => {
      await git(["worktree", "remove", "--force", dir], base, 60_000);
      await git(["worktree", "prune"], base);
    },
    listFiles: async () => {
      const r = await git(["ls-tree", "-r", "-l", "-z", head], dir, 120_000);
      return r.ok ? parseLsTree(r.out) : [];
    },
    readText: async (rel) => {
      // Manifests only, regular files inside the worktree, size-limited (never follows a symlink out).
      const full = path.resolve(dir, rel);
      if (!full.startsWith(dir + path.sep)) return null;
      try {
        const st = await fsp.lstat(full);
        if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null;
        return await fsp.readFile(full, "utf8");
      } catch { return null; }
    },
    isAncestor: async (a, b) => (await git(["merge-base", "--is-ancestor", a, b], dir)).ok,
    guard: async () => {
      const g = await guardWorkspace({ cwd: dir, repoUrls: repoUrl ? [repoUrl] : projectRepos(project), source: "run", projectId: project.id });
      return g.kind === "clean" ? { ok: true } : { ok: false, reason: g.reason };
    },
  };
}

/** Rough token estimate (~4 chars/token) — the CLI engines don't hand usage back to the caller. */
export const estimateTokens = (...texts: string[]): number => Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);

export function dailyTokenCap(): number {
  const n = Number(dial("knowledge_daily_tokens"));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function liveUpdaterDeps(project: Project): UpdaterDeps {
  return {
    call: async (name, args) => {
      const r = await callOsTool(name, args, { context: { for: "project-knowledge-update" } });
      return r.ok ? { ok: true, data: r.data } : { ok: false, missing: r.missing, error: r.error };
    },
    checkout: ({ repoUrl }) => readOnlyCheckout(project, repoUrl),
    rewrite: async ({ system, prompt, projectId }) => {
      // No cwd, no os, no write: the model has no tools and cannot touch the filesystem or network.
      const res = await completeWithMeta({ system, prompt, json: true, timeoutMs: 240_000, agentRole: "knowledge", projectId: project.id });
      return { json: extractJSON(res.text), tokens: estimateTokens(system, prompt, res.text) };
    },
    ledger: fileTokenLedger(path.join(FRIDAY_DATA_DIR, "knowledgeTokens.json")),
    dailyCap: dailyTokenCap,
    moduleCap: () => moduleTokenCap(),
    log: async (event, data) => { await logEvent(event, data ?? {}); },
  };
}

/** The cold-start explorer's wiring: same OS tools, checkout and ledger as the updater; the model reads files, read-only. */
export function liveExplorerDeps(project: Project): ExplorerDeps {
  const u = liveUpdaterDeps(project);
  return {
    call: u.call,
    checkout: ({ repoUrl }) => readOnlyCheckout(project, repoUrl),
    explore: async ({ system, prompt, cwd, timeoutMs }) => {
      let real = 0;
      // Claude only: its allow/deny list is what makes the file access read-only. cwd is the detached worktree.
      const res = await completeWithMeta({
        system, prompt, json: true, engine: "claude", cwd, readOnlyFiles: true, timeoutMs, agentRole: "knowledge", projectId: project.id,
        usageSink: (x) => { real = x.tokensTotal ?? ((x.tokensIn ?? 0) + (x.tokensOut ?? 0)); },
      });
      // Reading files costs far more than the prompt text, and not every engine reports usage: never count less
      // than half the per-module cap, so the daily cap protects the budget even when usage is unknown.
      return { json: extractJSON(res.text), tokens: real > 0 ? real : Math.max(estimateTokens(system, prompt, res.text), Math.floor(moduleTokenCap() / 2)) };
    },
    write: u.rewrite,
    ledger: u.ledger,
    dailyCap: u.dailyCap,
    moduleCap: u.moduleCap,
    log: u.log,
  };
}

export interface ProjectRefresh { project: string; repo: string; report: UpdateReport; explore?: ExploreReport }

/** Cold start for one repo: explore (or, in dry-run, list the modules and the estimated cost). */
export async function exploreLocalRepo(
  project: Project,
  osProjectId: string,
  repoUrl: string,
  opts: { dryRun?: boolean; slugs?: string[] | null; reason?: string } = {},
): Promise<ExploreReport> {
  return runKnowledgeExplore(liveExplorerDeps(project), { projectId: osProjectId, repoUrl, repoName: project.name, projectContext: [project.description, project.stack].filter(Boolean).join(" — "), ...opts });
}

/** Map an explore report onto the updater's report shape so callers and summaries treat both alike. */
export function exploreAsUpdateReport(x: ExploreReport): UpdateReport {
  return {
    status: x.status, dryRun: x.dryRun, reason: x.reason, head: x.head, rewritten: x.explored,
    stale: [], refused: x.refused, uncovered: [], tokens: x.tokens,
    ...(x.dryRun ? { wouldRewrite: x.modules.filter((m) => m.state === "todo").map((m) => m.slug), wouldMarkStale: [] } : {}),
  };
}

/** Refresh every repo of one local project that is linked to the OS. */
export async function refreshLocalProject(
  project: Project,
  osProjectId: string,
  opts: { dryRun?: boolean; slugs?: string[] | null; reason?: string } = {},
): Promise<ProjectRefresh[]> {
  const out: ProjectRefresh[] = [];
  const repos = projectRepos(project);
  const list = repos.length ? repos : [""];
  for (const repoUrl of list) {
    const scoped = list.length > 1 ? repoUrl : "";
    const report = await runKnowledgeUpdate(liveUpdaterDeps(project), { projectId: osProjectId, repoUrl: scoped, ...opts });
    if (report.firstRefresh) {
      // No notes yet: build them (module by module, resumable under the daily cap).
      const ex = await exploreLocalRepo(project, osProjectId, scoped, { ...opts, slugs: null }); // no notes yet: explore it all
      out.push({ project: project.name, repo: repoUrl, report: exploreAsUpdateReport(ex), explore: ex });
      continue;
    }
    out.push({ project: project.name, repo: repoUrl, report });
  }
  return out;
}

/** The weekly sweep: every OS-linked project that has a repo. `dryRun` reports the plan and writes nothing. */
export async function sweepKnowledge(opts: { dryRun: boolean; reason?: string }): Promise<{ summary: string; result: Record<string, unknown> }> {
  const { osProjectMap } = await import("@/lib/friday/portalUpdates");
  const map = await osProjectMap();
  const projects = (await store.projects.all()).filter((p) => {
    const first = projectRepos(p)[0];
    return map.has(p.id) && Boolean(first) && localCheckoutFor(p, first) !== null;
  });
  const results: ProjectRefresh[] = [];
  for (const p of projects) {
    try { results.push(...(await refreshLocalProject(p, map.get(p.id)!, opts))); }
    catch (e) { await logEvent("knowledge.sweep_error", { project: p.name, e: String(e).slice(0, 200) }); }
  }
  const n = (f: (r: UpdateReport) => number) => results.reduce((s, r) => s + f(r.report), 0);
  const skipped = results.filter((r) => r.report.status === "skipped").length;
  const first = results.filter((r) => r.explore);
  const updated = results.filter((r) => !r.explore);
  const nu = (f: (r: UpdateReport) => number) => updated.reduce((s, r) => s + f(r.report), 0);
  const exploreText = first.length
    ? (opts.dryRun
      ? ` ${first.length} repo(s) need a first exploration (${first.reduce((s, r) => s + (r.explore?.remaining.length ?? 0), 0)} module(s), ~${first.reduce((s, r) => s + (r.explore?.estTokens ?? 0), 0)} tokens).`
      : ` First exploration: ${first.reduce((s, r) => s + (r.explore?.explored.length ?? 0), 0)} module note(s) written, ${first.reduce((s, r) => s + (r.explore?.remaining.length ?? 0), 0)} still to do (resumes next run).`)
    : "";
  const summary = (opts.dryRun
    ? `[dry run] knowledge: ${updated.length} repo(s) checked, ${nu((r) => r.wouldRewrite?.length ?? 0)} note(s) would be rewritten, ${nu((r) => r.wouldMarkStale?.length ?? 0)} marked stale, ${skipped - first.filter((r) => r.report.status === "skipped").length} skipped.`
    : `Knowledge: ${updated.length} repo(s) checked, ${nu((r) => r.rewritten.length)} note(s) rewritten, ${nu((r) => r.stale.length)} marked stale, ${skipped - first.filter((r) => r.report.status === "skipped").length} skipped, ~${n((r) => r.tokens)} tokens.`) + exploreText;
  return {
    summary,
    result: {
      repos: results.length,
      rewritten: nu((r) => r.rewritten.length), explored: first.reduce((s, r) => s + (r.explore?.explored.length ?? 0), 0), exploreRemaining: first.reduce((s, r) => s + (r.explore?.remaining.length ?? 0), 0), stale: n((r) => r.stale.length), skipped, tokens: n((r) => r.tokens),
      projects: results.slice(0, 30).map((r) => ({ project: r.project, status: r.report.status, reason: r.report.reason, rewritten: r.report.rewritten, stale: r.report.stale.length, uncovered: r.report.uncovered.length })),
    },
  };
}
