// prShepherd — the pure decision table that drives every open FRIDAY PR to a merge (or to one
// honest "I couldn't land this" email), plus backoff arithmetic. Effects are not exercised here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, backoffMs, freshState, isFridayPr, reviewRoundPrompt, trackPending, listChangedFilesVia, standingMergeApproval, MERGE_APPROVAL_STANDS_MS, type DecideInput, type PrState } from "./prShepherd";
import { maxReviewRounds } from "./qaHeal";
import type { PrReadiness } from "./prGate";
import type { ReviewFeedback } from "./prReview";

const NOW = Date.parse("2026-09-24T18:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function pr(over: Partial<PrReadiness> = {}): PrReadiness {
  return {
    url: "https://github.com/example-org/acme-aicoach/pull/55", number: 55, owner: "example-org", repo: "acme-aicoach",
    state: "OPEN", isDraft: false, title: "deps: weekly patch bumps (2026-09-24)", author: "example-org",
    headRefName: "deps/weekly-2026-09-24", baseRefName: "main", headSha: "69ef1facca141e31641e48d8c95b0860616ddb79",
    mergeable: "MERGEABLE", mergeState: "CLEAN", checks: "SUCCESS", coderabbitCheck: "pass", failingChecks: [], pendingChecks: [],
    createdAt: iso(2 * HOUR), updatedAt: iso(HOUR), ...over,
  };
}
const clean: ReviewFeedback = { fetchOk: true, headSha: "69ef1facca141e31641e48d8c95b0860616ddb79", actionable: [], skipped: [], summaries: [], humanChangesRequested: false, botReviewPending: false, botReviewedShas: [], coderabbitReviewedHead: true, coderabbitPresent: true };
function input(over: Partial<DecideInput> = {}): DecideInput {
  return {
    pr: pr(), review: clean, task: null, project: { id: "p1", name: "AI Coach Tool" }, siblings: [], state: freshState(),
    authority: { tier: 1, reason: "scheduler origin" }, clientSignoff: null, selfSource: false, hasRunArtifact: true, roundRunning: false, mode: "active", now: NOW,
    caps: { review: 2, rebase: 1, fix: 3 }, ...over,
  };
}
const feature = (over: Partial<PrReadiness> = {}) => pr({ headRefName: "friday/landers-video-hero", title: "feat(landers): video hero", ...over });
const actionable = (n: number): ReviewFeedback => ({ ...clean, actionable: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, threadId: `t${i}`, databaseId: i, author: "coderabbitai", bot: "coderabbit", body: "x", severity: "major", isResolved: false, isOutdated: false })) });

test("skips: off, not a FRIDAY branch, draft, parked on this sha, backoff", () => {
  assert.equal(decide(input({ mode: "off" })).kind, "skip");
  assert.deepEqual(decide(input({ pr: pr({ headRefName: "feature/owner-branch" }), hasRunArtifact: false })), { kind: "skip", reason: "not-friday" });
  assert.equal(decide(input({ pr: pr({ headRefName: "feature/owner-branch" }), hasRunArtifact: true })).kind, "merge", "a run artifact makes it FRIDAY's PR even on an odd branch");
  assert.deepEqual(decide(input({ pr: pr({ isDraft: true }) })), { kind: "skip", reason: "draft" });
  assert.deepEqual(decide(input({ state: { ...freshState(), parked: "x", parkedSha: pr().headSha } })), { kind: "skip", reason: "parked" });
  assert.equal(decide(input({ state: { ...freshState(), parked: "x", parkedSha: "older" } })).kind, "merge", "a new push un-parks");
  assert.deepEqual(decide(input({ state: { ...freshState(), nextAllowedAt: iso(-10 * MIN) } })), { kind: "skip", reason: "backoff" });
});

