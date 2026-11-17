// agentSettings — fetch/cache/last-good for the OS per-agent settings, and the pure policy helpers
// (limits narrow only, tools never widen, explicit model/voice only, paused refuses work).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-agentsettings-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;
delete process.env.FRIDAY_AGENT_SETTINGS;
delete process.env.FRIDAY_AGENT_SETTINGS_ORG_DEFAULTS;

let S: typeof import("./agentSettings");
before(async () => { S = await import("./agentSettings"); });
beforeEach(() => { S._resetAgentSettingsCache(null); S._resetRateWindows(); rmSync(path.join(TMP, "agent-settings.last-good.json"), { force: true }); });
after(() => rmSync(TMP, { recursive: true, force: true }));

const model = (id: string, provider: string, key: string, available = true) =>
  ({ id, model_key: key, provider, display_name: key, context_window: null, max_output_tokens: null, available });

/** An agent-settings-get entry as the OS presents it (supabase/functions/agent-settings-get/index.ts). */
function entry(key: string, over: Record<string, unknown> = {}) {
  return {
    agent_key: key,
    parent_key: key.includes(".") ? "friday" : null,
    display_name: null,
    status: "active",
    model: { effective: null, primary: null, primary_source: "none", fallback: null, fallback_source: "none" },
    voice: { provider: "elevenlabs", voice_id: null, voice_name: null, available: null, source: "none", settings: {} },
    prompts: { persona_override: null, persona_mode: "append", templates: [] },
    knowledge: { collections: [], include_global: true, global_collections: [] },
    tools: { allowed: null, denied: [] },
    limits: { daily_budget_usd: null, max_tokens: null, max_calls_per_day: null, rate_limit_per_minute: null, max_turns: null },
    require_approval: false,
    updated_at: null,
    ...over,
  };
}
const body = (root: Record<string, unknown>, subs: Record<string, unknown>[] = []) =>
  ({ success: true, data: { ...root, subagents: subs, caller: { user_id: "u", role: "FridayAgent" }, generated_at: "2026-10-29T00:00:00Z" } });

function stubFetch(responses: Array<{ status?: number; json: unknown } | Error>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? new Error("no more responses");
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const deps = (fetchImpl: typeof fetch, now?: () => number) =>
  ({ fetchImpl, getJwt: async () => "jwt-123", enabled: () => true, baseUrl: "https://os.example", ...(now ? { now } : {}) });

// ── Parsing + fetch ──────────────────────────────────────────────────────────────────────────────

test("fetch posts include_subagents with the OS JWT and parses root + subagents keyed by agent key", async () => {
  const { fetchImpl, calls } = stubFetch([{ json: body(entry("friday"), [entry("friday.builder", { status: "paused" }), entry("clara.x")]) }]);
  const snap = await S.fetchAgentSettings(deps(fetchImpl));
  assert.equal(calls[0].url, "https://os.example/functions/v1/agent-settings-get");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer jwt-123");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { include_subagents: true });
  assert.equal(snap.root.agent_key, "friday");
  assert.deepEqual(Object.keys(snap.subagents), ["friday.builder"]); // foreign keys dropped
  assert.equal(snap.subagents["friday.builder"].status, "paused");
});

test("success:false, a non-2xx, or another agent's answer is a failed fetch", async () => {
  await assert.rejects(S.fetchAgentSettings(deps(stubFetch([{ json: { success: false, error: "Unauthenticated" } }]).fetchImpl)), /Unauthenticated/);
  await assert.rejects(S.fetchAgentSettings(deps(stubFetch([{ status: 403, json: { success: false, error: "nope" } }]).fetchImpl)), /403/);
  await assert.rejects(S.fetchAgentSettings(deps(stubFetch([{ json: body(entry("clara")) }]).fetchImpl)), /expected "friday"/);
});

test("not signed in to the OS → no request at all", async () => {
  const { fetchImpl, calls } = stubFetch([]);
  await assert.rejects(S.fetchAgentSettings({ ...deps(fetchImpl), enabled: () => false }), /not signed in/);
  assert.equal(calls.length, 0);
});

test("parseEntry coerces numeric strings and junk safely", () => {
  const e = S.parseEntry(entry("friday", { status: "weird", limits: { daily_budget_usd: "12.5", max_turns: "x" }, tools: { allowed: ["a", "a", " b ", 3], denied: null } }))!;
  assert.equal(e.status, "active");
  assert.equal(e.limits.daily_budget_usd, 12.5);
  assert.equal(e.limits.max_turns, null);
  assert.deepEqual(e.tools.allowed, ["a", "b"]);
  assert.deepEqual(e.tools.denied, []);
  assert.equal(S.parseEntry({ nope: 1 }), null);
});

// ── Cache / last-good ────────────────────────────────────────────────────────────────────────────

test("cache: fresh within 60s, refetch after; failure keeps last good and backs off for 60s", async () => {
  let t = 1_000_000;
  const now = () => t;
  const { fetchImpl, calls } = stubFetch([
    { json: body(entry("friday", { status: "active" })) },
    new Error("network down"),
    { json: body(entry("friday", { status: "paused" })) },
  ]);
  const d = deps(fetchImpl, now);
  const a = await S.getAgentSettings({ deps: d });
  assert.equal(a?.root.status, "active");
  t += 30_000;
  await S.getAgentSettings({ deps: d });
  assert.equal(calls.length, 1, "served from cache");
  t += 31_000;
  const b = await S.getAgentSettings({ deps: d });
  assert.equal(calls.length, 2);
  assert.equal(b?.root.status, "active", "last good on failure");
  assert.match(S.agentSettingsState().lastError ?? "", /network down/);
  t += 10_000;
  await S.getAgentSettings({ deps: d });
  assert.equal(calls.length, 2, "no retry inside the backoff window");
  t += 61_000;
  const c = await S.getAgentSettings({ deps: d });
  assert.equal(calls.length, 3);
  assert.equal(c?.root.status, "paused");
  assert.equal(S.agentSettingsState().lastError, null);
});

test("never fetched + OS down → null (built-in defaults), never throws", async () => {
  const { fetchImpl } = stubFetch([new Error("ECONNREFUSED")]);
  assert.equal(await S.getAgentSettings({ deps: deps(fetchImpl) }), null);
});

test("maxWaitMs bounds a slow fetch: returns last good/null and lets the fetch finish in the background", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fetchImpl = (async () => { await gate; return new Response(JSON.stringify(body(entry("friday", { status: "disabled" })))); }) as unknown as typeof fetch;
  const started = Date.now();
  const r = await S.getAgentSettings({ maxWaitMs: 20, deps: deps(fetchImpl) });
  assert.equal(r, null);
  assert.ok(Date.now() - started < 1_000);
  release();
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal(S.cachedAgentSettings()?.root.status, "disabled");
});

