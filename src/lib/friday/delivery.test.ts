// Every coding run gets an isolated worktree: a PR round on its PR branch, a fresh single-repo task on
// its own branch cut from the default branch. Nothing runs in the owner's checkout any more.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { workspaceKindFor, taskWorktreeNames, isWorktreeDir, taskRepoFor, parseSymrefHead, worktreeTaskClosed, withRepoLock, isTransientGitFailure, fetchOrigin } from "./delivery";

// Pinned: otherwise the owner comes from this checkout's own origin remote and the expected URLs move with it.
process.env.GITHUB_OWNER = "example-org";

const single = { repoUrls: ["https://github.com/example-org/umbrella-api.git"], workspaceDir: "/srv/client-projects/engineering/umbrella-api" };
const multi = { repoUrls: ["https://github.com/a/api.git", "https://github.com/a/web.git"] };
const none = {};

test("fresh tasks on a single-repo project get their own worktree; PR rounds keep the PR worktree", () => {
  assert.equal(workspaceKindFor("dev", single, { id: "t1" }), "task-worktree");
  assert.equal(workspaceKindFor("devops", single, { id: "t1" }), "task-worktree");
  assert.equal(workspaceKindFor("dev", single, { id: "t1", prUrl: "https://github.com/example-org/umbrella-api/pull/9", prHeadRef: "friday/x" }), "pr-worktree");
});

test("non-coding roles, multi-repo projects and repo-less projects keep their old workspace", () => {
  assert.equal(workspaceKindFor("pm", single, { id: "t1" }), "none");
  assert.equal(workspaceKindFor("dev", multi, { id: "t1" }), "clones");
  assert.equal(workspaceKindFor("dev", none, { id: "t1" }), "scratch");
  assert.equal(workspaceKindFor("dev", null, { id: "t1" }), "none");
});

test("task worktree names are stable, safe, and live under the worktrees root", () => {
  const n = taskWorktreeNames("https://github.com/example-org/umbrella-api.git", { id: "f52095a9-e14c-41a3", title: "Let staff edit order addresses & contact details after checkout!" });
  assert.equal(n.branch, "friday/let-staff-edit-order-addresses-contact-d-f52095a9");
  assert.ok(n.dir.startsWith(path.join(os.homedir(), ".agentic-os", "friday", "worktrees", "umbrella-api")));
  assert.ok(isWorktreeDir(n.dir));
  assert.equal(taskWorktreeNames("https://github.com/x/y", { id: "abc", title: "" }).branch, "friday/task-abc");
});

test("isWorktreeDir is true only under the worktrees root", () => {
  assert.equal(isWorktreeDir("/srv/client-projects/engineering/umbrella-api"), false);
  assert.equal(isWorktreeDir(path.join(os.homedir(), ".agentic-os", "friday", "worktrees")), false);
  assert.equal(isWorktreeDir(undefined), false);
});

test("taskRepoFor picks the single repo, and nothing for multi-repo projects", () => {
  assert.equal(taskRepoFor(single), "https://github.com/example-org/umbrella-api.git");
  assert.equal(taskRepoFor(multi), null);
});

test("the default branch comes from the remote's symref, not the stale local origin/HEAD", () => {
  assert.equal(parseSymrefHead("ref: refs/heads/main\tHEAD\n0123abcd\tHEAD\n"), "main");
  assert.equal(parseSymrefHead("ref: refs/heads/release/v2\tHEAD\n"), "release/v2");
  assert.equal(parseSymrefHead(""), null);
});

test("worktree cleanup only trusts one unambiguous closed task", () => {
  const closed = (s: string) => s === "completed" || s === "on_hold";
  const tasks = [{ id: "abcd1234-0000", status: "completed" }, { id: "abcd1234-9999", status: "in_progress" }, { id: "ffff0000-1", status: "completed" }];
  assert.equal(worktreeTaskClosed("abcd1234", tasks, closed), false, "ambiguous prefix keeps the worktree");
  assert.equal(worktreeTaskClosed("ffff0000", tasks, closed), true);
  assert.equal(worktreeTaskClosed("99999999", tasks, closed), false, "missing task keeps the worktree");
  assert.equal(worktreeTaskClosed("task", tasks, closed), false);
});

