// wormGuard — the stop / email / block / resume flow, with injected deps (no disk state, no email).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { repoKey, reportWormHit, guardWorkspace, guardRef, guardPrHead, tryResumeCommand, parseResumeCommand, recheckBlockedRepos, hitEmail, blockFor, type BlockFile, type GuardDeps } from "./wormGuard";
import { MARKERS, type WormHit } from "./wormScan";

function fakeDeps(initial: BlockFile = {}) {
  let state: BlockFile = JSON.parse(JSON.stringify(initial));
  const notes: Array<Record<string, unknown>> = [];
  const removed: string[] = [];
  const events: string[] = [];
  const deps: GuardDeps = {
    load: async () => JSON.parse(JSON.stringify(state)),
    save: async (s) => { state = JSON.parse(JSON.stringify(s)); },
    notify: async (o) => { notes.push(o as unknown as Record<string, unknown>); return {}; },
    removeDir: async (d) => { removed.push(d); },
    isWorktreeDir: (d) => d.includes("/worktrees/"),
    log: async (e) => { events.push(e); },
  };
  return { deps, notes, removed, events, state: () => state };
}

const HIT: WormHit = { file: "postcss.config.mjs", signature: "config-hidden-code", detail: "line 7 has code hidden after a long run of spaces" };

test("repoKey normalizes repo URLs, PR URLs and remotes to owner/repo", () => {
  assert.equal(repoKey("https://github.com/example-org/Mai-Dash.git"), "example-org/mai-dash");
  assert.equal(repoKey("https://github.com/example-org/mai-dash/pull/91"), "example-org/mai-dash");
  assert.equal(repoKey("git@github.com:example-org/orion.git"), "example-org/orion");
  assert.equal(repoKey("/tmp/some/dir"), "/tmp/some/dir");
});

test("a hit blocks the repo, deletes the worktree, and emails the owner (critical, security, deduped by sha)", async () => {
  const f = fakeDeps();
  const entry = await reportWormHit({ repoUrl: "https://github.com/example-org/mai-dash.git", branch: "friday/x", sha: "abc1234def", hits: [HIT], source: "run", worktreeDir: "/srv/agent/.agentic-os/friday/worktrees/mai-dash/x" }, f.deps);
  assert.equal(entry.key, "example-org/mai-dash");
  assert.ok(f.state()["example-org/mai-dash"]);
  assert.deepEqual(f.removed, ["/srv/agent/.agentic-os/friday/worktrees/mai-dash/x"]);
  assert.equal(f.notes.length, 1);
  const n = f.notes[0];
  assert.equal(n.priority, "critical");
  assert.equal(n.emergencyCategory, "security");
  assert.equal(n.kind, "security.malware_suspected"); // not an EMERGENCY_KINDS member → timely email, never SMS
  assert.equal(n.email, true);
  assert.equal(n.dedupeKey, "worm:example-org/mai-dash:abc1234def");
  assert.match(String(n.summary), /friday\/x/);
  assert.match(String(n.summary), /abc1234/);
  assert.match(String(n.summary), /postcss\.config\.mjs/);
  assert.match(String(n.summary), /resume mai-dash/);
  assert.ok(f.events.includes("security.malware_suspected"));
});

test("a hit never deletes a directory that isn't one of FRIDAY's worktrees", async () => {
  const f = fakeDeps();
  await reportWormHit({ repoUrl: "https://github.com/o/r", hits: [HIT], source: "run", worktreeDir: "/srv/client-projects/engineering/r" }, f.deps);
  assert.deepEqual(f.removed, []);
});

test("the owner email says nothing was built, fixed or pushed", () => {
  const m = hitEmail({ key: "o/r", branch: "main", sha: "0123456789", hits: [HIT], source: "run" });
  assert.match(m.headline, /o\/r/);
  assert.match(m.summary, /did not build, run, fix, commit or push/);
  const a = hitEmail({ key: "o/r", hits: [{ file: "(agent report)", signature: "agent-reported", detail: "MALWARE SUSPECTED: x" }], source: "agent-report" });
  assert.match(a.summary, /agents stopped/);
});

function tmpRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wormguard-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.com"); g("config", "user.name", "t");
  g("remote", "add", "origin", "https://github.com/example-org/demo.git");
  for (const [f, c] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), c); }
  g("add", "-A"); g("commit", "-q", "-m", "init");
  return dir;
}