test("self-source (2026-10-23): shepherded + gated by default; skipped only with FRIDAY_SHEPHERD_SELFSOURCE=off", () => {
  const prev = process.env.FRIDAY_SHEPHERD_SELFSOURCE;
  try {
    delete process.env.FRIDAY_SHEPHERD_SELFSOURCE; // default: FRIDAY's own PRs go through the gated flow
    assert.notEqual(decide(input({ selfSource: true })).kind, "skip", "self-source goes through the review/merge gate by default");
    process.env.FRIDAY_SHEPHERD_SELFSOURCE = "off"; // opt out → old report-only behaviour
    assert.deepEqual(decide(input({ selfSource: true })), { kind: "skip", reason: "self-source" });
  } finally {
    if (prev === undefined) delete process.env.FRIDAY_SHEPHERD_SELFSOURCE;
    else process.env.FRIDAY_SHEPHERD_SELFSOURCE = prev;
  }
});

test("upkeep: a newer open sweep PR supersedes; the highest number wins", () => {
  const sib = [
    { number: 49, headRefName: "deps/weekly-2026-09-20", title: "deps: weekly patch bumps (2026-09-20)", state: "OPEN" as const },
    { number: 55, headRefName: "deps/weekly-2026-09-24", title: "deps: weekly patch bumps (2026-09-24)", state: "OPEN" as const },
    { number: 51, headRefName: "deps/weekly-2026-09-23", title: "deps: weekly patch bumps (2026-09-23)", state: "OPEN" as const },
    { number: 60, headRefName: "friday/feature", title: "feat: x", state: "OPEN" as const },
  ];
  assert.deepEqual(decide(input({ pr: pr({ number: 49, headRefName: "deps/weekly-2026-09-20" }), siblings: sib })), { kind: "close-superseded", by: 55 });
  assert.equal(decide(input({ pr: pr({ number: 55 }), siblings: sib })).kind, "merge", "the newest sweep is not superseded by a feature PR");
});

test("stale by age: conflicting upkeep >14d closes; conflicting feature >30d gives up once", () => {
  assert.equal(decide(input({ pr: pr({ mergeable: "CONFLICTING", createdAt: iso(20 * DAY) }) })).kind, "close-stale");
  assert.equal(decide(input({ pr: pr({ mergeable: "CONFLICTING", createdAt: iso(3 * DAY) }) })).kind, "rebase", "a young conflicting sweep is rebased, not closed");
  const old = decide(input({ pr: feature({ mergeable: "CONFLICTING", createdAt: iso(45 * DAY) }) }));
  assert.equal(old.kind, "give-up");
  assert.match((old as { why: string }).why, /30 days/);
});

test("conflicts: update-branch first, then a rebase round, then give up at the cap", () => {
  const first = decide(input({ pr: pr({ mergeable: "CONFLICTING" }) }));
  assert.deepEqual(first, { kind: "rebase", via: "update-branch" });
  const second = decide(input({ pr: pr({ mergeable: "CONFLICTING" }), state: { ...freshState(), lastAction: "rebase:update-branch" } }));
  assert.deepEqual(second, { kind: "rebase", via: "round" });
  const capped = decide(input({ pr: pr({ mergeable: "CONFLICTING" }), state: { ...freshState(), rebaseRounds: 1 } }));
  assert.equal(capped.kind, "give-up");
});

test("failing checks: fix rounds up to the cap, then give up naming the checks", () => {
  assert.equal(decide(input({ pr: pr({ checks: "FAILURE", failingChecks: ["ci"] }) })).kind, "fix-checks");
  const g = decide(input({ pr: pr({ checks: "FAILURE", failingChecks: ["ci", "typecheck"] }), state: { ...freshState(), fixRounds: 3 } }));
  assert.equal(g.kind, "give-up");
  assert.match((g as { why: string }).why, /ci, typecheck/);
});

