// Unit tests for the pure pieces of ops self-healing. The full sweeps spawn `git` + `systemctl`
// and are integration-shaped; what we lock down here is the pure logic — the staleness verdict's
// decision tree and the two SMS summarizers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  verdictFor,
  sweepStaleServices,
  summarizeSweep,
  summarizeStaleBranches,
  summarizeCleanup,
  staleBranchSweep,
  cleanupMergedBranches,
  STAMPS_DIR,
  RESTART_COOLDOWN_MS,
  SELF_SERVICE,
  OFFICE_SERVICES,
  type ServiceConfig,
  type SweepResult,
  type StaleBranchReport,
  type CleanupReport,
} from "./opsHealing";

const exec = promisify(execFile);

/** Set up a bare-minimum git repo + optional stamp file, return teardown. */
async function makeRepo(opts: { branch?: string; dirty?: boolean; stamp?: string | null; service?: string } = {}): Promise<{ repo: string; svc: ServiceConfig; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "ops-healing-"));
  const svcName = opts.service ?? `test-${path.basename(repo)}.service`;
  await exec("git", ["-C", repo, "init", "-q", "-b", opts.branch ?? "main"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@test"]);
  await exec("git", ["-C", repo, "config", "user.name", "test"]);
  await writeFile(path.join(repo, "x"), "1");
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  if (opts.branch && opts.branch !== (await currentBranch(repo))) {
    await exec("git", ["-C", repo, "checkout", "-q", "-b", opts.branch]);
  }
  if (opts.dirty) await writeFile(path.join(repo, "x"), "2");
  if (opts.stamp !== undefined) {
    await mkdir(STAMPS_DIR, { recursive: true });
    const stampPath = path.join(STAMPS_DIR, `${svcName}.sha`);
    if (opts.stamp === null) await rm(stampPath, { force: true });
    else await writeFile(stampPath, opts.stamp);
  }
  return {
    repo,
    svc: { name: svcName, repo, branch: opts.branch ?? "main" },
    cleanup: async () => {
      await rm(repo, { recursive: true, force: true });
      await rm(path.join(STAMPS_DIR, `${svcName}.sha`), { force: true });
    },
  };
}

async function currentBranch(repo: string): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, "branch", "--show-current"]);
  return stdout.trim();
}

async function headSha(repo: string): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, "rev-parse", "HEAD"]);
  return stdout.trim();
}

test("verdictFor: stamp matches HEAD → not stale", async () => {
  const { svc, repo, cleanup } = await makeRepo();
  try {
    const head = await headSha(repo);
    await mkdir(STAMPS_DIR, { recursive: true });
    await writeFile(path.join(STAMPS_DIR, `${svc.name}.sha`), head);
    const v = await verdictFor(svc);
    assert.equal(v.stale, false);
    assert.equal(v.stampedSha, head);
  } finally { await cleanup(); }
});

test("verdictFor: no stamp → stale (first-time case after this feature deployed)", async () => {
  const { svc, cleanup } = await makeRepo({ stamp: null });
  try {
    const v = await verdictFor(svc);
    assert.equal(v.stale, true);
  } finally { await cleanup(); }
});

test("verdictFor: stamp differs from HEAD → stale", async () => {
  const { svc, cleanup } = await makeRepo({ stamp: "0000000000000000000000000000000000000000" });
  try {
    const v = await verdictFor(svc);
    assert.equal(v.stale, true);
  } finally { await cleanup(); }
});

test("verdictFor: dirty worktree blocks a stale service from restarting", async () => {
  const { svc, cleanup } = await makeRepo({ dirty: true, stamp: "0000000000000000000000000000000000000000" });
  try {
    const v = await verdictFor(svc);
    assert.equal(v.stale, false);
    assert.match(v.reason ?? "", /local edits/);
  } finally { await cleanup(); }
});

test("verdictFor: wrong branch blocks (stale-branch sweep handles this separately)", async () => {
  const { svc, cleanup } = await makeRepo({ stamp: "0000000000000000000000000000000000000000" });
  try {
    await exec("git", ["-C", svc.repo, "checkout", "-q", "-b", "feature/something"]);
    const v = await verdictFor(svc);
    assert.equal(v.stale, false);
    assert.match(v.reason ?? "", /feature\/something.*want main/);
  } finally { await cleanup(); }
});

