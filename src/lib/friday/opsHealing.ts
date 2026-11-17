// FRIDAY — ops self-healing (2026-10-02).
//
// The autodeploy script (ops/autodeploy/autodeploy.sh in the office repo) is a one-shot bash loop fired by a
// systemd user timer. Perfectly adequate when nothing goes wrong, but it has two silent-failure
// modes we hit today:
//
//   1. Someone (the owner, Claude Code, a scripted fix) pulls a repo by hand to catch up on merges.
//      autodeploy's `behind()` returns false the next tick because local already matches origin,
//      so no restart fires — the service keeps running whatever build was live before.
//   2. The timer itself drifts, or a user restart puts it in a strange state (timer waiting but
//      the service never runs after a system wake, etc.).
//
// autodeploy's own sha-stamp check closes #1 at the script level, but the belt-and-
// suspenders answer is to make FRIDAY herself own "the office is running the right build" — a
// scheduler job that compares each service's stamp vs HEAD and restarts stale ones directly, and
// a second job that nudges autodeploy on a 30-minute cadence so a stalled timer doesn't matter.
//
// A third sweep (daily) catches worktrees sitting on a feature branch for more than a week — the
// third silent-failure mode we hit today, where branches used for a one-off edit stayed checked
// out and blocked every subsequent deploy.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const exec = promisify(execFile);

/** autodeploy's stamp dir — the same files it writes after a successful restart. */
export const STAMPS_DIR = path.join(os.homedir(), ".agentic-os", "autodeploy", "stamps");
const COOLDOWN_FILE = path.join(os.homedir(), ".agentic-os", "friday", "ops-healing-cooldown.json");
/** No service is restarted twice inside this window — avoids a crash-loop with a broken build. */
export const RESTART_COOLDOWN_MS = 30 * 60_000;
/** A feature-branch checkout older than this becomes a nag. */
export const STALE_BRANCH_MS = 7 * 24 * 60 * 60_000;

/**
 * The service this process runs as. It is never restarted from in here: SIGTERM arrives before
 * the stamp or the cooldown is written, so the next boot sees the same stale stamp and restarts
 * again 20 seconds later (13 restarts in 4 minutes on 2026-11-12, until autodeploy stamped it).
 * A bare restart wouldn't run the new commit anyway, since nothing has built it. autodeploy does
 * the whole job: builds HEAD, waits for running agent work, restarts, stamps.
 */
export const SELF_SERVICE = "office-friday.service";

// Where the office checkouts live (FRIDAY_OFFICE_ROOT, default ~/office).
const LAB = process.env.FRIDAY_OFFICE_ROOT?.trim() || path.join(os.homedir(), "office");

export interface ServiceConfig { name: string; repo: string; branch: string }
export const OFFICE_SERVICES: readonly ServiceConfig[] = [
  { name: "office-clara.service", repo: `${LAB}/CLARA`, branch: "main" },
  { name: "office-friday.service", repo: `${LAB}/FRIDAY`, branch: "master" },
  { name: "office-app.service", repo: `${LAB}/office`, branch: "master" },
  { name: "office-os-mcp.service", repo: `${LAB}/orion`, branch: "main" },
];

async function gitHead(repo: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", repo, "rev-parse", "HEAD"], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch { return null; }
}

async function gitBranch(repo: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", repo, "branch", "--show-current"], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch { return null; }
}

async function gitClean(repo: string): Promise<boolean> {
  try {
    const r1 = await exec("git", ["-C", repo, "diff", "--quiet"], { timeout: 5_000 }).then(() => true).catch(() => false);
    const r2 = await exec("git", ["-C", repo, "diff", "--cached", "--quiet"], { timeout: 5_000 }).then(() => true).catch(() => false);
    return r1 && r2;
  } catch { return false; }
}

async function readStamp(service: string): Promise<string | null> {
  try { return (await fs.readFile(path.join(STAMPS_DIR, `${service}.sha`), "utf8")).trim() || null; }
  catch { return null; }
}

type CooldownMap = Record<string, number>;
async function readCooldowns(file = COOLDOWN_FILE): Promise<CooldownMap> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    const out: CooldownMap = {};
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch { return {}; }
}

async function writeCooldowns(c: CooldownMap, file = COOLDOWN_FILE): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  await fs.writeFile(file, JSON.stringify(c, null, 2), "utf8").catch(() => {});
}

export interface StalenessVerdict {
  name: string;
  stale: boolean;
  reason?: string;         // short label when stale is true OR when a stale service can't be touched
  headSha?: string;
  stampedSha?: string | null;
}

