// routerModel — the router's model chain under OS settings: OS effective → OS fallback → built-in
// default, skips logged with a reason, rate limit enforced, default path unchanged with no settings.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { routerCallModel, _resetRouterModelLog, type RouterModelOpts, type Caller } from "./routerModel";
import { _resetRateWindows, type ModelChoice } from "./agentSettings";

beforeEach(() => { _resetRouterModelLog(); _resetRateWindows(); });

const m = (provider: string, model_key: string): ModelChoice => ({ id: model_key, model_key, provider, available: true });
const input = { system: "s", tools: [{ name: "t", description: "d", input_schema: { type: "object" } }], messages: [{ role: "user" as const, content: "hi" }] };
const reply = (who: string): Caller => async () => [{ type: "text", text: who }];
const fail = (msg: string): Caller => async () => { throw new Error(msg); };

function harness(over: Partial<RouterModelOpts> & { anthropicFails?: string[]; geminiFails?: string[] } = {}) {
  const used: string[] = [];
  const logs: { what: string; meta?: Record<string, unknown> }[] = [];
  const opts: RouterModelOpts = {
    agentKey: "friday",
    candidates: [],
    defaultModel: "claude-sonnet-5",
    anthropicMaxTokens: 1200,
    geminiMaxTokens: 8192,
    rateLimitPerMinute: null,
    log: (what, meta) => { logs.push({ what, meta }); },
    make: {
      anthropic: (_k, model, max) => { used.push(`anthropic:${model}:${max}`); return over.anthropicFails?.includes(model) ? fail(`anthropic ${model} down`) : reply(`anthropic:${model}`); },
      gemini: (_k, model, max) => { used.push(`google:${model}:${max}`); return over.geminiFails?.includes(model) ? fail(`gemini ${model} down`) : reply(`google:${model}`); },
      cli: () => { used.push("cli"); return reply("cli"); },
    },
    ...over,
  };
  return { call: routerCallModel(opts), used, logs };
}
const text = async (p: Promise<{ text?: string }[]>) => (await p)[0].text;

test("no OS model: exactly the old behaviour — API on claude-sonnet-5 with a key, CLI without", async () => {
  assert.equal(await text(harness({ anthropicKey: "k" }).call(input)), "anthropic:claude-sonnet-5");
  assert.equal(await text(harness({ anthropicKey: null }).call(input)), "cli");
});

test("OS google model with a Gemini key runs on Gemini with the Gemini budget", async () => {
  const h = harness({ candidates: [m("google", "gemini-2.5-pro")], geminiKey: "g", anthropicKey: null, geminiMaxTokens: 4000 });
  assert.equal(await text(h.call(input)), "google:gemini-2.5-pro");
  assert.deepEqual(h.used, ["google:gemini-2.5-pro:4000"]);
});

test("effective fails → OS fallback; both fail → built-in default; each failure logged", async () => {
  const h = harness({
    candidates: [m("google", "gemini-2.5-pro"), m("anthropic", "claude-opus-4-8")],
    geminiKey: "g", anthropicKey: "k", geminiFails: ["gemini-2.5-pro"], anthropicFails: ["claude-opus-4-8"],
  });
  assert.equal(await text(h.call(input)), "anthropic:claude-sonnet-5");
  assert.deepEqual(h.used, ["google:gemini-2.5-pro:8192", "anthropic:claude-opus-4-8:1200", "anthropic:claude-sonnet-5:1200"]);
  assert.deepEqual(h.logs.map((l) => l.what), ["settings.model_failed", "settings.model_failed"]);
  assert.match(String(h.logs[0].meta?.error), /gemini gemini-2.5-pro down/);
});

test("unrunnable candidates are skipped with a reason (logged once), never fatal", async () => {
  const h = harness({ candidates: [m("anthropic", "claude-opus-4-8"), m("openai", "gpt-5.5"), m("google", "gemini-2.5-pro")], anthropicKey: null, geminiKey: null });
  assert.equal(await text(h.call(input)), "cli");
  await h.call(input);
  const reasons = h.logs.map((l) => String(l.meta?.reason));
  assert.equal(h.logs.length, 3, "deduped across calls");
  assert.match(reasons[0], /no ANTHROPIC_API_KEY/);
  assert.match(reasons[1], /no openai caller/);
  assert.match(reasons[2], /no GEMINI_API_KEY/);
});

test("FRIDAY_GEMINI_TOOLS=off: tool turns go to the default, tool-less turns still use Gemini", async () => {
  const h = harness({ candidates: [m("google", "gemini-2.5-flash")], geminiKey: "g", anthropicKey: "k", geminiTools: false });
  assert.equal(await text(h.call(input)), "anthropic:claude-sonnet-5");
  assert.match(String(h.logs[0].meta?.reason), /FRIDAY_GEMINI_TOOLS=off/);
  assert.equal(await text(h.call({ ...input, tools: [] })), "google:gemini-2.5-flash");
});

test("rate_limit_per_minute: the call over the limit never goes out", async () => {
  const h = harness({ anthropicKey: "k", rateLimitPerMinute: 2, agentKey: "friday.builder" });
  await h.call(input);
  await h.call(input);
  await assert.rejects(h.call(input), /friday\.builder is capped at 2 model calls per minute/);
  assert.equal(h.used.length, 2);
});