test("verdictFor: cooldown window suppresses a repeat restart", async () => {
  const { svc, cleanup } = await makeRepo({ stamp: "0000000000000000000000000000000000000000" });
  try {
    const now = Date.now();
    const cooldowns = { [svc.name]: now - 60_000 }; // started 1 min ago, well inside the 30-min window
    const v = await verdictFor(svc, now, cooldowns);
    assert.equal(v.stale, false);
    assert.match(v.reason ?? "", /cooldown.*m left/);
  } finally { await cleanup(); }
});

test("verdictFor: cooldown older than the window → stale again", async () => {
  const { svc, cleanup } = await makeRepo({ stamp: "0000000000000000000000000000000000000000" });
  try {
    const now = Date.now();
    const cooldowns = { [svc.name]: now - RESTART_COOLDOWN_MS - 1_000 };
    const v = await verdictFor(svc, now, cooldowns);
    assert.equal(v.stale, true);
  } finally { await cleanup(); }
});

test("sweepStaleServices: its own stale service goes to auto-deploy, never a self-restart, and only once per window", async () => {
  const { svc, repo, cleanup } = await makeRepo({ stamp: "0000000000000000000000000000000000000000" });
  const cooldownFile = path.join(repo, "cooldown.json");
  const restarts: string[] = [];
  let handOffs = 0;
  const deps = {
    self: svc.name, cooldownFile,
    restart: async (name: string) => { restarts.push(name); },
    handOff: async () => { handOffs++; return { ok: true }; },
  };
  try {
    const now = Date.now();
    const first = await sweepStaleServices([svc], now, deps);
    assert.deepEqual(restarts, []);
    assert.deepEqual(first.restarted, []);
    assert.deepEqual(first.handedOff, [svc.name]);
    assert.equal(handOffs, 1);
    // Stamp untouched: only the build that autodeploy runs may say what is live.
    assert.equal((await exec("cat", [path.join(STAMPS_DIR, `${svc.name}.sha`)])).stdout, "0000000000000000000000000000000000000000");
    // A fresh process (nothing in memory) 20 seconds later reads the saved cooldown and stays put.
    const second = await sweepStaleServices([svc], now + 20_000, deps);
    assert.deepEqual(restarts, []);
    assert.equal(handOffs, 1);
    assert.deepEqual(second.handedOff, []);
    assert.match(second.blocked[0]?.reason ?? "", /cooldown/);
    const third = await sweepStaleServices([svc], now + RESTART_COOLDOWN_MS + 1_000, deps);
    assert.equal(handOffs, 2);
    assert.deepEqual(third.handedOff, [svc.name]);
  } finally { await cleanup(); }
});