/** Pure logic (modulo fs/git) — one service's staleness verdict + why. */
export async function verdictFor(svc: ServiceConfig, now = Date.now(), cooldowns?: CooldownMap): Promise<StalenessVerdict> {
  const head = await gitHead(svc.repo);
  if (!head) return { name: svc.name, stale: false, reason: `can't read git HEAD for ${svc.repo}` };
  const stamped = await readStamp(svc.name);
  if (stamped === head) return { name: svc.name, stale: false, headSha: head, stampedSha: stamped };
  const branch = await gitBranch(svc.repo);
  if (branch !== svc.branch) {
    return { name: svc.name, stale: false, reason: `on ${branch ?? "no-branch"}, want ${svc.branch}`, headSha: head, stampedSha: stamped };
  }
  if (!(await gitClean(svc.repo))) {
    return { name: svc.name, stale: false, reason: "local edits to tracked files", headSha: head, stampedSha: stamped };
  }
  const since = cooldowns?.[svc.name];
  if (typeof since === "number" && now - since < RESTART_COOLDOWN_MS) {
    return { name: svc.name, stale: false, reason: `cooldown (${Math.floor((RESTART_COOLDOWN_MS - (now - since)) / 60_000)}m left)`, headSha: head, stampedSha: stamped };
  }
  return { name: svc.name, stale: true, headSha: head, stampedSha: stamped };
}

export interface SweepResult {
  restarted: string[];
  handedOff?: string[];                    // stale, left to autodeploy to build + restart (this process's own service)
  blocked: Array<{ name: string; reason: string }>;
  shaByService: Record<string, string>;   // what HEAD was at the time we restarted (for the SMS)
}

export interface SweepDeps {
  restart: (service: string) => Promise<void>;
  handOff: () => Promise<{ ok: boolean; error?: string }>;
  cooldownFile: string;
  self: string;
}

/**
 * Restart every service whose running stamp doesn't match HEAD. Writes a fresh stamp + records a
 * cooldown so a broken build doesn't loop. This process's own service is handed to autodeploy
 * instead (see SELF_SERVICE), with the cooldown saved first so it is asked once per window.
 */
export async function sweepStaleServices(services: readonly ServiceConfig[] = OFFICE_SERVICES, now = Date.now(), deps: Partial<SweepDeps> = {}): Promise<SweepResult> {
  const restart = deps.restart ?? (async (name: string) => { await exec("systemctl", ["--user", "restart", name], { timeout: 30_000 }); });
  const handOff = deps.handOff ?? triggerAutodeploy;
  const self = deps.self ?? SELF_SERVICE;
  const cooldowns = await readCooldowns(deps.cooldownFile);
  const out: SweepResult = { restarted: [], handedOff: [], blocked: [], shaByService: {} };
  for (const svc of services) {
    const v = await verdictFor(svc, now, cooldowns);
    if (!v.stale) {
      if (v.reason) out.blocked.push({ name: svc.name, reason: v.reason });
      continue;
    }
    if (svc.name === self) {
      cooldowns[svc.name] = now;
      await writeCooldowns(cooldowns, deps.cooldownFile);
      const r = await handOff();
      if (r.ok) out.handedOff!.push(svc.name);
      else out.blocked.push({ name: svc.name, reason: `auto-deploy didn't start: ${r.error ?? "unknown"}` });
      continue;
    }
    try {
      await restart(svc.name);
      if (v.headSha) {
        await fs.mkdir(STAMPS_DIR, { recursive: true }).catch(() => {});
        await fs.writeFile(path.join(STAMPS_DIR, `${svc.name}.sha`), v.headSha, "utf8").catch(() => {});
        out.shaByService[svc.name] = v.headSha;
      }
      cooldowns[svc.name] = now;
      out.restarted.push(svc.name);
    } catch (e) {
      out.blocked.push({ name: svc.name, reason: `restart failed: ${String((e as Error).message ?? e).slice(0, 120)}` });
    }
  }
  if (out.restarted.length) await writeCooldowns(cooldowns, deps.cooldownFile);
  return out;
}

/**
 * Clean up a worktree that's on a merged branch: switch to the default branch, pull, delete the
 * local branch ref. Owner rule 2026-10-02 "after a PR is merged there should be no worktree or
 * branch left over" — we can tell the branch is merged because its origin ref is gone, which is
 * what `gh pr merge --delete-branch` does on every merge.
 *
 * Safety rails: only when the worktree has no local edits, only `git branch -d` (never `-D`), so
 * an un-merged branch whose remote was manually deleted is reported, not force-dropped.
 */
export interface CleanupReport {
  cleaned: Array<{ repo: string; branch: string; defaultBranch: string }>;
  blocked: Array<{ repo: string; branch: string; reason: string }>;
}

async function remoteRefMissing(repo: string, branch: string): Promise<boolean> {
  // `fetch --prune` so a since-deleted branch stops showing up as origin/<branch> locally. Then
  // check `ls-remote` to be sure: a transient fetch failure must not look like a merged branch.
  try {
    await exec("git", ["-C", repo, "fetch", "-q", "--prune", "origin"], { timeout: 15_000 });
    const { stdout } = await exec("git", ["-C", repo, "ls-remote", "--heads", "origin", branch], { timeout: 10_000 });
    return stdout.trim() === "";
  } catch { return false; }
}