test("pending checks: wait, then give up after 45 minutes since the last push", () => {
  assert.deepEqual(decide(input({ pr: pr({ checks: "PENDING" }), state: { ...freshState(), lastPushSeenAt: iso(10 * MIN) } })), { kind: "wait", reason: "checks-pending" });
  assert.equal(decide(input({ pr: pr({ checks: "PENDING" }), state: { ...freshState(), lastPushSeenAt: iso(50 * MIN) } })).kind, "give-up");
  assert.deepEqual(decide(input({ pr: pr({ mergeable: "UNKNOWN" }), state: { ...freshState(), lastPushSeenAt: iso(MIN) } })), { kind: "wait", reason: "checks-pending" });
});

test("a round in flight waits; a finished round (head moved) resolves its threads first", () => {
  assert.deepEqual(decide(input({ roundRunning: true })), { kind: "wait", reason: "round-running" });
  const st = { ...freshState(), round: { kind: "review" as const, taskId: "t1", startedSha: "old", threads: [] } };
  assert.deepEqual(decide(input({ state: st })), { kind: "resolve-round" });
});

test("review: a human's changes-requested blocks; a pending bot review waits then nudges once; actionable threads → rounds up to the cap", () => {
  const h = decide(input({ review: { ...clean, humanChangesRequested: true, humanChangesRequestedBy: "example-org" } }));
  assert.equal(h.kind, "give-up");
  assert.match((h as { why: string }).why, /example-org requested changes/);
  assert.deepEqual(decide(input({ review: { ...clean, fetchOk: false } })), { kind: "wait", reason: "fetch-failed" });
  assert.deepEqual(decide(input({ review: actionable(3) })), { kind: "review-round", count: 3 });
  assert.equal(decide(input({ review: actionable(1), state: { ...freshState(), reviewRounds: 2 } })).kind, "give-up");
});

// A head nobody from CodeRabbit has reviewed: the context is pending/absent and no review names the sha.
const unreviewed = { ...clean, botReviewPending: true, coderabbitReviewedHead: false };
const uncovered = (over: Partial<PrReadiness> = {}) => pr({ coderabbitCheck: "pending", ...over });

test("coverage: the CodeRabbit check passing covers the head; a head review covers it only when no check is posted", () => {
  assert.equal(decide(input({ pr: pr({ coderabbitCheck: "pass" }), review: unreviewed })).kind, "merge");
  assert.equal(decide(input({ pr: pr({ coderabbitCheck: "absent" }), review: { ...unreviewed, coderabbitReviewedHead: true } })).kind, "merge");
  // A pending check ("Review in progress") wins over any review object on the head (agent-core#10).
  assert.deepEqual(
    decide(input({ pr: uncovered(), review: { ...unreviewed, coderabbitReviewedHead: true }, state: { ...freshState(), lastPushSeenAt: iso(5 * MIN) } })),
    { kind: "wait", reason: "review-pending" },
  );
  assert.deepEqual(decide(input({ pr: uncovered(), review: unreviewed, state: { ...freshState(), lastPushSeenAt: iso(5 * MIN) } })), { kind: "wait", reason: "review-pending" });
});

test("coverage: no bypass — ask CodeRabbit once per head after 15 min, give up after 2 h, never merge unreviewed", () => {
  const at = (ago: number, extra = {}) => decide(input({ pr: uncovered(), review: unreviewed, state: { ...freshState(), lastPushSeenAt: iso(ago), ...extra } }));
  assert.deepEqual(at(14 * MIN), { kind: "wait", reason: "review-pending" });
  assert.deepEqual(at(16 * MIN), { kind: "request-review" });
  assert.deepEqual(at(16 * MIN, { botReviewRequestedForSha: pr().headSha }), { kind: "wait", reason: "review-pending" }, "once per head sha");
  assert.deepEqual(at(50 * MIN, { botReviewRequestedForSha: pr().headSha }), { kind: "wait", reason: "review-pending" }, "the old 45-minute bypass is gone");
  const g = at(2 * HOUR + MIN, { botReviewRequestedForSha: pr().headSha });
  assert.equal(g.kind, "give-up");
  assert.equal((g as { why: string }).why, "CodeRabbit hasn't reviewed the latest changes; I won't merge unreviewed code");
  // after a fix round the nudge comes sooner (10 min)
  assert.deepEqual(at(11 * MIN, { lastAction: "resolve-round" }), { kind: "request-review" });
});