test("guardWorkspace: clean checkout → null; infected → refusal + block + email; then every run on that repo is refused without scanning", async () => {
  const f = fakeDeps();
  const clean = tmpRepo({ "index.js": "ok\n" });
  assert.deepEqual(await guardWorkspace({ cwd: clean, repoUrls: ["https://github.com/example-org/demo"], source: "run" }, f.deps), { kind: "clean" });
  assert.equal(f.notes.length, 0);

  const dirty = tmpRepo({ ".gitignore": "config.bat\n", "a.js": `${MARKERS[0]}'x';` });
  const why = await guardWorkspace({ cwd: dirty, repoUrls: ["https://github.com/example-org/demo"], source: "run", taskId: "t1" }, f.deps);
  assert.equal(why.kind, "blocked");
  assert.match(why.kind === "blocked" ? why.reason : "", /^malware-suspected: example-org\/demo/);
  assert.equal(f.notes.length, 1);
  assert.ok(f.state()["example-org/demo"]);

  // Blocked: even a clean checkout / no checkout at all is refused until resumed.
  const again = await guardWorkspace({ cwd: clean, repoUrls: ["https://github.com/example-org/demo.git"], source: "run" }, f.deps);
  assert.equal(again.kind, "blocked");
  assert.match(again.kind === "blocked" ? again.reason : "", /is blocked since/);
  assert.equal((await guardWorkspace({ repoUrls: ["https://github.com/example-org/demo"], source: "run" }, f.deps)).kind, "blocked");
  assert.equal(f.notes.length, 1); // no second email for the block itself
  // Other repos are unaffected.
  assert.deepEqual(await guardWorkspace({ repoUrls: ["https://github.com/example-org/other"], source: "run" }, f.deps), { kind: "clean" });
});

test("guardRef (shepherd): a hit on a PR head blocks; a clean head passes", async () => {
  const f = fakeDeps();
  const clean = await guardRef({ repoDir: "/x", ref: "refs/scan/b", repoUrl: "https://github.com/o/r", branch: "b", sha: "s1" }, f.deps, async () => []);
  assert.deepEqual(clean, { kind: "clean" });
  const hit = await guardRef({ repoDir: "/x", ref: "refs/scan/b", repoUrl: "https://github.com/o/r", branch: "b", sha: "s2" }, f.deps, async () => [HIT]);
  assert.equal(hit.kind, "blocked");
  assert.equal(f.state()["o/r"].source, "shepherd");
  assert.equal(f.notes[0].dedupeKey, "worm:o/r:s2");
  assert.ok(await blockFor("https://github.com/o/r/pull/3", f.deps));
});

test("'resume <repo>' parses and lifts only a matching block", async () => {
  assert.equal(parseResumeCommand("resume mai-dash"), "mai-dash");
  assert.equal(parseResumeCommand("Resume work on the example-org/mai-dash repo."), "example-org/mai-dash");
  assert.equal(parseResumeCommand("please unblock initechbox-os"), "initechbox-os");
  assert.equal(parseResumeCommand("resume the meeting follow-ups and send them"), null);
  const f = fakeDeps({ "example-org/mai-dash": { key: "example-org/mai-dash", files: ["x"], source: "run", blockedAt: "2026-09-28T00:00:00Z" } });
  assert.equal(await tryResumeCommand("resume meeting-followups", f.deps), null); // not a blocked repo → falls through
  const r = await tryResumeCommand("resume mai-dash", f.deps);
  assert.match(String(r), /example-org\/mai-dash is unblocked/);
  assert.deepEqual(f.state(), {});
  assert.ok(f.events.includes("security.malware_unblocked"));
});

test("'resume' with an ambiguous name asks which one", async () => {
  const f = fakeDeps({
    "a/site": { key: "a/site", files: [], source: "run", blockedAt: "t" },
    "b/site": { key: "b/site", files: [], source: "run", blockedAt: "t" },
  });
  assert.match(String(await tryResumeCommand("resume site", f.deps)), /More than one/);
  assert.equal(Object.keys(f.state()).length, 2);
});

test("recheck: a repo whose default branch scans clean is unblocked and the owner is told; a dirty one stays", async () => {
  const f = fakeDeps({
    "o/clean": { key: "o/clean", files: ["x"], source: "run", blockedAt: "t" },
    "o/dirty": { key: "o/dirty", files: ["x"], source: "run", blockedAt: "t" },
  });
  // Point the "scan cache" at local repos that already have the ref the recheck fetches.
  const mk = (): string => {
    const origin = tmpRepo({ "a.txt": "1\n" });
    const cache = mkdtempSync(path.join(os.tmpdir(), "wormcache-"));
    execFileSync("git", ["init", "--bare", "-q"], { cwd: cache });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: cache });
    return cache;
  };
  const caches: Record<string, string> = { "o/clean": mk(), "o/dirty": mk() };
  const summary = await recheckBlockedRepos(f.deps, async (dir) => (dir === caches["o/dirty"] ? [HIT] : []), async (key) => caches[key] ?? null);
  assert.equal(summary, "worm recheck: 1 unblocked, 1 still blocked");
  assert.deepEqual(Object.keys(f.state()), ["o/dirty"]);
  assert.equal(f.notes.length, 1);
  assert.equal(f.notes[0].kind, "security.malware_cleared");
});

