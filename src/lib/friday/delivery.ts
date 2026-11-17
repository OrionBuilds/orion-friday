// FRIDAY delivery — gives the coding agents a REAL working directory per project so they
// operate on the actual client repo (read/edit/git/gh/netlify/supabase), not a throwaway
// scratch. Cloning uses the user's own git auth. Pushes/deploys still pass FRIDAY's approval
// gate (risk classifier flags deploy/push/merge). Falls back gracefully when no repo is set.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logEvent } from "@/lib/persistence/store";
import { projectRepos } from "@/lib/friday/types";
import type { Project, AgentRole, Task } from "@/lib/friday/types";

const WORKSPACES_ROOT = path.join(os.homedir(), ".agentic-os", "friday", "workspaces");
// Rounds on an EXISTING PR branch (review comments, failing checks, conflicts — the PR shepherd)
// never run in the owner's checkout: those folders are their working directories, parked on their own
// branches, sometimes with uncommitted work. Each round gets a git worktree here instead.
const WORKTREES_ROOT = path.join(os.homedir(), ".agentic-os", "friday", "worktrees");

// Roles that should run inside the real repo.
const CODING_ROLES: AgentRole[] = ["architect", "dev", "devops", "qa", "debug", "designer"];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
}

// Folder name for a repo = its last path segment, slugged. Exported so the orchestrator can
// name each subfolder to the agent.
export function repoDirName(url: string): string {
  const last = url.replace(/\.git$/, "").replace(/\/+$/, "").split("/").pop() || "repo";
  return slug(last);
}

// Map each repo URL → a unique subfolder name. When two repos share a last segment (e.g. the
// same repo name under two owners), disambiguate with the owner: <owner>-<repo>.
export function repoDirNames(urls: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const u of urls) { const b = repoDirName(u); counts.set(b, (counts.get(b) ?? 0) + 1); }
  const out = new Map<string, string>();
  for (const u of urls) {
    const base = repoDirName(u);
    if ((counts.get(base) ?? 0) > 1) {
      const owner = u.replace(/\.git$/, "").split("/").slice(-2, -1)[0] ?? "";
      out.set(u, slug(`${owner}-${base}`));
    } else out.set(u, base);
  }
  return out;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === "win32" });
    let out = "";
    const to = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout?.on("data", (b) => (out += b));
    child.stderr?.on("data", (b) => (out += b));
    child.on("close", (code) => { clearTimeout(to); resolve({ ok: code === 0, out }); });
    child.on("error", (e) => { clearTimeout(to); resolve({ ok: false, out: String(e) }); });
  });
}

// ── One git writer per checkout ──────────────────────────────────────────────
// Two runs dispatched together (a dev task and its QA task, say) both fetched the same base checkout
// at once; git updates refs/remotes/origin/<branch> under a lock, so the loser died with "cannot lock
// ref … is at X but expected Y" and its whole run was refused (2026-11-12, initech-box, seconds after a
// PR merged). Fetches and worktree changes on one checkout now run one at a time, and a fetch that
// loses a race with something outside this process (the owner's own git, an editor) is retried.

const repoQueues = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call for the same checkout has settled (in-process, FIFO). */
export function withRepoLock<T>(baseDir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(baseDir);
  const prev = repoQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  repoQueues.set(key, tail);
  void tail.then(() => { if (repoQueues.get(key) === tail) repoQueues.delete(key); });
  return next;
}

/** A git failure that is about timing or the network, not about the repo: worth another try. Pure. */
export function isTransientGitFailure(out: string): boolean {
  return /cannot lock ref|unable to (?:create|lock)|\.lock': File exists|Another git process|index\.lock|unable to update local ref|Could not resolve host|Connection (?:timed out|reset|refused)|early EOF|unexpected disconnect|RPC failed|HTTP 5\d\d|returned error: 5\d\d|gnutls_handshake|TLS connection|SSL_|timed out|remote end hung up/i.test(out);
}