test("coverage: CodeRabbit not installed on the repo → give up at once, naming the repo", () => {
  const g = decide(input({ pr: uncovered({ coderabbitCheck: "absent" }), review: { ...unreviewed, coderabbitPresent: false }, repoHasCodeRabbit: false, state: { ...freshState(), lastPushSeenAt: iso(MIN) } }));
  assert.deepEqual(g, { kind: "give-up", why: "CodeRabbit isn't installed on example-org/acme-aicoach, so this can't be reviewed — install it on the repo" });
  assert.equal(decide(input({ pr: uncovered({ coderabbitCheck: "absent" }), review: { ...unreviewed, coderabbitPresent: false }, repoHasCodeRabbit: null, state: { ...freshState(), lastPushSeenAt: iso(MIN) } })).kind, "wait", "unknown is not 'not installed'");
});

test("loop: after a round pushes, the new head needs its own review before anything merges", () => {
  // The round started on the old head; a fix commit moved it. The old head's review does not count.
  const newHead = "f00dfacef00dfacef00dfacef00dfacef00dface";
  const round = { kind: "review" as const, taskId: "t1", startedSha: pr().headSha, threads: [] };
  const resolve = decide(input({ pr: uncovered({ headSha: newHead }), review: { ...unreviewed, headSha: newHead }, state: { ...freshState(), reviewRounds: 1, round } }));
  assert.equal(resolve.kind, "resolve-round");
  const after = decide(input({ pr: uncovered({ headSha: newHead }), review: { ...unreviewed, headSha: newHead }, state: { ...freshState(), reviewRounds: 1, lastAction: "resolve-round", lastPushSeenAt: iso(MIN) } }));
  assert.deepEqual(after, { kind: "wait", reason: "review-pending" });
  const reviewedWithFindings = decide(input({ pr: pr({ headSha: newHead }), review: { ...actionable(2), headSha: newHead }, state: { ...freshState(), reviewRounds: 1 } }));
  assert.deepEqual(reviewedWithFindings, { kind: "review-round", count: 2 }, "new findings on the new head start another round");
  assert.equal(decide(input({ pr: pr({ headSha: newHead }), review: { ...clean, headSha: newHead }, state: { ...freshState(), reviewRounds: 1 } })).kind, "merge");
});

test("round cap: the default is 4 review rounds", () => {
  const prev = process.env.FRIDAY_REVIEW_MAX_ROUNDS;
  delete process.env.FRIDAY_REVIEW_MAX_ROUNDS;
  try {
    assert.equal(maxReviewRounds(), 4);
    const d = (n: number) => decide(input({ review: actionable(1), state: { ...freshState(), reviewRounds: n }, caps: { review: maxReviewRounds(), rebase: 1, fix: 3 } }));
    assert.deepEqual(d(3), { kind: "review-round", count: 1 });
    const g = d(4);
    assert.equal(g.kind, "give-up");
    assert.match((g as { why: string }).why, /1 CodeRabbit finding still open after 4 fix rounds/);
  } finally {
    if (prev === undefined) delete process.env.FRIDAY_REVIEW_MAX_ROUNDS; else process.env.FRIDAY_REVIEW_MAX_ROUNDS = prev;
  }
});

test("review-round prompt requires a closing FIXED/DECLINED line per finding", () => {
  const p = reviewRoundPrompt(pr(), 2, "F1 ...\nF2 ...");
  assert.match(p, /FIXED F<n>/);
  assert.match(p, /DECLINED F<n>: <one-sentence reason>/);
  assert.match(p, /git push origin HEAD:deps\/weekly-2026-09-24/);
});