test("a good fetch is written to disk and survives a restart with the OS down", async () => {
  const { fetchImpl } = stubFetch([{ json: body(entry("friday", { status: "paused" })) }]);
  await S.refreshAgentSettings(deps(fetchImpl));
  await new Promise((r) => setTimeout(r, 20));
  const file = path.join(TMP, "agent-settings.last-good.json");
  assert.ok(existsSync(file));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).root.status, "paused");
  // "restart": empty memory, disk not yet loaded, OS unreachable.
  (globalThis as unknown as { __fridayAgentSettings?: unknown }).__fridayAgentSettings = undefined;
  const r = await S.getAgentSettings({ deps: deps(stubFetch([new Error("down")]).fetchImpl) });
  assert.equal(r?.root.status, "paused");
});

test("FRIDAY_AGENT_SETTINGS=off → null everywhere, no fetch", async () => {
  const { fetchImpl, calls } = stubFetch([{ json: body(entry("friday")) }]);
  process.env.FRIDAY_AGENT_SETTINGS = "off";
  try {
    assert.equal(await S.getAgentSettings({ deps: deps(fetchImpl) }), null);
    assert.equal(S.cachedAgentSettings(), null);
    assert.equal(calls.length, 0);
  } finally {
    delete process.env.FRIDAY_AGENT_SETTINGS;
  }
});

// ── Policy helpers ───────────────────────────────────────────────────────────────────────────────

const snapOf = (root: Record<string, unknown>, subs: Record<string, unknown>[] = []) => S.parseSettingsResponse(body(root, subs));

test("narrowCap only lowers; osOnlyCap narrows 'unlimited'", () => {
  assert.equal(S.narrowCap(40, null), 40);
  assert.equal(S.narrowCap(40, 100), 40, "an OS value can never raise a cap");
  assert.equal(S.narrowCap(40, 10), 10);
  assert.equal(S.narrowCap(40, 0), 0, "0 is a valid (fully closed) budget");
  assert.equal(S.narrowCap(6, 0, { min: 1, integer: true }), 1, "turns never drop below 1");
  assert.equal(S.narrowCap(6, 2.7, { integer: true }), 2);
  assert.equal(S.narrowCap(6, -3), 6);
  assert.equal(S.osOnlyCap(null), null);
  assert.equal(S.osOnlyCap(50), 50);
});

test("refusalFor: FRIDAY paused refuses everything; a paused subagent refuses only itself", () => {
  assert.equal(S.refusalFor(null), null);
  const paused = snapOf(entry("friday", { status: "paused" }));
  assert.match(S.refusalFor(paused)!, /FRIDAY is paused/);
  assert.match(S.refusalFor(paused, "builder")!, /FRIDAY is paused/);
  const sub = snapOf(entry("friday"), [entry("friday.qa", { status: "disabled", display_name: "QA" })]);
  assert.equal(S.refusalFor(sub), null);
  assert.equal(S.refusalFor(sub, "dev"), null, "no row → inherits FRIDAY (active)");
  assert.match(S.refusalFor(sub, "qa")!, /QA is disabled/);
  assert.match(S.refusalFor(sub, "friday.qa")!, /QA is disabled/);
});

