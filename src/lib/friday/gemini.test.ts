// gemini — generateContent caller for FRIDAY's router when the OS picks a Google model. All network
// is stubbed: these pin the wire translation (schema, contents, tool round-trip, signatures).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as G from "./gemini";

beforeEach(() => G._resetGeminiSignatures());

function stubFetch(responses: unknown[]) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const r = responses.shift();
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("geminiApiKey: GEMINI_API_KEY, else GOOGLE_AI_API_KEY, else null", () => {
  assert.equal(G.geminiApiKey({ GEMINI_API_KEY: " a ", GOOGLE_AI_API_KEY: "b" }), "a");
  assert.equal(G.geminiApiKey({ GOOGLE_AI_API_KEY: "b" }), "b");
  assert.equal(G.geminiApiKey({}), null);
});

test("toGeminiSchema: upper-case types, nullable unions, string enums, unsupported keys dropped, empty objects omitted", () => {
  const out = G.toGeminiSchema({
    type: "object",
    additionalProperties: false,
    $schema: "x",
    properties: {
      subagent: { type: "string", enum: ["builder", "qa-e2e"] },
      count: { type: ["integer", "null"], default: 3 },
      tags: { type: "array", items: { type: "string" } },
      empty: { type: "object", properties: {} },
    },
    required: ["subagent", "empty"],
  });
  assert.deepEqual(out, {
    type: "OBJECT",
    properties: {
      subagent: { type: "STRING", enum: ["builder", "qa-e2e"] },
      count: { nullable: true, type: "INTEGER" },
      tags: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["subagent"],
  });
  assert.equal(G.toGeminiSchema({ type: "object", properties: {} }), undefined, "no-arg tool → no parameters");
  const decl = G.toGeminiTools([{ name: "site_health", description: "d", input_schema: { type: "object", properties: {} } }]);
  assert.deepEqual(decl, [{ functionDeclarations: [{ name: "site_health", description: "d" }] }]);
  assert.equal(G.toGeminiTools([]), undefined);
});

test("toGeminiContents: roles, tool_use → functionCall, tool_result → functionResponse by name, images, merge", () => {
  const contents = G.toGeminiContents([
    { role: "user", content: "is anything broken?" },
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
    { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "tu_1", name: "site_health", input: { deep: true } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "all up", is_error: false }] },
  ]);
  assert.deepEqual(contents, [
    { role: "user", parts: [{ text: "is anything broken?" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] },
    { role: "model", parts: [{ text: "checking" }, { functionCall: { name: "site_health", args: { deep: true } } }] },
    { role: "user", parts: [{ functionResponse: { name: "site_health", response: { content: "all up" } } }] },
  ]);
  const g3 = G.toGeminiContents([{ role: "assistant", content: [{ type: "tool_use", id: "x", name: "t", input: {} }] }], { needsSignature: true });
  assert.equal(g3[0].parts[0].thoughtSignature, "skip_thought_signature_validator", "foreign call on Gemini 3 gets the documented placeholder");
});

test("fromGeminiResponse: text + functionCall → blocks, thoughts skipped, usage summed; empty/blocked throw", () => {
  const { blocks, usage } = G.fromGeminiResponse({
    candidates: [{ content: { parts: [{ thought: true, text: "hmm" }, { text: "On it." }, { functionCall: { name: "deploy", args: { project: "acme" } } }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125 },
  });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: "text", text: "On it." });
  assert.equal(blocks[1].type, "tool_use");
  assert.equal(blocks[1].name, "deploy");
  assert.deepEqual(blocks[1].input, { project: "acme" });
  assert.match(String(blocks[1].id), /^[a-zA-Z0-9_-]+$/, "id survives agent-core's sanitizer unchanged");
  assert.deepEqual(usage, { inputTokens: 100, outputTokens: 25, totalTokens: 125 });
  assert.throws(() => G.fromGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }), /blocked: SAFETY/);
  assert.throws(() => G.fromGeminiResponse({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }), /output budget/);
});

test("geminiCaller: endpoint, key in header (never the URL), system, tools, mode, budget; signature round-trips", async () => {
  const { fetchImpl, calls } = stubFetch([
    { candidates: [{ content: { parts: [{ functionCall: { name: "site_health", args: {} }, thoughtSignature: "SIG-1" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } },
    { candidates: [{ content: { parts: [{ text: "All sites up." }] } }] },
  ]);
  const usages: G.GeminiUsage[] = [];
  const call = G.geminiCaller("KEY-123", "gemini-3-pro-preview", 500, { deps: { fetchImpl }, onUsage: (u) => usages.push(u) });
  const tools = [{ name: "site_health", description: "health", input_schema: { type: "object", properties: {} } }];
  const first = await call({ system: "You are FRIDAY", tools, messages: [{ role: "user", content: "anything down?" }] });
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent");
  assert.ok(!calls[0].url.includes("KEY-123"));
  assert.equal((calls[0].init.headers as Record<string, string>)["x-goog-api-key"], "KEY-123");
  assert.deepEqual(calls[0].body.systemInstruction, { parts: [{ text: "You are FRIDAY" }] });
  assert.deepEqual(calls[0].body.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
  assert.deepEqual(calls[0].body.generationConfig, { maxOutputTokens: 500 });
  assert.equal(usages[0].totalTokens, 12);

  // The loop sends the assistant turn back with the tool result; the signature must ride along.
  const second = await call({
    system: "You are FRIDAY", tools, toolChoice: "none",
    messages: [
      { role: "user", content: "anything down?" },
      { role: "assistant", content: first },
      { role: "user", content: [{ type: "tool_result", tool_use_id: String(first[0].id), content: "ok" }] },
    ],
  });
  const contents = calls[1].body.contents as G.GeminiContent[];
  assert.equal(contents[1].parts[0].thoughtSignature, "SIG-1");
  assert.deepEqual(contents[2].parts[0].functionResponse, { name: "site_health", response: { content: "ok" } });
  assert.deepEqual(calls[1].body.toolConfig, { functionCallingConfig: { mode: "NONE" } });
  assert.deepEqual(second, [{ type: "text", text: "All sites up." }]);
});

test("geminiCaller: HTTP error surfaces status (so the router falls back)", async () => {
  const { fetchImpl } = stubFetch([new Response("quota", { status: 429 })]);
  const call = G.geminiCaller("k", "gemini-2.5-flash", 100, { deps: { fetchImpl } });
  await assert.rejects(call({ system: "", tools: [], messages: [{ role: "user", content: "hi" }] }), /Gemini 429: quota/);
});

test("geminiGenerateText: plain text in, text + usage out; no tools sent", async () => {
  const { fetchImpl, calls } = stubFetch([{ candidates: [{ content: { parts: [{ text: "Hello " }, { text: "Jordan." }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }]);
  const out = await G.geminiGenerateText({ key: "k", model: "models/gemini-2.5-flash", prompt: "Say hi", system: "terse", maxTokens: 50, deps: { fetchImpl } });
  assert.equal(out.text, "Hello Jordan.");
  assert.deepEqual(out.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  assert.match(calls[0].url, /models\/gemini-2\.5-flash:generateContent$/, "models/ prefix stripped");
  assert.equal(calls[0].body.tools, undefined);
});