export async function cleanupMergedBranches(services: readonly ServiceConfig[] = OFFICE_SERVICES): Promise<CleanupReport> {
  const out: CleanupReport = { cleaned: [], blocked: [] };
  const seen = new Set<string>();
  for (const svc of services) {
    if (seen.has(svc.repo)) continue;
    seen.add(svc.repo);
    const branch = await gitBranch(svc.repo);
    if (!branch || branch === svc.branch) continue;        // already on default — nothing to do
    if (!(await gitClean(svc.repo))) {
      out.blocked.push({ repo: svc.repo, branch, reason: "local edits to tracked files" });
      continue;
    }
    if (!(await remoteRefMissing(svc.repo, branch))) continue;   // branch is still live on origin
    try {
      await exec("git", ["-C", svc.repo, "switch", svc.branch], { timeout: 15_000 });
      await exec("git", ["-C", svc.repo, "pull", "-q", "--ff-only", "origin", svc.branch], { timeout: 30_000 });
      // -d (soft): refuses when the branch is not reachable from HEAD. Protects against a branch
      // whose remote was force-deleted without a merge (we'd silently drop real work with -D).
      await exec("git", ["-C", svc.repo, "branch", "-d", branch], { timeout: 10_000 });
      out.cleaned.push({ repo: svc.repo, branch, defaultBranch: svc.branch });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      // "not fully merged" is the one we specifically want to surface.
      const reason = /not fully merged/i.test(msg)
        ? "local branch has commits not on default — I didn't delete it; take a look"
        : msg.slice(0, 160);
      out.blocked.push({ repo: svc.repo, branch, reason });
    }
  }
  return out;
}

/** Pure: one-line SMS summary for a cleanup result. Null when nothing happened. */
export function summarizeCleanup(r: CleanupReport): string | null {
  const parts: string[] = [];
  if (r.cleaned.length) {
    const names = r.cleaned.map((c) => `${path.basename(c.repo)} ${c.branch} → ${c.defaultBranch}`).join("; ");
    parts.push(`Cleaned up merged ${r.cleaned.length === 1 ? "branch" : "branches"}: ${names}.`);
  }
  if (r.blocked.length) {
    const names = r.blocked.map((b) => `${path.basename(b.repo)} ${b.branch} (${b.reason.slice(0, 60)})`).join("; ");
    parts.push(`Blocked: ${names}.`);
  }
  return parts.length ? parts.join(" ") : null;
}

export async function triggerAutodeploy(): Promise<{ ok: boolean; error?: string }> {
  try {
    await exec("systemctl", ["--user", "start", process.env.FRIDAY_AUTODEPLOY_UNIT?.trim() || "office-autodeploy.service"], { timeout: 10_000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
  }
}

export interface StaleBranchReport {
  repo: string;
  branch: string;
  defaultBranch: string;
  ageDays: number;
}

/** When was the current checkout last modified? Uses the youngest commit on HEAD as a proxy. */
async function headCommitAgeMs(repo: string, now: number): Promise<number | null> {
  try {
    const { stdout } = await exec("git", ["-C", repo, "log", "-1", "--format=%ct"], { timeout: 5_000 });
    const t = Number(stdout.trim());
    if (!Number.isFinite(t) || t <= 0) return null;
    return Math.max(0, now - t * 1000);
  } catch { return null; }
}

export async function staleBranchSweep(services: readonly ServiceConfig[] = OFFICE_SERVICES, now = Date.now()): Promise<StaleBranchReport[]> {
  // Dedupe repos (one repo can back more than one service).
  const seen = new Set<string>();
  const out: StaleBranchReport[] = [];
  for (const svc of services) {
    if (seen.has(svc.repo)) continue;
    seen.add(svc.repo);
    const branch = await gitBranch(svc.repo);
    if (!branch || branch === svc.branch) continue;
    const age = await headCommitAgeMs(svc.repo, now);
    if (age === null || age < STALE_BRANCH_MS) continue;
    out.push({ repo: svc.repo, branch, defaultBranch: svc.branch, ageDays: Math.floor(age / (24 * 60 * 60_000)) });
  }
  return out;
}

/** Format a one-line SMS summary for a sweep result. Pure. */
export function summarizeSweep(r: SweepResult): string | null {
  if (!r.restarted.length) return null;
  const names = r.restarted.map((s) => s.replace(/^office-/, "").replace(/\.service$/, "")).join(", ");
  return `Restarted stale ${r.restarted.length === 1 ? "service" : "services"}: ${names}.`;
}

/** Format a one-line SMS summary for a stale-branch report. Pure. */
export function summarizeStaleBranches(reports: readonly StaleBranchReport[]): string | null {
  if (!reports.length) return null;
  const bits = reports.map((r) => `${path.basename(r.repo)} on ${r.branch} ${r.ageDays}d (want ${r.defaultBranch})`);
  return `Worktree${reports.length === 1 ? "" : "s"} sitting on a feature branch: ${bits.join("; ")}. Switch back when done.`;
}
