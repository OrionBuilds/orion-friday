import { test } from "node:test";
import assert from "node:assert/strict";
import { dialSpec } from "./dials";

test("knowledge_daily_tokens dial starts low and offers 0 (stale-mark only) up to 1M", () => {
  const s = dialSpec("knowledge_daily_tokens")!;
  assert.equal(s.fallback, "100000");
  assert.ok(s.values.includes("0") && s.values.includes("1000000"));
  assert.equal(s.envVar, "FRIDAY_KNOWLEDGE_DAILY_TOKENS");
});

test("the feature flag stays off unless explicitly on", async () => {
  const { knowledgeEnabled } = await import("./projectKnowledge");
  assert.equal(knowledgeEnabled({}), false);
  assert.equal(knowledgeEnabled({ FRIDAY_PROJECT_KNOWLEDGE: "1" }), false);
  assert.equal(knowledgeEnabled({ FRIDAY_PROJECT_KNOWLEDGE: "on" }), true);
});