test("local QA is intentionally gone (owner rule 2026-10-02): a green PR merges with or without a QA stamp", () => {
  // Previously: a feature PR with no qaPassedAt returned { kind: "qa" } and the shepherd kept
  // dispatching rounds. Now the only gates are GitHub + CodeRabbit, so a feature PR merges when
  // every live gate above step (9) is green — qaPassedAt is no longer consulted.
  assert.equal(decide(input({ pr: feature(), task: null })).kind, "merge");
  assert.equal(decide(input({ pr: feature(), task: { qaPassedAt: iso(HOUR) } as never })).kind, "merge");
  assert.equal(decide(input({ pr: pr(), task: null })).kind, "merge", "upkeep is covered by checks + review");
});

test("client sign-off (opt-in per project): wait while pending, give up when rejected, merge when approved", () => {
  const proj = { id: "p1", name: "Globex", clientSignoff: true };
  const t = { qaPassedAt: iso(HOUR) } as never;
  assert.deepEqual(decide(input({ pr: feature(), task: t, project: proj, clientSignoff: "pending" })), { kind: "wait", reason: "client-signoff" });
  assert.deepEqual(decide(input({ pr: feature(), task: t, project: proj, clientSignoff: null })), { kind: "wait", reason: "client-signoff" });
  assert.equal(decide(input({ pr: feature(), task: t, project: proj, clientSignoff: "rejected" })).kind, "give-up");
  assert.equal(decide(input({ pr: feature(), task: t, project: proj, clientSignoff: "approved" })).kind, "merge");
  assert.equal(decide(input({ pr: feature(), task: t, project: { id: "p1", name: "Globex" }, clientSignoff: null })).kind, "merge", "not opted in → no wait");
});

test("authority: tier 3 asks through CLARA; tier 1 merges; real work with no checks at all never merges", () => {
  assert.deepEqual(decide(input({ authority: { tier: 3, reason: "money text" } })), { kind: "ask-clara", reason: "money text" });
  assert.equal(decide(input()).kind, "merge");
  assert.equal(decide(input({ pr: feature({ checks: "NONE" }), task: { qaPassedAt: iso(HOUR) } as never })).kind, "give-up");
  assert.equal(decide(input({ pr: pr({ checks: "NONE" }) })).kind, "merge", "upkeep on a repo with no checks still lands (review + mergeability gate it)");
});

test("dry mode still decides (the tick logs it) — effects are the caller's concern", () => {
  assert.equal(decide(input({ mode: "dry" })).kind, "merge");
});

test("backoff doubles per failed attempt and caps at 80 minutes", () => {
  assert.equal(backoffMs(0), 10 * MIN);
  assert.equal(backoffMs(1), 20 * MIN);
  assert.equal(backoffMs(3), 80 * MIN);
  assert.equal(backoffMs(9), 80 * MIN);
});

test("isFridayPr: branch prefix or a run artifact", () => {
  assert.equal(isFridayPr({ headRefName: "friday/x" }, false), true);
  assert.equal(isFridayPr({ headRefName: "deps/weekly-2026-09-24" }, false), true);
  assert.equal(isFridayPr({ headRefName: "main" }, false), false);
  assert.equal(isFridayPr({ headRefName: "main" }, true), true);
});

test("conflicts: a new conflict after main moved gets a fresh rebase; an overall ceiling still applies", () => {
  const spent = { ...freshState(), rebaseRounds: 1, rebaseTotal: 1, rebaseBaseSha: "base-old", lastAction: "rebase:round" };
  // Same base as the last rebase → cap reached → give up.
  assert.equal(decide(input({ pr: pr({ mergeable: "CONFLICTING", baseSha: "base-old" }), state: spent })).kind, "give-up");
  // Main moved since the last rebase → this is a new conflict → rebase again.
  assert.equal(decide(input({ pr: pr({ mergeable: "CONFLICTING", baseSha: "base-new" }), state: spent })).kind, "rebase");
  // A conflict give-up is not held as "parked" once main has moved.
  const parked = { ...spent, parked: "merge conflicts with main that I couldn't resolve in 1 attempt", parkedSha: "head1" };
  assert.equal(decide(input({ pr: pr({ mergeable: "CONFLICTING", baseSha: "base-new", headSha: "head1" }), state: parked })).kind, "rebase");
  // But never more than the overall ceiling, however often main moves.
  assert.equal(decide(input({ pr: pr({ mergeable: "CONFLICTING", baseSha: "base-new" }), state: { ...spent, rebaseTotal: 4 } })).kind, "give-up");
});