test("a project with branchPrefix friday-work gets friday-work/ task branches (repo already has a `friday` branch)", () => {
  const t = { id: "13b2ec87-3fb5", title: "Delete Call Option" };
  assert.equal(taskWorktreeNames("https://github.com/caseyclient1/retirement-income-dashboard.git", t, "friday-work").branch, "friday-work/delete-call-option-13b2ec87");
  assert.equal(taskWorktreeNames("https://github.com/x/y.git", t).branch, "friday/delete-call-option-13b2ec87");
  // The folder is the same either way, so an existing worktree is still found.
  assert.equal(taskWorktreeNames("https://github.com/x/y.git", t, "friday-work").dir, taskWorktreeNames("https://github.com/x/y.git", t).dir);
});

// 2026-11-12: a dev task and its QA task were dispatched together on initech-box seconds after a PR
// merged. Both fetched the owner's checkout at once and one died on git's ref lock, so its run was
// refused ("could not create the isolated git worktree").
const LOCK_RACE = "error: cannot lock ref 'refs/remotes/origin/main': is at 9efb2053 but expected 9d8f26dc\nFrom https://github.com/example-org/initech-box\n ! 9d8f26d..9efb205  main -> origin/main  (unable to update local ref)";

test("a lost ref-lock race and network blips are transient; a missing branch or no access is not", () => {
  assert.equal(isTransientGitFailure(LOCK_RACE), true);
  assert.equal(isTransientGitFailure("fatal: Unable to create '/repo/.git/shallow.lock': File exists."), true);
  assert.equal(isTransientGitFailure("fatal: unable to access 'https://github.com/x/y/': Could not resolve host: github.com"), true);
  assert.equal(isTransientGitFailure("error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502"), true);
  assert.equal(isTransientGitFailure("fatal: couldn't find remote ref friday/outlets-page"), false);
  assert.equal(isTransientGitFailure("remote: Repository not found.\nfatal: repository 'https://github.com/x/y/' not found"), false);
  assert.equal(isTransientGitFailure(""), false);
});

test("a fetch that loses the ref-lock race is tried again and succeeds", async () => {
  const calls: string[][] = [];
  const waits: number[] = [];
  const outs = [{ ok: false, out: LOCK_RACE }, { ok: true, out: "" }];
  const r = await fetchOrigin("/repo", "main", {
    run: async (_cmd, args) => { calls.push(args); return outs.shift()!; },
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.deepEqual({ ok: r.ok, tries: r.tries }, { ok: true, tries: 2 });
  assert.deepEqual(calls, [["fetch", "origin", "main"], ["fetch", "origin", "main"]]);
  assert.deepEqual(waits, [2000]);
});

test("a fetch that can never work fails at once with git's own words; a transient one stops after three tries", async () => {
  let n = 0;
  const gone = await fetchOrigin("/repo", "nope", { run: async () => { n++; return { ok: false, out: "fatal: couldn't find remote ref nope" }; }, sleep: async () => {} });
  assert.deepEqual({ ok: gone.ok, tries: gone.tries, n }, { ok: false, tries: 1, n: 1 });
  assert.match(gone.out, /couldn't find remote ref/);
  n = 0;
  const stuck = await fetchOrigin("/repo", "main", { run: async () => { n++; return { ok: false, out: LOCK_RACE }; }, sleep: async () => {} });
  assert.deepEqual({ ok: stuck.ok, tries: stuck.tries, n }, { ok: false, tries: 3, n: 3 });
});

test("git work on one checkout runs one at a time, in order; other checkouts are not held up", async () => {
  const log: string[] = [];
  const job = (name: string, ms: number) => async () => { log.push(`${name}:start`); await new Promise((r) => setTimeout(r, ms)); log.push(`${name}:end`); return name; };
  const [a, b, other] = await Promise.all([
    withRepoLock("/repos/initech-box", job("a", 30)),
    withRepoLock("/repos/initech-box/", job("b", 1)),
    withRepoLock("/repos/hooli-paving", job("other", 1)),
  ]);
  assert.deepEqual([a, b, other], ["a", "b", "other"]);
  assert.ok(log.indexOf("a:end") < log.indexOf("b:start"), "b waited for a");
  assert.ok(log.indexOf("other:end") < log.indexOf("a:end"), "a different checkout ran meanwhile");
});

test("a failed job does not jam the checkout's queue", async () => {
  const failed = withRepoLock("/repos/jam", async () => { throw new Error("worktree add failed"); });
  const after = withRepoLock("/repos/jam", async () => "ran");
  await assert.rejects(failed, /worktree add failed/);
  assert.equal(await after, "ran");
});