test("a scan that can't complete is 'unavailable' — never clean, never a block, no email", async () => {
  const f = fakeDeps();
  const r = await guardRef({ repoDir: "/x", ref: "r", repoUrl: "https://github.com/o/r" }, f.deps, async () => { throw new Error("git grep timed out"); });
  assert.equal(r.kind, "unavailable");
  assert.deepEqual(f.state(), {});
  assert.equal(f.notes.length, 0);
  // A checkout whose file list can't be read (not a git repo at all is fine — that's "no repos").
  const broken = mkdtempSync(path.join(os.tmpdir(), "wormguard-broken-"));
  mkdirSync(path.join(broken, ".git")); // looks like a repo, but git can't read it
  assert.equal((await guardWorkspace({ cwd: broken, repoUrls: ["https://github.com/o/r"], source: "run" }, f.deps)).kind, "unavailable");
});

test("an unreadable block list stops work ('unavailable') instead of reading as 'nothing blocked'", async () => {
  const f = fakeDeps();
  f.deps.load = async () => { throw new SyntaxError("Unexpected end of JSON input"); };
  assert.equal((await guardWorkspace({ repoUrls: ["https://github.com/o/r"], source: "run" }, f.deps)).kind, "unavailable");
  assert.equal((await guardRef({ repoDir: "/x", ref: "r", repoUrl: "https://github.com/o/r" }, f.deps, async () => [])).kind, "unavailable");
  // A resume that can't be applied says so instead of falling through.
  assert.match(String(await tryResumeCommand("resume r", f.deps)), /couldn't lift the block/);
});

test("guardPrHead scans the exact PR head (refs/pull/<n>/head) and treats a moved head as unavailable", async () => {
  const origin = tmpRepo({ "a.txt": "1\n" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: origin }).toString().trim();
  execFileSync("git", ["update-ref", "refs/pull/7/head", head], { cwd: origin });
  const cache = mkdtempSync(path.join(os.tmpdir(), "wormcache-pr-"));
  execFileSync("git", ["init", "--bare", "-q"], { cwd: cache });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: cache });
  const f = fakeDeps();
  const scanned: string[] = [];
  const scan = async (_d: string, ref: string) => { scanned.push(ref); return []; };
  const ok = await guardPrHead({ key: "o/r", prNumber: 7, headRef: "feature", headSha: head, repoUrl: "https://github.com/o/r" }, f.deps, scan, async () => cache);
  assert.deepEqual(ok, { kind: "clean" });
  assert.deepEqual(scanned, ["refs/scan/pr-7"]);
  const moved = await guardPrHead({ key: "o/r", prNumber: 7, headRef: "feature", headSha: "f".repeat(40), repoUrl: "https://github.com/o/r" }, f.deps, scan, async () => cache);
  assert.equal(moved.kind, "unavailable");
  const missing = await guardPrHead({ key: "o/r", prNumber: 99, headRef: "x", headSha: head, repoUrl: "https://github.com/o/r" }, f.deps, scan, async () => cache);
  assert.equal(missing.kind, "unavailable");
});

test("recheck never erases a block added (or renewed) while it was scanning", async () => {
  const f = fakeDeps({ "o/a": { key: "o/a", files: ["x"], source: "run", blockedAt: "t1" } });
  const origin = tmpRepo({ "a.txt": "1\n" });
  const cache = mkdtempSync(path.join(os.tmpdir(), "wormcache-race-"));
  execFileSync("git", ["init", "--bare", "-q"], { cwd: cache });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: cache });
  // While "o/a" is being scanned, a run blocks "o/b" and re-blocks "o/a" (new blockedAt).
  const scan = async () => {
    await reportWormHit({ repoUrl: "https://github.com/o/b", hits: [HIT], source: "run" }, f.deps);
    await reportWormHit({ repoUrl: "https://github.com/o/a", hits: [HIT], source: "run", sha: "new" }, f.deps);
    return [];
  };
  const summary = await recheckBlockedRepos(f.deps, scan, async () => cache);
  assert.equal(summary, "worm recheck: 0 unblocked, 1 still blocked");
  assert.deepEqual(Object.keys(f.state()).sort(), ["o/a", "o/b"]);
  assert.ok(!f.notes.some((n) => n.kind === "security.malware_cleared"));
});