export interface FetchDeps { run: typeof run; sleep: (ms: number) => Promise<void> }
const fetchDeps: FetchDeps = { run, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * `git fetch origin <ref>` in a checkout, up to three tries when the failure is transient. A fetch that
 * lost a ref-lock race usually means another fetch just brought the same commits in, so the retry is
 * cheap. Anything else (no such branch, no access) fails at once with git's own words.
 */
export async function fetchOrigin(baseDir: string, ref: string, deps: FetchDeps = fetchDeps): Promise<{ ok: boolean; out: string; tries: number }> {
  let last = { ok: false, out: "" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await deps.run("git", ["fetch", "origin", ref], baseDir, 120_000);
    if (last.ok || !isTransientGitFailure(last.out)) return { ...last, tries: attempt };
    if (attempt < 3) await deps.sleep(attempt * 2_000);
  }
  return { ...last, tries: 3 };
}

// Git needs an author identity to commit. A freshly `gh`-cloned repo (or a local folder) may have
// none, so `git commit` fails with "please tell me who you are". Set a repo-local FRIDAY identity
// only when neither the repo nor the user's global git config already provides one.
async function ensureGitIdentity(dir: string): Promise<void> {
  if (!existsSync(path.join(dir, ".git"))) return;
  const has = await run("git", ["config", "user.email"], dir, 10_000);
  if (has.ok && has.out.trim()) return; // already has an identity (repo-local or global)
  // Identity is config, never a hardcoded org address (2026-10-28 audit; public-template rule):
  // FRIDAY_GIT_AUTHOR_* (AGENTIC_OS_GIT_* kept as aliases), else FRIDAY's own OS identity email.
  const name = process.env.FRIDAY_GIT_AUTHOR_NAME || process.env.AGENTIC_OS_GIT_NAME || "FRIDAY";
  const email = process.env.FRIDAY_GIT_AUTHOR_EMAIL || process.env.AGENTIC_OS_GIT_EMAIL || process.env.ORION_EXPECTED_EMAIL || "";
  if (!email) {
    await logEvent("delivery.git_identity_unset", { dir, note: "set FRIDAY_GIT_AUTHOR_EMAIL — commits in this repo will fail until then" }, { level: "warn" }).catch(() => {});
    return;
  }
  await run("git", ["config", "user.name", name], dir, 10_000);
  await run("git", ["config", "user.email", email], dir, 10_000);
}

// Ensure a per-project workspace exists. Each attached repo is cloned into its own subfolder
// under the project dir (so multi-repo projects keep every repo side by side);
// the PARENT dir is returned as the agent's cwd. Cloning uses `gh` so PRIVATE repos work
// non-interactively. Falls back to an empty scratch dir when the project has no repos.
export async function ensureWorkspace(project: Project): Promise<string> {
  // Local project: an explicit workspaceDir is a REAL folder on disk (e.g. ~/projects/FRIDAY). Use it
  // exactly as-is — never clone, pull, move, or delete. Agents run directly in it.
  if (project.workspaceDir) {
    if (!existsSync(project.workspaceDir)) await mkdir(project.workspaceDir, { recursive: true }).catch(() => {});
    await ensureGitIdentity(project.workspaceDir);
    return project.workspaceDir;
  }
  const parent = path.join(WORKSPACES_ROOT, slug(project.name));
  await mkdir(WORKSPACES_ROOT, { recursive: true }).catch(() => {});
  const repos = projectRepos(project);

  // No repos → scratch dir the agent can build in.
  if (repos.length === 0) {
    if (!existsSync(parent)) await mkdir(parent, { recursive: true }).catch(() => {});
    return parent;
  }

  // Legacy layout: a single repo already cloned flat at parent/.git — keep pulling it in place
  // (no destructive re-clone/move). Only new/multi-repo projects use the nested layout below.
  if (repos.length === 1 && existsSync(path.join(parent, ".git"))) {
    await run("git", ["pull", "--ff-only"], parent, 60_000).catch(() => {});
    await ensureGitIdentity(parent);
    return parent;
  }

  // Nested layout: one subfolder per repo.
  await mkdir(parent, { recursive: true }).catch(() => {});
  const names = repoDirNames(repos);
  for (const url of repos) {
    const dir = path.join(parent, names.get(url)!);
    if (!existsSync(path.join(dir, ".git"))) {
      // `gh repo clone` uses gh's stored auth → private repos clone without a TTY prompt.
      const res = await run("gh", ["repo", "clone", url, dir], parent, 180_000);
      await logEvent("delivery.clone", { project: project.name, url, ok: res.ok }, { projectId: project.id, level: res.ok ? "info" : "warn" });
    } else {
      await run("git", ["pull", "--ff-only"], dir, 60_000).catch(() => {});
    }
    await ensureGitIdentity(dir);
  }
  return parent;
}

// Resolve where each of a project's repos lives on disk WITHOUT cloning/pulling — used after a
// run to inspect what the agent changed (git diff/log). Mirrors ensureWorkspace's layout logic.
export function projectRepoDirs(project: Project): { url: string; dir: string }[] {
  // Local project: the folder itself is the checkout — only diffable if it's a git repo.
  if (project.workspaceDir) {
    return existsSync(path.join(project.workspaceDir, ".git")) ? [{ url: project.workspaceDir, dir: project.workspaceDir }] : [];
  }
  const parent = path.join(WORKSPACES_ROOT, slug(project.name));
  const repos = projectRepos(project);
  if (repos.length === 1 && existsSync(path.join(parent, ".git"))) return [{ url: repos[0], dir: parent }];
  const names = repoDirNames(repos);
  return repos.map((u) => ({ url: u, dir: path.join(parent, names.get(u)!) }));
}

// True when a project's local folder IS FRIDAY's own running source (e.g. the app cwd).
// Used to warn the operator that agent edits will hot-reload / can disrupt the live server.
export function isSelfSourceDir(dir?: string): boolean {
  try { return !!dir && path.resolve(dir) === path.resolve(process.cwd()); } catch { return false; }
}

function sameRepo(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase().replace(/^git@github\.com:/, "https://github.com/");
  return norm(a) === norm(b) || norm(a).endsWith("/" + norm(b).split("/").slice(-2).join("/"));
}

/** The local checkout that can serve as the worktree's parent for a repo url (owner dir or clone). */
export function localCheckoutFor(project: Project, repoUrl: string): string | null {
  for (const d of projectRepoDirs(project)) {
    if (!existsSync(path.join(d.dir, ".git"))) continue;
    if (d.url === repoUrl || sameRepo(d.url, repoUrl)) return d.dir;
  }
  // A local project folder may be the repo itself even if its recorded url differs.
  if (project.workspaceDir && existsSync(path.join(project.workspaceDir, ".git"))) return project.workspaceDir;
  return null;
}

export interface PrWorktree { dir: string; headRef: string; created: boolean }

/**
 * A git worktree checked out on `origin/<headRef>` for a round on an existing PR. The ONLY command
 * ever run inside the owner's checkout is `git fetch origin <headRef>`; the worktree itself lives
 * under ~/.agentic-os/friday/worktrees. The worktree branch is `shepherd/<headRef>` tracking
 * origin/<headRef>, so `git push origin HEAD:<headRef>` lands on the PR even when the owner has the
 * same branch checked out elsewhere (git refuses to check out one branch in two worktrees).
 */
export async function prWorktree(project: Project, repoUrl: string, headRef: string): Promise<PrWorktree> {
  const base = localCheckoutFor(project, repoUrl) ?? (await ensureWorkspace(project));
  const baseDir = existsSync(path.join(base, ".git")) ? base : (projectRepoDirs(project).find((d) => sameRepo(d.url, repoUrl))?.dir ?? base);
  const dir = path.join(WORKTREES_ROOT, repoDirName(repoUrl), slug(headRef));
  await mkdir(path.dirname(dir), { recursive: true }).catch(() => {});
  const local = `shepherd/${headRef}`;
  const created = await withRepoLock(baseDir, async () => {
    const fetched = await fetchOrigin(baseDir, headRef);
    if (!fetched.ok) throw new Error(`git fetch origin ${headRef} failed: ${fetched.out.slice(0, 200)}`);
    if (existsSync(path.join(dir, ".git"))) {
      const r = await run("git", ["reset", "--hard", `origin/${headRef}`], dir, 60_000);
      if (!r.ok) throw new Error(`worktree reset failed: ${r.out.slice(0, 200)}`);
      return false;
    }
    // A stale registration (dir deleted by hand) blocks `worktree add` — prune first.
    await run("git", ["worktree", "prune"], baseDir, 30_000);
    await run("git", ["branch", "-D", local], baseDir, 30_000); // leftover from an aborted round; harmless if absent
    const r = await run("git", ["worktree", "add", "-b", local, dir, `origin/${headRef}`], baseDir, 120_000);
    if (!r.ok) throw new Error(`worktree add failed: ${r.out.slice(0, 200)}`);
    return true;
  });
  await run("git", ["branch", `--set-upstream-to=origin/${headRef}`], dir, 30_000);
  await ensureGitIdentity(dir);
  await logEvent("delivery.worktree", { project: project.name, repo: repoUrl, headRef, dir, created }, { projectId: project.id });
  return { dir, headRef, created };
}

export async function removeWorktree(project: Project, repoUrl: string, headRef: string): Promise<void> {
  const base = localCheckoutFor(project, repoUrl);
  const dir = path.join(WORKTREES_ROOT, repoDirName(repoUrl), slug(headRef));
  if (base) {
    await run("git", ["worktree", "remove", "--force", dir], base, 60_000);
    await run("git", ["branch", "-D", `shepherd/${headRef}`], base, 30_000);
    await run("git", ["worktree", "prune"], base, 30_000);
  }
}

// ── Fresh-task worktrees ─────────────────────────────────────────────────────
// A NEW task (no PR yet) never runs in the owner's checkout either. Those folders are their working
// directories — parked on whatever branch they last used, sometimes with uncommitted work (umbrella-api
// had 128 modified files) — so a task started there builds on the wrong code. Each fresh task gets
// its own worktree cut from origin/<default>, on a branch FRIDAY names up front. The ONLY command run
// in the owner's checkout is `git fetch origin <default>`.

/** True for any directory FRIDAY created under ~/.agentic-os/friday/worktrees (task or PR round). */
export function isWorktreeDir(dir?: string | null): boolean {
  if (!dir) return false;
  const rel = path.relative(WORKTREES_ROOT, path.resolve(dir));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Branch + folder names for a fresh task's worktree (pure — tests and post-run inspection). */
export function taskWorktreeNames(repoUrl: string, task: Pick<Task, "id" | "title">, prefix: Project["branchPrefix"] = "friday"): { branch: string; dir: string } {
  const id8 = task.id.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "task";
  const titleSlug = slug(task.title || "task").slice(0, 40).replace(/-+$/g, "") || "task";
  return {
    branch: `${prefix === "friday-work" ? "friday-work" : "friday"}/${titleSlug}-${id8}`,
    dir: path.join(WORKTREES_ROOT, repoDirName(repoUrl), `task-${titleSlug}-${id8}`),
  };
}

/** origin's default branch for a checkout. The remote is the source of truth: `git fetch` never
 *  updates refs/remotes/origin/HEAD, so after a default-branch rename the local symref goes stale.
 *  Order: ls-remote --symref origin HEAD, then the local symref, then main/master. */
export function parseSymrefHead(out: string): string | null {
  const m = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD\s*$/m);
  return m ? m[1] : null;
}
async function defaultBranchOf(baseDir: string): Promise<string> {
  const remote = await run("git", ["ls-remote", "--symref", "origin", "HEAD"], baseDir, 30_000);
  const live = remote.ok ? parseSymrefHead(remote.out) : null;
  if (live) return live;
  const head = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], baseDir, 15_000);
  if (head.ok && head.out.trim().startsWith("origin/")) return head.out.trim().slice("origin/".length);
  for (const b of ["main", "master"]) {
    const r = await run("git", ["ls-remote", "--exit-code", "--heads", "origin", b], baseDir, 30_000);
    if (r.ok) return b;
  }
  return "main";
}