test("sweepStaleServices: a failed auto-deploy start is reported, other services still restart and get stamped", async () => {
  const mine = await makeRepo({ stamp: "0000000000000000000000000000000000000000" });
  const other = await makeRepo({ stamp: "0000000000000000000000000000000000000000" });
  const cooldownFile = path.join(mine.repo, "cooldown.json");
  const restarts: string[] = [];
  try {
    const r = await sweepStaleServices([mine.svc, other.svc], Date.now(), {
      self: mine.svc.name, cooldownFile,
      restart: async (name: string) => { restarts.push(name); },
      handOff: async () => ({ ok: false, error: "unit not found" }),
    });
    assert.deepEqual(restarts, [other.svc.name]);
    assert.deepEqual(r.restarted, [other.svc.name]);
    assert.deepEqual(r.handedOff, []);
    assert.match(r.blocked.find((b) => b.name === mine.svc.name)?.reason ?? "", /auto-deploy didn't start: unit not found/);
    assert.equal((await exec("cat", [path.join(STAMPS_DIR, `${other.svc.name}.sha`)])).stdout, await headSha(other.repo));
  } finally { await mine.cleanup(); await other.cleanup(); }
});

test("SELF_SERVICE names a service the sweep covers", () => {
  assert.ok(OFFICE_SERVICES.some((s) => s.name === SELF_SERVICE));
});

test("summarizeSweep: null when nothing restarted; concise one-liner otherwise", () => {
  const empty: SweepResult = { restarted: [], blocked: [], shaByService: {} };
  assert.equal(summarizeSweep(empty), null);
  const one: SweepResult = { restarted: ["office-clara.service"], blocked: [], shaByService: {} };
  assert.match(summarizeSweep(one)!, /^Restarted stale service: clara\.$/);
  const two: SweepResult = { restarted: ["office-friday.service", "office-clara.service"], blocked: [], shaByService: {} };
  assert.match(summarizeSweep(two)!, /^Restarted stale services: friday, clara\.$/);
});

test("summarizeStaleBranches: null for empty; names the branches + ages otherwise", () => {
  assert.equal(summarizeStaleBranches([]), null);
  const one: StaleBranchReport[] = [{ repo: "/x/CLARA", branch: "feat/x", defaultBranch: "main", ageDays: 10 }];
  assert.match(summarizeStaleBranches(one)!, /Worktree sitting on a feature branch: CLARA on feat\/x 10d \(want main\)/);
  const two: StaleBranchReport[] = [
    { repo: "/x/CLARA", branch: "feat/a", defaultBranch: "main", ageDays: 8 },
    { repo: "/x/FRIDAY", branch: "feat/b", defaultBranch: "master", ageDays: 15 },
  ];
  const s = summarizeStaleBranches(two)!;
  assert.match(s, /Worktrees sitting on a feature branch/);
  assert.match(s, /CLARA on feat\/a 8d/);
  assert.match(s, /FRIDAY on feat\/b 15d/);
});

test("summarizeCleanup: one-liner when something cleaned; names repo+branch+default", () => {
  assert.equal(summarizeCleanup({ cleaned: [], blocked: [] }), null);
  const oneClean: CleanupReport = {
    cleaned: [{ repo: "/x/CLARA", branch: "feat/vip", defaultBranch: "main" }], blocked: [],
  };
  assert.match(summarizeCleanup(oneClean)!, /Cleaned up merged branch: CLARA feat\/vip → main\./);
  const blockedOnly: CleanupReport = {
    cleaned: [], blocked: [{ repo: "/x/FRIDAY", branch: "feat/x", reason: "local branch has commits not on default" }],
  };
  assert.match(summarizeCleanup(blockedOnly)!, /^Blocked: FRIDAY feat\/x/);
});

test("cleanupMergedBranches: switches back + deletes a merged feature branch; leaves un-merged alone", async () => {
  // Set up a 'remote' bare repo + a 'local' clone with a feature branch that mirrors remote.
  const base = await mkdtemp(path.join(os.tmpdir(), "ops-cleanup-"));
  const remote = path.join(base, "remote.git");
  const local = path.join(base, "local");
  try {
    await exec("git", ["init", "-q", "--bare", "-b", "main", remote]);
    await exec("git", ["clone", "-q", remote, local]);
    await exec("git", ["-C", local, "config", "user.email", "t@t"]);
    await exec("git", ["-C", local, "config", "user.name", "t"]);
    await writeFile(path.join(local, "x"), "1");
    await exec("git", ["-C", local, "add", "."]);
    await exec("git", ["-C", local, "commit", "-q", "-m", "init"]);
    await exec("git", ["-C", local, "push", "-q", "origin", "main"]);
    // Merged feature branch: commit on it, merge INTO main, push both, then delete the remote ref.
    await exec("git", ["-C", local, "checkout", "-q", "-b", "feat/merged"]);
    await writeFile(path.join(local, "y"), "2");
    await exec("git", ["-C", local, "add", "."]);
    await exec("git", ["-C", local, "commit", "-q", "-m", "feat"]);
    await exec("git", ["-C", local, "push", "-q", "-u", "origin", "feat/merged"]);
    await exec("git", ["-C", local, "checkout", "-q", "main"]);
    await exec("git", ["-C", local, "merge", "-q", "--no-ff", "feat/merged", "-m", "merge"]);
    await exec("git", ["-C", local, "push", "-q", "origin", "main"]);
    // Delete the remote ref — this is what `gh pr merge --delete-branch` does.
    await exec("git", ["-C", local, "push", "-q", "origin", "--delete", "feat/merged"]);
    // Put the local worktree back on feat/merged — this is the state we're trying to catch.
    await exec("git", ["-C", local, "checkout", "-q", "feat/merged"]);

    const svc: ServiceConfig = { name: "test.service", repo: local, branch: "main" };
    const r = await cleanupMergedBranches([svc]);
    assert.equal(r.cleaned.length, 1);
    assert.equal(r.cleaned[0].branch, "feat/merged");
    assert.equal(r.cleaned[0].defaultBranch, "main");
    // The worktree is now on main, and the local branch ref is gone.
    const { stdout: branch } = await exec("git", ["-C", local, "branch", "--show-current"]);
    assert.equal(branch.trim(), "main");
    const branches = (await exec("git", ["-C", local, "branch"])).stdout;
    assert.ok(!branches.includes("feat/merged"), `local branch should be gone; got: ${branches}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("cleanupMergedBranches: reports a worktree whose remote branch is deleted but still has unmerged commits — never force-drops", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "ops-cleanup-"));
  const remote = path.join(base, "remote.git");
  const local = path.join(base, "local");
  try {
    await exec("git", ["init", "-q", "--bare", "-b", "main", remote]);
    await exec("git", ["clone", "-q", remote, local]);
    await exec("git", ["-C", local, "config", "user.email", "t@t"]);
    await exec("git", ["-C", local, "config", "user.name", "t"]);
    await writeFile(path.join(local, "x"), "1");
    await exec("git", ["-C", local, "add", "."]);
    await exec("git", ["-C", local, "commit", "-q", "-m", "init"]);
    await exec("git", ["-C", local, "push", "-q", "origin", "main"]);
    // Create a feature branch, push it, then force-delete the remote ref WITHOUT merging.
    await exec("git", ["-C", local, "checkout", "-q", "-b", "feat/unmerged"]);
    await writeFile(path.join(local, "y"), "2");
    await exec("git", ["-C", local, "add", "."]);
    await exec("git", ["-C", local, "commit", "-q", "-m", "work"]);
    await exec("git", ["-C", local, "push", "-q", "-u", "origin", "feat/unmerged"]);
    await exec("git", ["-C", local, "push", "-q", "origin", "--delete", "feat/unmerged"]);

    const svc: ServiceConfig = { name: "test.service", repo: local, branch: "main" };
    const r = await cleanupMergedBranches([svc]);
    assert.equal(r.cleaned.length, 0, "nothing cleaned");
    assert.equal(r.blocked.length, 1, "the un-merged branch is reported");
    assert.match(r.blocked[0].reason, /not fully merged|not on default|not merged/i);
    // The branch MUST still exist locally — we didn't force-drop real work.
    const branches = (await exec("git", ["-C", local, "branch"])).stdout;
    assert.ok(/feat\/unmerged/.test(branches), `local branch should still exist; got: ${branches}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("staleBranchSweep: ignores repos on the default branch; flags feature-branch repos older than 7d", async () => {
  const r1 = await makeRepo({ branch: "main", service: "s1.service" });
  const r2 = await makeRepo({ branch: "main", service: "s2.service" });
  try {
    // r1 stays on main — ignored.
    // r2 switches to a feature branch and commits with an old timestamp.
    await exec("git", ["-C", r2.repo, "checkout", "-q", "-b", "feature/old"]);
    const oldEpoch = Math.floor((Date.now() - 10 * 24 * 60 * 60_000) / 1000);
    await writeFile(path.join(r2.repo, "y"), "1");
    await exec("git", ["-C", r2.repo, "add", "."]);
    await exec("git", ["-C", r2.repo, "commit", "-q", "-m", "old"], {
      env: { ...process.env, GIT_AUTHOR_DATE: `${oldEpoch}`, GIT_COMMITTER_DATE: `${oldEpoch}` },
    });
    const reports = await staleBranchSweep([r1.svc, r2.svc]);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].repo, r2.repo);
    assert.equal(reports[0].branch, "feature/old");
    assert.equal(reports[0].defaultBranch, "main");
    assert.ok(reports[0].ageDays >= 7, `ageDays should be ≥ 7, got ${reports[0].ageDays}`);
  } finally { await r1.cleanup(); await r2.cleanup(); }
});
