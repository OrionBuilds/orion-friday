// Tests for the post-scan prune: rows for files that vanished from a scanned source are dropped,
// everything else (unscanned sources, builtins, re-found rows) survives, and legacy rows without a
// sourceId are attributed from their id.

import { test } from "node:test";
import assert from "node:assert/strict";
import { staleRowIds, rowSource } from "./registryPrune";

const scanned = new Set(["claude-skills", "skills-library"]);

test("a row from a scanned source that was not re-found is pruned", () => {
  const existing = [{ id: "skill:claude-skills:gone", sourceId: "claude-skills" }, { id: "skill:claude-skills:kept", sourceId: "claude-skills" }];
  const fresh = [{ id: "skill:claude-skills:kept" }];
  assert.deepEqual(staleRowIds(existing, fresh, scanned), ["skill:claude-skills:gone"]);
});

test("rows from a source that was not scanned this pass are kept", () => {
  const existing = [{ id: "skill:marketing-souls:soul-a", sourceId: "marketing-souls" }];
  assert.deepEqual(staleRowIds(existing, [], scanned), []);
});

test("builtin ids without a source segment are never touched", () => {
  const existing = [{ id: "friday" }, { id: "architect" }];
  assert.deepEqual(staleRowIds(existing, [], scanned), []);
});

test("legacy rows without sourceId derive the source from the id", () => {
  assert.equal(rowSource({ id: "skill:skills-library:writing-plans" }), "skills-library");
  assert.equal(rowSource({ id: "clara" }), undefined);
  const existing = [{ id: "skill:skills-library:removed" }];
  assert.deepEqual(staleRowIds(existing, [], scanned), ["skill:skills-library:removed"]);
});

test("re-found rows are kept even when other rows of the same source are pruned", () => {
  const existing = [{ id: "agent:claude-skills:a" }, { id: "agent:claude-skills:b" }];
  const fresh = [{ id: "agent:claude-skills:b" }];
  assert.deepEqual(staleRowIds(existing, fresh, scanned), ["agent:claude-skills:a"]);
});