/** Is the task behind a worktree named `task-…-<id8>` closed? Only when exactly ONE task matches the
 *  eight-character prefix and that task is closed: a missing or ambiguous match keeps the worktree. */
export function worktreeTaskClosed(id8: string, tasks: Array<{ id: string; status: string }>, closed: (s: string) => boolean): boolean {
  if (!id8 || id8 === "task") return false;
  const matches = tasks.filter((x) => x.id.replace(/[^a-z0-9]/gi, "").toLowerCase().startsWith(id8.toLowerCase()));
  return matches.length === 1 && closed(matches[0].status);
}

export interface TaskWorktree { dir: string; branch: string; baseBranch: string; created: boolean }

/**
 * A worktree for a fresh task, cut from origin/<default> on branch `friday/<title-slug>-<id8>`.
 * Re-dispatching the same task reuses the existing worktree (its work in progress is kept).
 */
export async function taskWorktree(project: Project, repoUrl: string, task: Pick<Task, "id" | "title">): Promise<TaskWorktree> {
  const owned = localCheckoutFor(project, repoUrl);
  const baseDir = owned ?? (projectRepoDirs(project).find((d) => sameRepo(d.url, repoUrl))?.dir ?? (await ensureWorkspace(project)));
  if (!existsSync(path.join(baseDir, ".git"))) throw new Error(`no git checkout for ${repoUrl}`);
  const { branch, dir } = taskWorktreeNames(repoUrl, task, project.branchPrefix);
  if (existsSync(path.join(dir, ".git"))) {
    await ensureGitIdentity(dir);
    return { dir, branch, baseBranch: "", created: false };
  }
  const baseBranch = await defaultBranchOf(baseDir);
  await mkdir(path.dirname(dir), { recursive: true }).catch(() => {});
  const created = await withRepoLock(baseDir, async () => {
    // The same task dispatched twice at once: the first call made the worktree while this one waited.
    if (existsSync(path.join(dir, ".git"))) return false;
    const fetched = await fetchOrigin(baseDir, baseBranch);
    if (!fetched.ok) throw new Error(`git fetch origin ${baseBranch} failed: ${fetched.out.slice(0, 200)}`);
    await run("git", ["worktree", "prune"], baseDir, 30_000);
    const r = await run("git", ["worktree", "add", "-B", branch, dir, `origin/${baseBranch}`], baseDir, 120_000);
    if (!r.ok) throw new Error(`worktree add failed: ${r.out.slice(0, 200)}`);
    return true;
  });
  if (!created) {
    await ensureGitIdentity(dir);
    return { dir, branch, baseBranch: "", created: false };
  }
  // The new branch must not track origin/<default> (a bare `git push` would then push to main).
  await run("git", ["branch", "--unset-upstream"], dir, 15_000);
  await ensureGitIdentity(dir);
  await logEvent("delivery.task_worktree", { project: project.name, repo: repoUrl, branch, baseBranch, dir }, { projectId: project.id });
  return { dir, branch, baseBranch, created: true };
}

