// qaHeal — round bookkeeping and the run-keyed "already QA'd / already fixing" guards.
//
// The guard that replaced the 24-character title-prefix test (2026-09-24 incident: every weekly deps
// sweep after the first was silently skipped because "[QA] [Deps] acme-aicoach" is exactly 24 chars).

import { test } from "node:test";
import assert from "node:assert/strict";
import { qaAlreadyRanFor, fixRoundExistsFor, nextFixTitle, parseFixRound, stripFixPrefix } from "./qaHeal";

const sib = (title: string, sourceRunId?: string) => ({ title, sourceRunId, sourceTaskId: undefined });

test("a 24-char title collision with an OLDER run's QA does NOT count as already QA'd", () => {
  const task = { id: "t2", runId: "run-2" };
  const siblings = [sib("[QA] [Deps] acme-aicoach weekly patch bumps", "run-1")];
  assert.equal(qaAlreadyRanFor(task, siblings), false);
});

test("a QA sibling spawned from THIS run counts", () => {
  const task = { id: "t2", runId: "run-2" };
  assert.equal(qaAlreadyRanFor(task, [sib("[QA] [Deps] acme-aicoach weekly patch bumps", "run-2")]), true);
});

test("non-QA siblings and tasks without a run never match", () => {
  assert.equal(qaAlreadyRanFor({ id: "t", runId: "run-2" }, [sib("[Fix R1] failing checks — x", "run-2")]), false);
  assert.equal(qaAlreadyRanFor({ id: "t", runId: undefined }, [sib("[QA] x", undefined)]), false);
});

test("fix rounds are also keyed by run", () => {
  assert.equal(fixRoundExistsFor({ id: "t", runId: "run-9" }, [sib("[Fix R1] failing checks — [Deps] globex-fl weekly patch bumps", "run-9")]), true);
  assert.equal(fixRoundExistsFor({ id: "t", runId: "run-9" }, [sib("[Fix R1] failing checks — [Deps] globex-fl weekly patch bumps", "run-8")]), false);
});

test("round titles still parse and never nest", () => {
  assert.equal(parseFixRound("[Fix R2] issues from QA — Thing"), 2);
  assert.equal(stripFixPrefix("[Fix R2] [Fix] Thing"), "Thing");
  assert.equal(nextFixTitle("[Fix R1] failing checks — Thing", "qa").title, "[Fix R2] issues from QA — Thing");
});

test("round titles: [Review Rn] and [Rebase Rn] parse, strip and chain like [Fix Rn]", async () => {
  const { nextFixTitle, parseFixRound, parseRoundKind, stripFixPrefix } = await import("./qaHeal");
  const r1 = nextFixTitle("[Deps] globex-fl weekly patch bumps", "review");
  assert.equal(r1.title, "[Review R1] review comments — [Deps] globex-fl weekly patch bumps");
  assert.equal(parseFixRound(r1.title), 1);
  assert.equal(parseRoundKind(r1.title), "review");
  const r2 = nextFixTitle(r1.title, "rebase");
  assert.equal(r2.title, "[Rebase R2] merge conflicts — [Deps] globex-fl weekly patch bumps");
  assert.equal(stripFixPrefix("[Review R2] review comments — [Fix R1] failing checks — feat: x"), "feat: x");
  assert.equal(parseFixRound("feat: x"), 0);
  assert.equal(parseRoundKind("[QA] feat: x"), null);
});
