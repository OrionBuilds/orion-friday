// depSweep — the weekly gate and the "what about last week's PR?" decision, both pure, plus the
// sweep's use of them against a throwaway store (same harness pattern as authority.test.ts).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-depsweep-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;
process.env.FRIDAY_DEP_SWEEP = "active";

type Mod = typeof import("./depSweep");
type StoreMod = typeof import("@/lib/persistence/store");
let M: Mod;
let S: StoreMod;

before(async () => { M = await import("./depSweep"); S = await import("@/lib/persistence/store"); });
after(() => rmSync(TMP, { recursive: true, force: true }));

const wed = new Date("2026-09-30T13:00:00Z"); // Wednesday
const thu = new Date("2026-10-01T13:00:00Z");

test("isSweepDay: Wednesdays only", () => {
  assert.equal(M.isSweepDay(wed), true);
  assert.equal(M.isSweepDay(thu), false);
});

const pr = (n: number, over: Partial<import("./depSweep").OpenUpkeepPr> = {}) => ({
  number: n, url: `https://github.com/o/r/pull/${n}`, title: "deps: weekly patch bumps", headRefName: `friday/deps-weekly-2026-09-${n}`,
  mergeable: "MERGEABLE", checks: "SUCCESS", createdAt: "2026-09-23T00:00:00Z", ...over,
});

test("planUpkeepPrs: a green open sweep means skip; conflicting or stale ones are closed", () => {
  const now = new Date("2026-09-30T00:00:00Z");
  const plan = M.planUpkeepPrs([pr(55), pr(51, { mergeable: "CONFLICTING" }), pr(40, { createdAt: "2026-08-01T00:00:00Z" }), { ...pr(3), title: "feat: hero", headRefName: "friday/hero" }], now);
  assert.equal(plan.skipBecause?.number, 55);
  assert.deepEqual(plan.close.map((p) => p.number).sort(), [40, 51]);
});

test("planUpkeepPrs: nothing open → no skip, nothing to close", () => {
  assert.deepEqual(M.planUpkeepPrs([], wed), { skipBecause: undefined, close: [] });
});

test("runDepSweep skips a repo whose green deps PR is still open, and closes stale ones before a fresh sweep (dry run)", async () => {
  const now = new Date().toISOString();
  await S.store.clients.insert({ id: "c1", name: "Globex", createdAt: now, updatedAt: now } as never);
  await S.store.projects.insert({ id: "p1", clientId: "c1", name: "Globex Website", status: "active", repoUrls: ["https://github.com/example-org/globex-fl"], createdAt: now, updatedAt: now } as never);
  await S.store.projects.insert({ id: "p2", clientId: "c1", name: "Umbrella", status: "active", repoUrls: ["https://github.com/example-org/umbrella-api"], createdAt: now, updatedAt: now } as never);
  const closed: string[] = [];
  const gh = {
    listOpenPrs: async (_o: string, repo: string) => repo === "globex-fl" ? [pr(22)] : [pr(21, { mergeable: "CONFLICTING" })],
    closePr: async (url: string) => { closed.push(url); return { ok: true }; },
  };
  const out = await M.runDepSweep({ dryRun: true, now: wed, gh });
  const globex = out.find((e) => e.repoName === "globex-fl");
  const trd = out.find((e) => e.repoName === "umbrella-api");
  assert.equal(globex?.outcome, "skipped");
  assert.match(globex?.reason ?? "", /open deps PR #22 awaiting merge/);
  assert.equal(trd?.outcome, "dry");
  assert.match(trd?.reason ?? "", /would close #21/);
  assert.deepEqual(closed, []); // dry run never closes
});

test("runDepSweep skips a repo whose [Deps] task is still on the board", async () => {
  const now = new Date().toISOString();
  await S.store.tasks.insert({ id: "t1", projectId: "p2", title: "[Deps] umbrella-api weekly patch bumps", status: "internal_review", assignee: "devops", risk: "medium", order: 0, createdAt: now, updatedAt: now } as never);
  const gh = { listOpenPrs: async () => [], closePr: async () => ({ ok: true }) };
  const out = await M.runDepSweep({ dryRun: true, now: wed, gh });
  assert.equal(out.find((e) => e.repoName === "umbrella-api")?.reason, "previous [Deps] task still open");
});
