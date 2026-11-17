// usage × OS agent settings — the OS can only NARROW FRIDAY's spend/call caps, and a specialist's own
// row (status, daily budget, call cap) gates its runs.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-usage-settings-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;
delete process.env.DAY_MAX_COST_USD;
delete process.env.FRIDAY_AGENT_SETTINGS;

let S: typeof import("./agentSettings");
let U: typeof import("./usage");
let store: typeof import("@/lib/persistence/store");
before(async () => {
  S = await import("./agentSettings");
  U = await import("./usage");
  store = await import("@/lib/persistence/store");
});
after(() => rmSync(TMP, { recursive: true, force: true }));

function entry(key: string, over: Record<string, unknown> = {}) {
  return {
    agent_key: key, status: "active", display_name: null,
    model: {}, voice: { settings: {} }, prompts: {}, knowledge: {}, tools: { allowed: null, denied: [] },
    limits: { daily_budget_usd: null, max_tokens: null, max_calls_per_day: null, rate_limit_per_minute: null, max_turns: null },
    require_approval: false, ...over,
  };
}
const snap = (root: Record<string, unknown>, subs: Record<string, unknown>[] = []) =>
  S.parseSettingsResponse({ success: true, data: { ...root, subagents: subs } }, Date.now());

beforeEach(async () => {
  S._resetAgentSettingsCache(null);
  for (const c of await store.store.modelCalls.all()) await store.store.modelCalls.remove(c.id);
});

test("dayMaxCostUsd: env/default unless the OS sets a LOWER daily budget", () => {
  assert.equal(U.dayMaxCostUsd(), 40);
  S._resetAgentSettingsCache(snap(entry("friday", { limits: { daily_budget_usd: 12 } })));
  assert.equal(U.dayMaxCostUsd(), 12);
  S._resetAgentSettingsCache(snap(entry("friday", { limits: { daily_budget_usd: 500 } })));
  assert.equal(U.dayMaxCostUsd(), 40, "never raised");
});

test("withinSpendBudget honours the OS max_calls_per_day ceiling", async () => {
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i++) await store.store.modelCalls.insert({ id: `c${i}`, ts: now, engine: "codex" });
  assert.equal(await U.withinSpendBudget(), true, "no OS call cap");
  S._resetAgentSettingsCache(snap(entry("friday", { limits: { max_calls_per_day: 3 } })));
  assert.equal(U.dailyModelCallCap(), 3);
  assert.equal(await U.withinSpendBudget(), false);
  S._resetAgentSettingsCache(snap(entry("friday", { limits: { max_calls_per_day: 10 } })));
  assert.equal(await U.withinSpendBudget(), true);
});

test("settingsRunRefusal: paused FRIDAY, paused specialist, specialist budget and call cap", async () => {
  const dev = { id: "dev", role: "dev" };
  assert.equal(await U.settingsRunRefusal(dev), null, "no settings → runs");

  S._resetAgentSettingsCache(snap(entry("friday", { status: "paused" })));
  assert.match((await U.settingsRunRefusal(dev))!, /FRIDAY is paused/);

  S._resetAgentSettingsCache(snap(entry("friday"), [entry("friday.dev", { status: "disabled", display_name: "Dev" })]));
  assert.match((await U.settingsRunRefusal(dev))!, /Dev is disabled/);
  assert.equal(await U.settingsRunRefusal({ id: "qa", role: "qa" }), null, "other specialists unaffected");

  const now = new Date().toISOString();
  await store.store.modelCalls.insert({ id: "d1", ts: now, engine: "codex", agentRole: "dev", costUsd: 2.5 });
  await store.store.modelCalls.insert({ id: "q1", ts: now, engine: "codex", agentRole: "qa", costUsd: 9 });
  S._resetAgentSettingsCache(snap(entry("friday"), [entry("friday.dev", { limits: { daily_budget_usd: 2 } })]));
  assert.match((await U.settingsRunRefusal(dev))!, /\$2\.00 daily budget \(\$2\.50 today/, "only dev's own spend counts");
  S._resetAgentSettingsCache(snap(entry("friday"), [entry("friday.dev", { limits: { max_calls_per_day: 1 } })]));
  assert.match((await U.settingsRunRefusal(dev))!, /used its 1 model calls/);
  S._resetAgentSettingsCache(snap(entry("friday"), [entry("friday.dev", { limits: { max_calls_per_day: 5, daily_budget_usd: 10 } })]));
  assert.equal(await U.settingsRunRefusal(dev), null);
});