test("a legacy conflict give-up (no recorded base) is retried once main moves after the base is snapshotted", () => {
  const legacy = { ...freshState(), rebaseRounds: 1, parked: "merge conflicts with main that I couldn't resolve in 1 attempt", parkedSha: "head1" };
  // Before any snapshot there is no base to compare: still parked.
  assert.equal(decide(input({ pr: pr({ mergeable: "CONFLICTING", baseSha: "base-a", headSha: "head1" }), state: legacy })).kind, "skip");
  // After shepherdOne snapshots base-a (rebaseBaseSha + rebaseTotal), a newer main unparks it.
  const snap = { ...legacy, rebaseBaseSha: "base-a", rebaseTotal: 1 };
  assert.equal(decide(input({ pr: pr({ mergeable: "CONFLICTING", baseSha: "base-b", headSha: "head1" }), state: snap })).kind, "rebase");
});

// 2026-11-12, initech-box#25: green, reviewed, pushed an hour earlier. Its sibling #26 merged, GitHub
// took a moment to recompute mergeability, and the shepherd gave up on the spot ("checks have been
// pending for over 45 minutes (mergeability unknown)") because the wait was measured from the push.
test("a moment of unknown mergeability long after the push is a wait, not a give-up", () => {
  const state: PrState = { ...freshState(), lastHeadSha: feature().headSha, lastPushSeenAt: iso(58 * MIN) };
  const recomputing = feature({ mergeable: "UNKNOWN" });
  trackPending(state, recomputing, iso(0));
  assert.equal(state.pendingSince, iso(0));
  assert.deepEqual(decide(input({ pr: recomputing, state })), { kind: "wait", reason: "checks-pending" });
  // GitHub answers a minute later: the clock is cleared and the PR carries on to the merge gates.
  trackPending(state, feature(), iso(-MIN));
  assert.equal(state.pendingSince, undefined);
  assert.notEqual(decide(input({ pr: feature(), state, now: NOW + MIN })).kind, "give-up");
});

test("the wait clock runs from when pending was first seen and is not restarted by later ticks", () => {
  const state: PrState = { ...freshState(), lastPushSeenAt: iso(3 * HOUR) };
  const rerun = feature({ checks: "PENDING", pendingChecks: ["netlify/deploy-preview"] });
  trackPending(state, rerun, iso(50 * MIN));
  trackPending(state, rerun, iso(20 * MIN));
  assert.equal(state.pendingSince, iso(50 * MIN));
  const g = decide(input({ pr: rerun, state }));
  assert.equal(g.kind, "give-up");
  assert.match(g.kind === "give-up" ? g.why : "", /pending for over 45 minutes \(netlify\/deploy-preview\)/);
  // A re-run that started ten minutes ago on an old push still gets its 45 minutes.
  const fresh: PrState = { ...freshState(), lastPushSeenAt: iso(3 * HOUR) };
  trackPending(fresh, rerun, iso(10 * MIN));
  assert.deepEqual(decide(input({ pr: rerun, state: fresh })), { kind: "wait", reason: "checks-pending" });
});

