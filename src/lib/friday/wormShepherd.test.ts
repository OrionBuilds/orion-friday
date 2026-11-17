// prShepherd.wormCheckPr — the shepherd's use of the worm guard: only a completed clean scan of the
// exact head sha is cached; an unavailable scan is retried next tick; a blocked repo parks every PR.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "wormshepherd-"));
process.env.AGENTIC_OS_FRIDAY_DATA = dataDir;
const { wormCheckPr, freshState, parkForWorm } = await import("./prShepherd");

const pr = { url: "https://github.com/o/r/pull/5", number: 5, headRefName: "feature", headSha: "a".repeat(40) };

test("clean scan is cached for that sha; an unavailable scan is not", async () => {
  const state = freshState();
  let calls = 0;
  const unavailable = await wormCheckPr(pr, state, undefined, async () => { calls++; return { kind: "unavailable", reason: "fetch failed" }; });
  assert.equal(unavailable.kind, "unavailable");
  assert.equal(state.wormScannedSha, undefined);
  const clean = await wormCheckPr(pr, state, undefined, async () => { calls++; return { kind: "clean" }; });
  assert.equal(clean.kind, "clean");
  assert.equal(state.wormScannedSha, pr.headSha);
  // Same head again → no rescan.
  await wormCheckPr(pr, state, undefined, async () => { calls++; return { kind: "clean" }; });
  assert.equal(calls, 2);
});

test("a thrown guard is unavailable, not clean", async () => {
  const state = freshState();
  const r = await wormCheckPr(pr, state, undefined, async () => { throw new Error("boom"); });
  assert.equal(r.kind, "unavailable");
  assert.equal(state.wormScannedSha, undefined);
});

test("a blocked repo parks the PR even when its head was scanned clean before", async () => {
  const state = { ...freshState(), wormScannedSha: pr.headSha };
  writeFileSync(path.join(dataDir, "worm-blocked.json"), JSON.stringify({ "o/r": { key: "o/r", files: ["x"], source: "run", blockedAt: "t" } }));
  const r = await wormCheckPr(pr, state, undefined, async () => ({ kind: "clean" }));
  assert.equal(r.kind, "blocked");
  writeFileSync(path.join(dataDir, "worm-blocked.json"), "{ corrupt");
  assert.equal((await wormCheckPr(pr, state, undefined, async () => ({ kind: "clean" }))).kind, "unavailable");
});

test("malware parking clears once the repo is no longer blocked; other parking stays", async () => {
  writeFileSync(path.join(dataDir, "worm-blocked.json"), "{}");
  const parked = { ...freshState(), parked: "malware-suspected: o/r is blocked", parkedSha: pr.headSha };
  assert.equal((await wormCheckPr(pr, parked, undefined, async () => ({ kind: "clean" }))).kind, "clean");
  assert.equal(parked.parked, undefined);
  const gaveUp = { ...freshState(), parked: "merge conflicts with main", parkedSha: pr.headSha };
  await wormCheckPr(pr, gaveUp, undefined, async () => ({ kind: "clean" }));
  assert.equal(gaveUp.parked, "merge conflicts with main");
});

// hooli-paving#16 (a Dependabot branch cut before the cleanup) carried a flagged file while main was
// clean. Every tick the PR was scanned → the whole repo blocked; every recheck main scanned clean →
// block lifted and the owner told "scans clean again". 220 rounds in five days.
test("a head that was flagged stays parked without being scanned again, so the repo isn't re-blocked", async () => {
  writeFileSync(path.join(dataDir, "worm-blocked.json"), "{}");
  const state = freshState();
  let scans = 0;
  const hit = await wormCheckPr(pr, state, undefined, async () => { scans++; return { kind: "blocked", reason: "malware-suspected: o/r (.vscode/settings.json)" }; });
  assert.equal(hit.kind, "blocked");
  assert.equal(state.wormHitSha, pr.headSha);
  // The clean recheck of the default branch lifted the repo block (file is back to {}). Next ticks:
  for (let i = 0; i < 3; i++) {
    const again = await wormCheckPr(pr, state, undefined, async () => { scans++; return { kind: "blocked", reason: "should not be called" }; });
    assert.equal(again.kind, "blocked");
    assert.match(again.kind === "blocked" ? again.reason : "", /^malware-suspected: this PR's branch \(feature @ aaaaaaa\)/);
  }
  assert.equal(scans, 1);
});

test("a flagged PR is scanned again as soon as its branch changes", async () => {
  writeFileSync(path.join(dataDir, "worm-blocked.json"), "{}");
  const state = { ...freshState(), wormHitSha: pr.headSha, parked: "malware-suspected: this PR's branch", parkedSha: pr.headSha };
  const rebuilt = { ...pr, headSha: "b".repeat(40) };
  let scans = 0;
  const r = await wormCheckPr(rebuilt, state, undefined, async () => { scans++; return { kind: "clean" }; });
  assert.equal(r.kind, "clean");
  assert.deepEqual([scans, state.wormHitSha, state.wormScannedSha, state.parked], [1, undefined, rebuilt.headSha, undefined]);
});

test("a worm block is logged once per head and never replaces a PR's own give-up reason", () => {
  const state = freshState();
  assert.equal(parkForWorm(state, pr.headSha, "malware-suspected: o/r is blocked"), true);
  assert.equal(parkForWorm(state, pr.headSha, "malware-suspected: o/r is blocked"), false);
  assert.equal(parkForWorm(state, "c".repeat(40), "malware-suspected: o/r is blocked"), true, "a new head is news again");
  // hooli-paving#3 gave up for its own reason; each block overwrote it and each lift made it give up again (490 times).
  const gaveUp = { ...freshState(), parked: "it has had merge conflicts for more than 30 days", parkedSha: pr.headSha };
  assert.equal(parkForWorm(gaveUp, pr.headSha, "malware-suspected: o/r is blocked"), false);
  assert.equal(gaveUp.parked, "it has had merge conflicts for more than 30 days");
});