test("settingsFor: subagent row when present, FRIDAY's otherwise", () => {
  const snap = snapOf(entry("friday", { limits: { max_turns: 4 } }), [entry("friday.builder", { limits: { max_turns: 2 } })]);
  assert.equal(S.settingsFor(snap, "builder")!.limits.max_turns, 2);
  assert.equal(S.settingsFor(snap, "reviewer")!.limits.max_turns, 4);
  assert.equal(S.settingsFor(snap)!.agent_key, "friday");
});

test("modelCandidates: explicit effective then fallback; org default ignored unless opted in; unavailable skipped", () => {
  const gem = model("m1", "google", "gemini-2.5-pro");
  const son = model("m2", "anthropic", "claude-sonnet-5");
  const explicit = S.parseEntry(entry("friday", { model: { effective: gem, primary: gem, primary_source: "agent", fallback: son, fallback_source: "agent" } }))!;
  assert.deepEqual(S.modelCandidates(explicit).map((m) => m.model_key), ["gemini-2.5-pro", "claude-sonnet-5"]);

  const orgOnly = S.parseEntry(entry("friday", { model: { effective: son, primary: son, primary_source: "org_default", fallback: null, fallback_source: "none" } }))!;
  assert.deepEqual(S.modelCandidates(orgOnly), []);
  assert.deepEqual(S.modelCandidates(orgOnly, { includeOrgDefault: true }).map((m) => m.model_key), ["claude-sonnet-5"]);

  const primaryDown = S.parseEntry(entry("friday", { model: { effective: son, primary: model("m1", "google", "gemini-2.5-pro", false), primary_source: "agent", fallback: son, fallback_source: "parent" } }))!;
  assert.deepEqual(S.modelCandidates(primaryDown).map((m) => m.model_key), ["claude-sonnet-5"], "effective = fallback (parent-sourced), deduped");
  assert.deepEqual(S.modelCandidates(null), []);
});

test("filterTools: catalog ∩ allowed − denied, never widens, allowed only binds a catalog it names", () => {
  const router = ["deploy", "dispatch_task", "list_projects", "site_health"];
  const osmcp = ["contacts_list", "projects_list"];
  const id = (t: string) => t;
  const e = S.parseEntry(entry("friday", { tools: { allowed: ["dispatch_task", "list_projects", "made_up_tool"], denied: ["list_projects", "projects_list"] } }))!;
  assert.deepEqual(S.filterTools(router, id, e), ["dispatch_task"], "made_up_tool is never added");
  assert.deepEqual(S.filterTools(osmcp, id, e), ["contacts_list"], "allowed names no OS MCP tool → only denied applies");
  assert.deepEqual(S.filterTools(router, id, null), router);
  const none = S.parseEntry(entry("friday", { tools: { allowed: [], denied: [] } }))!;
  assert.deepEqual(S.filterTools(router, id, none), router, "an empty allow list names nothing in the catalog");
});

test("applyPersona: append, replace, templates; no entry → unchanged", () => {
  assert.equal(S.applyPersona("SOUL", null), "SOUL");
  const app = S.parseEntry(entry("friday", { prompts: { persona_override: "Be terse.", persona_mode: "append", templates: [] } }))!;
  assert.equal(S.applyPersona("SOUL", app), "SOUL\n\nBe terse.");
  const rep = S.parseEntry(entry("friday", { prompts: { persona_override: "New persona.", persona_mode: "replace", templates: [{ id: "t", name: "Style", version: 2, body: "Use UK spelling." }] } }))!;
  assert.equal(S.applyPersona("SOUL", rep), "New persona.\n\n---\n\n## Style\nUse UK spelling.");
  assert.equal(S.applyPersona("", app), "Be terse.");
});

test("voiceFor: explicit available voice id + clamped settings; org default/unavailable ignored", () => {
  const v = S.parseEntry(entry("friday", { voice: { voice_id: "AbCdEfGhIjKlMnOpQr12", voice_name: "x", available: true, source: "agent", settings: { stability: 2, style: "0.2", similarity_boost: 0.5, use_speaker_boost: false } } }))!;
  assert.deepEqual(S.voiceFor(v), { voiceId: "AbCdEfGhIjKlMnOpQr12", stability: 1, similarity_boost: 0.5, style: 0.2, use_speaker_boost: false });
  const org = S.parseEntry(entry("friday", { voice: { voice_id: "AbCdEfGhIjKlMnOpQr12", available: true, source: "org_default", settings: {} } }))!;
  assert.equal(S.voiceFor(org).voiceId, null);
  const off = S.parseEntry(entry("friday", { voice: { voice_id: "AbCdEfGhIjKlMnOpQr12", available: false, source: "agent", settings: {} } }))!;
  assert.equal(S.voiceFor(off).voiceId, null);
  assert.equal(S.voiceFor(null).voiceId, null);
});

test("takeRateSlot: per-key 60s window", () => {
  assert.equal(S.takeRateSlot("k", null, 0), true);
  assert.equal(S.takeRateSlot("k", 2, 0), true);
  assert.equal(S.takeRateSlot("k", 2, 1), true);
  assert.equal(S.takeRateSlot("k", 2, 2), false);
  assert.equal(S.takeRateSlot("other", 2, 2), true);
  assert.equal(S.takeRateSlot("k", 2, 60_001), true, "window slides");
});
