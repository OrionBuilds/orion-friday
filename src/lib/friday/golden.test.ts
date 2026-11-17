// GOLDEN CATALOG TESTS — FRIDAY's intent-router tool catalog (master plan PR 0.2).
//
// One snapshot per tool covering its model-facing + governance surface: name, description,
// input_schema, and the authority metadata (actionClass / reversible / speed). The point is that a
// migration or refactor cannot SILENTLY change what the model sees or how classifyActionTier
// scores a tool — any drift fails here with a readable diff. run() bodies are deliberately NOT
// executed: every one reaches the persistence store, subprocesses, deploy rails or the network,
// and this suite must stay deterministic and offline.
//
// ADDED OR INTENTIONALLY CHANGED A TOOL? Regenerate the checked-in snapshots with:
//
//     npm run test:update
//
// then review the diff to src/lib/friday/golden.test.ts.snapshot and commit it alongside your
// catalog change. A failing "missing snapshot" run is the expected signal for a newly added tool.
//
// Runs via `npm test` — node's built-in runner (the AGENTOS-CORE house pattern) with
// --experimental-transform-types plus the resolver hooks in scripts/test/ts-app-hooks.mjs.

import { describe, test, snapshot } from "node:test";
import assert from "node:assert/strict";
import type { ToolDef } from "./intent";

// Tool descriptions interpolate the owner's first name, which otherwise comes from this machine's
// ~/.agentic-os config or owner profile (a generic "Alex" where there is none). Pin it before the
// catalog loads so the snapshots don't depend on who runs the suite.
process.env.AGENTIC_OS_USER_NAME = "Jordan Example";
const { TOOLS } = await import("./intent");

// The default snapshot serializer is single-line; pretty JSON makes catalog diffs reviewable.
snapshot.setDefaultSnapshotSerializers([(v: unknown) => JSON.stringify(v, null, 2)]);

/** Everything about a tool except its executable bodies (run / describe are functions). */
function surface(t: ToolDef) {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    actionClass: t.actionClass,
    reversible: t.reversible,
    speed: t.speed,
  };
}

describe("friday tool catalog", () => {
  test("roster (names, catalog order)", (t) => {
    t.assert.snapshot(TOOLS.map((tool) => tool.name));
  });

  test("tool names are unique", () => {
    const names = TOOLS.map((tool) => tool.name);
    assert.deepEqual(names, [...new Set(names)], "duplicate tool names crash the Anthropic call");
  });
});

for (const tool of TOOLS) {
  describe(`tool: ${tool.name}`, () => {
    test("golden surface", (t) => {
      t.assert.snapshot(surface(tool));
    });

    test("invariants", () => {
      assert.ok(tool.name.trim().length > 0, "name must be non-empty");
      assert.ok(tool.description.trim().length > 0, "description must be non-empty");
      assert.equal((tool.input_schema as { type?: unknown }).type, "object", "input_schema must be an object schema");
      assert.equal(typeof tool.reversible, "boolean", "reversible drives the approval gate — must be explicit");
      assert.ok(tool.speed === "fast" || tool.speed === "slow", "speed drives voice deferral");
      assert.ok(typeof tool.actionClass === "string" && tool.actionClass.length > 0, "every tool feeds classifyActionTier an actionClass");
      assert.equal(typeof tool.describe, "function");
      assert.equal(typeof tool.run, "function");
    });
  });
}
