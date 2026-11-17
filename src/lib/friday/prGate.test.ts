// prGate — the check rollup verdict (the only gate in front of a merge on repos with no branch
// protection) and PR-url parsing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupChecks, parsePrUrl } from "./prGate";

// Shape from `gh pr view --json statusCheckRollup` on acme-aicoach#55: CheckRuns carry
// status/conclusion, StatusContexts carry state; Netlify/CodeRabbit are contexts.
const GREEN = [
  { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS" },
  { __typename: "StatusContext", context: "netlify/acme-aicoach/deploy-preview", state: "SUCCESS" },
  { __typename: "StatusContext", context: "Header rules - acme-aicoach", state: "SUCCESS" },
  { __typename: "CheckRun", name: "codex", status: "COMPLETED", conclusion: "NEUTRAL" },
  { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
];

test("all passed (NEUTRAL/SKIPPED count as passed) → SUCCESS", () => {
  assert.deepEqual(rollupChecks(GREEN), { checks: "SUCCESS", failing: [], pending: [], coderabbit: "pass" });
});

test("a pending CheckRun → PENDING, naming it; a pending CodeRabbit review is reported separately", () => {
  const r = rollupChecks([...GREEN, { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null }]);
  assert.equal(r.checks, "PENDING");
  assert.deepEqual(r.pending, ["e2e"]);
  const cr = rollupChecks([{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", context: "CodeRabbit", state: "PENDING" }]);
  assert.equal(cr.checks, "SUCCESS", "CI is green; the review wait is the shepherd's coverage rule");
  assert.equal(cr.coderabbit, "pending");
  assert.equal(rollupChecks([{ __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS" }]).checks, "NONE", "CodeRabbit alone is not a CI check");
  assert.equal(rollupChecks([{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]).coderabbit, "absent");
});

test("any failure → FAILURE with the names; CodeRabbit failing is a failure even when ci passed", () => {
  const r = rollupChecks([...GREEN, { __typename: "CheckRun", name: "typecheck", status: "COMPLETED", conclusion: "FAILURE" }, { __typename: "StatusContext", context: "netlify/x/deploy-preview", state: "ERROR" }]);
  assert.equal(r.checks, "FAILURE");
  assert.deepEqual(r.failing, ["typecheck", "netlify/x/deploy-preview"]);
  const cr = rollupChecks([{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", context: "CodeRabbit", state: "FAILURE" }]);
  assert.equal(cr.checks, "FAILURE");
});

test("no checks at all → NONE (the shepherd refuses to merge real work on NONE)", () => {
  assert.equal(rollupChecks([]).checks, "NONE");
  assert.equal(rollupChecks(undefined).checks, "NONE");
});

test("PR url parsing", () => {
  assert.deepEqual(parsePrUrl("https://github.com/example-org/acme-aicoach/pull/55"), { owner: "example-org", repo: "acme-aicoach", number: 55 });
  assert.equal(parsePrUrl("https://github.com/example-org/acme-aicoach"), null);
});