test("a 'still pending' park is dropped once GitHub has an answer; every other park stays", () => {
  const sha = feature().headSha;
  const stuck: PrState = { ...freshState(), parked: "checks have been pending for over 45 minutes (mergeability unknown)", parkedSha: sha, pendingSince: iso(HOUR) };
  // Still unknown → still parked.
  trackPending(stuck, feature({ mergeable: "UNKNOWN" }), iso(0));
  assert.deepEqual(decide(input({ pr: feature({ mergeable: "UNKNOWN" }), state: stuck })), { kind: "skip", reason: "parked" });
  // Known again → un-parked and decided on its merits.
  trackPending(stuck, feature(), iso(0));
  assert.deepEqual([stuck.parked, stuck.parkedSha, stuck.pendingSince], [undefined, undefined, undefined]);
  assert.notDeepEqual(decide(input({ pr: feature(), state: stuck })), { kind: "skip", reason: "parked" });
  for (const why of ["3 CodeRabbit findings still open after 3 fix rounds", "merge conflicts with main that I couldn't resolve in 2 attempts", "malware-suspected: o/r is blocked"]) {
    const other: PrState = { ...freshState(), parked: why, parkedSha: sha };
    trackPending(other, feature(), iso(0));
    assert.equal(other.parked, why);
  }
});

test("the owner's yes to a merge holds for that commit until it lands; a new push, a no, or an old yes means asking again", () => {
  const url = "https://github.com/example-org/initech-box/pull/25";
  const sha = "543c81a3fb02f9b284508cad2eadf448949e13cc";
  const t0 = Date.parse("2026-11-12T18:22:00.000Z");
  const yes = { id: "a1", status: "approved" as const, mergePrUrl: url, mergeHeadSha: sha, decidedAt: new Date(t0).toISOString() };
  // Approved, the pass ended without merging (GitHub still computing), ready half an hour later: no second ask.
  assert.deepEqual(standingMergeApproval([yes], url, sha, t0 + 32 * 60_000), { id: "a1" });
  assert.equal(standingMergeApproval([yes], url, "0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", t0 + 60_000), null, "new commits need a new yes");
  assert.equal(standingMergeApproval([yes], "https://github.com/example-org/initech-box/pull/27", sha, t0 + 60_000), null, "another PR");
  assert.equal(standingMergeApproval([{ ...yes, status: "rejected" as const }], url, sha, t0 + 60_000), null);
  assert.equal(standingMergeApproval([{ ...yes, status: "pending" as const, decidedAt: undefined }], url, sha, t0 + 60_000), null);
  assert.equal(standingMergeApproval([{ ...yes, executedAt: new Date(t0 + 5_000).toISOString() }], url, sha, t0 + 60_000), null, "already carried out");
  assert.equal(standingMergeApproval([{ ...yes, mergeHeadSha: undefined }], url, sha, t0 + 60_000), null, "an approval that never recorded its commit doesn't carry over");
  assert.equal(standingMergeApproval([yes], url, sha, t0 + MERGE_APPROVAL_STANDS_MS + 1), null, "too old");
  assert.equal(standingMergeApproval([yes], url, sha, t0 - 1), null);
});

test("changed files come from gh, every page; a failed or short listing throws instead of reading as 'no files'", async () => {
  const calls: string[][] = [];
  const gh = (files: string, count: string) => async (args: string[]) => { calls.push(args); return args.includes("--paginate") ? files : count; };
  assert.deepEqual(await listChangedFilesVia(gh("src/lib/content.ts\nsupabase/migrations/20261112_x.sql\n", "2\n"), "example-org", "initech-box", 26), ["src/lib/content.ts", "supabase/migrations/20261112_x.sql"]);
  assert.deepEqual(calls[0], ["api", "--paginate", "repos/example-org/initech-box/pulls/26/files?per_page=100", "--jq", ".[].filename"]);
  await assert.rejects(listChangedFilesVia(gh("a.ts\n", "3\n"), "o", "r", 1), /incomplete file list for o\/r#1 \(1 of 3\)/);
  await assert.rejects(listChangedFilesVia(async () => { throw Object.assign(new Error("Command failed"), { stderr: "gh: Not Found (HTTP 404)\nmore" }); }, "o", "r", 2), /GitHub wouldn't list o\/r#2 files: gh: Not Found \(HTTP 404\)$/);
});