/** Which repo a single-repo task works on; null for multi-repo projects (they keep FRIDAY's own clones). */
export function taskRepoFor(project: Pick<Project, "workspaceDir" | "repoUrl" | "repoUrls">): string | null {
  const repos = projectRepos(project);
  if (repos.length === 1) return repos[0];
  if (repos.length === 0 && project.workspaceDir && existsSync(path.join(project.workspaceDir, ".git"))) return project.workspaceDir;
  return null;
}

/**
 * Remove worktrees nobody has touched in `maxAgeDays`: fresh-task worktrees whose task is closed,
 * and PR-round worktrees whose branch is gone from origin (merged or closed with delete). Never
 * removes a worktree with uncommitted changes. Returns the number removed.
 */
export async function sweepWorktrees(opts: { maxAgeDays?: number; isTaskClosed: (id8: string) => Promise<boolean> }): Promise<number> {
  const maxAgeMs = (opts.maxAgeDays ?? 7) * 24 * 60 * 60 * 1000;
  let removed = 0;
  const repos = await readdir(WORKTREES_ROOT).catch(() => [] as string[]);
  for (const repo of repos) {
    const entries = await readdir(path.join(WORKTREES_ROOT, repo)).catch(() => [] as string[]);
    for (const name of entries) {
      const dir = path.join(WORKTREES_ROOT, repo, name);
      if (!existsSync(path.join(dir, ".git"))) continue;
      const st = await stat(dir).catch(() => null);
      const head = await run("git", ["log", "-1", "--format=%ct", "HEAD"], dir, 15_000);
      const lastMs = Math.max(st?.mtimeMs ?? 0, head.ok ? Number(head.out.trim()) * 1000 : 0);
      if (Date.now() - lastMs < maxAgeMs) continue;
      const dirty = await run("git", ["status", "--porcelain"], dir, 20_000);
      if (!dirty.ok || dirty.out.trim()) continue;
      // Committed-but-unpushed work: status is clean, but the commits exist only on this branch.
      // Removing the worktree and deleting the branch would orphan them, so keep it.
      const unpushed = await run("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], dir, 20_000);
      if (!unpushed.ok || Number(unpushed.out.trim()) > 0) continue;
      let eligible = false;
      const m = name.match(/^task-.*-([a-z0-9]{1,8})$/);
      if (m) eligible = await opts.isTaskClosed(m[1]);
      else {
        const br = await run("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], dir, 15_000);
        const remoteBranch = br.ok ? br.out.trim().replace(/^origin\//, "") : "";
        if (remoteBranch) eligible = !(await run("git", ["ls-remote", "--exit-code", "--heads", "origin", remoteBranch], dir, 30_000)).ok;
      }
      if (!eligible) continue;
      const common = await run("git", ["rev-parse", "--git-common-dir"], dir, 15_000);
      const baseDir = common.ok ? path.dirname(path.resolve(dir, common.out.trim())) : dir;
      const branch = (await run("git", ["branch", "--show-current"], dir, 15_000)).out.trim();
      const rm = await run("git", ["worktree", "remove", "--force", dir], baseDir, 60_000);
      if (rm.ok) {
        if (branch && m) await run("git", ["branch", "-D", branch], baseDir, 30_000);
        removed++;
        await logEvent("delivery.worktree_removed", { dir, branch });
      }
    }
  }
  return removed;
}

/** Where a round on a PR branch runs, without creating anything (for post-run inspection). */
export function prWorktreeDir(repoUrl: string, headRef: string): string {
  return path.join(WORKTREES_ROOT, repoDirName(repoUrl), slug(headRef));
}

// The cwd an agent should run in for a task: the real repo workspace for coding roles on a
// project, else undefined (agent runs in its default scratch). A task that carries `prUrl` +
// `prHeadRef` (a shepherd round) runs in a worktree on that PR's branch instead.
// Which kind of workspace a coding run gets (pure — tested). Order: an existing PR's branch; a fresh
// single-repo task → its own worktree; a multi-repo project → FRIDAY's own clones; no repo → scratch.
export type WorkspaceKind = "none" | "pr-worktree" | "task-worktree" | "clones" | "scratch";
export function workspaceKindFor(
  role: AgentRole,
  project: Pick<Project, "workspaceDir" | "repoUrl" | "repoUrls"> | null,
  task?: Pick<Task, "id" | "prUrl" | "prHeadRef"> | null,
): WorkspaceKind {
  if (!project || !CODING_ROLES.includes(role)) return "none";
  if (task?.prUrl && task.prHeadRef) return "pr-worktree";
  const repos = projectRepos(project);
  if (task?.id && taskRepoFor(project)) return "task-worktree";
  if (repos.length > 1) return "clones";
  return "scratch";
}

export async function deliveryCwd(role: AgentRole, project: Project | null, task?: Pick<Task, "id" | "title" | "prUrl" | "prHeadRef"> | null): Promise<string | undefined> {
  const kind = workspaceKindFor(role, project, task);
  if (kind === "none" || !project) return undefined;
  if (kind === "pr-worktree") {
    const repoUrl = projectRepos(project).find((u) => task!.prUrl!.toLowerCase().startsWith(u.replace(/\.git$/, "").toLowerCase())) ?? projectRepos(project)[0] ?? taskRepoFor(project);
    if (repoUrl) {
      try { return (await prWorktree(project, repoUrl, task!.prHeadRef!)).dir; }
      catch (e) { await logEvent("delivery.worktree_failed", { prUrl: task!.prUrl, error: String(e).slice(0, 200) }, { level: "warn", projectId: project.id }); return undefined; }
    }
  }
  if (kind === "task-worktree") {
    const repoUrl = taskRepoFor(project)!;
    try { return (await taskWorktree(project, repoUrl, { id: task!.id, title: task!.title ?? "task" })).dir; }
    catch (e) {
      // Never fall back to the owner's checkout — an unrecorded run in their working folder is the bug
      // this replaced. A failed worktree means the run gets no repo and says so (no-change → revisions).
      await logEvent("delivery.task_worktree_failed", { task: task!.id, repo: repoUrl, error: String(e).slice(0, 300) }, { level: "warn", projectId: project.id });
      return undefined;
    }
  }
  try { return await ensureWorkspace(project); } catch { return undefined; }
}
