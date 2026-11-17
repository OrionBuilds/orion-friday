// FRIDAY → Google Gemini (generateContent), used when the OS's effective model for an agent has
// provider "google" (Settings → AI Agents). Raw fetch, same as every other model call in this app.
//
// Two surfaces:
//   geminiGenerateText — plain text in, text out.
//   geminiCaller       — a drop-in `callModel` for agent-core's intent loop: translates the
//                        Anthropic-shaped conversation (text / tool_use / tool_result / image blocks)
//                        to Gemini contents + functionDeclarations and back, so the loop, its gates
//                        and its anti-lying defences never know which vendor answered.
//
// Gemini 3 models attach a `thoughtSignature` to function-call parts and reject the next turn if it
// is not echoed back. The loop strips nothing but would forward an unknown field to Anthropic if the
// call later fell back there, so signatures live in a side map keyed by the tool_use id we mint.
//
// Key: GEMINI_API_KEY, else GOOGLE_AI_API_KEY. Never logged, never put in a URL (header only).

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Gemini's own default output budget. Thinking tokens count against it, so it is not the Anthropic 1200. */
export const GEMINI_DEFAULT_MAX_OUTPUT = 8192;
/** Gemini's documented placeholder for a function call it did not itself produce (e.g. after a provider switch). */
const SKIP_SIGNATURE = "skip_thought_signature_validator";

export function geminiApiKey(env: Record<string, string | undefined> = process.env): string | null {
  return env.GEMINI_API_KEY?.trim() || env.GOOGLE_AI_API_KEY?.trim() || null;
}

/** Output budget for Gemini calls: GEMINI_MAX_OUTPUT_TOKENS or 8192. */
export function geminiMaxOutput(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.GEMINI_MAX_OUTPUT_TOKENS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : GEMINI_DEFAULT_MAX_OUTPUT;
}

// Structural mirrors of agent-core's intent wire types (same approach as intentCli.ts).
export interface ContentBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; source?: { type: "base64"; media_type: string; data: string } }
interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
export interface AnthropicMessage { role: "user" | "assistant"; content: string | ContentBlock[] | ToolResultBlock[] }
export interface WireTool { name: string; description: string; input_schema: Record<string, unknown> }
export interface CallModelInput { system: string; tools: WireTool[]; messages: AnthropicMessage[]; toolChoice?: "auto" | "none" }

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
}
export interface GeminiContent { role: "user" | "model"; parts: GeminiPart[] }
export interface GeminiUsage { inputTokens: number; outputTokens: number; totalTokens: number }

// ── Schema translation ──────────────────────────────────────────────────────────────────────────

const SCHEMA_KEYS = new Set([
  "type", "format", "description", "nullable", "enum", "items", "properties", "required", "anyOf",
  "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "pattern", "title",
]);

/**
 * JSON Schema (as written for Anthropic tools) → Gemini's OpenAPI-subset Schema. Unsupported keys are
 * dropped, `type` is upper-cased, `["string","null"]` becomes STRING + nullable, enum values become
 * strings, and an OBJECT with no properties is returned as undefined (Gemini rejects empty objects).
 */
export function toGeminiSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let type = s.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    if (nonNull.length !== type.length) out.nullable = true;
    type = nonNull[0];
  }
  if (typeof type !== "string" && s.properties && typeof s.properties === "object") type = "object";
  if (typeof type === "string") out.type = type.toUpperCase();
  for (const [k, v] of Object.entries(s)) {
    if (k === "type" || !SCHEMA_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        const conv = toGeminiSchema(pv);
        if (conv) props[pk] = conv;
      }
      if (Object.keys(props).length) out.properties = props;
    } else if (k === "items") {
      const conv = toGeminiSchema(v);
      if (conv) out.items = conv;
    } else if (k === "anyOf" && Array.isArray(v)) {
      const list = v.map(toGeminiSchema).filter(Boolean);
      if (list.length) out.anyOf = list;
    } else if (k === "enum" && Array.isArray(v)) {
      out.enum = v.filter((x) => x !== null).map((x) => String(x));
      if (!out.type) out.type = "STRING";
    } else if (k === "required" && Array.isArray(v)) {
      out.required = v.filter((x): x is string => typeof x === "string");
    } else {
      out[k] = v;
    }
  }
  if (out.type === "OBJECT") {
    if (!out.properties) return undefined;
    const props = out.properties as Record<string, unknown>;
    if (Array.isArray(out.required)) {
      out.required = (out.required as string[]).filter((r) => r in props);
      if (!(out.required as string[]).length) delete out.required;
    }
  }
  return out;
}

export function toGeminiTools(tools: WireTool[]): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
  if (!tools.length) return undefined;
  return [{
    functionDeclarations: tools.map((t) => {
      const parameters = toGeminiSchema(t.input_schema);
      return { name: t.name, description: t.description, ...(parameters ? { parameters } : {}) };
    }),
  }];
}

// ── Conversation translation ────────────────────────────────────────────────────────────────────

const signatures = new Map<string, string>();
const SIGNATURES_MAX = 500;
function rememberSignature(id: string, sig: string): void {
  signatures.set(id, sig);
  if (signatures.size > SIGNATURES_MAX) {
    const first = signatures.keys().next().value;
    if (first) signatures.delete(first);
  }
}

/** Anthropic-shaped messages → Gemini contents. Pure apart from reading the signature map. */
export function toGeminiContents(messages: AnthropicMessage[], opts: { needsSignature?: boolean } = {}): GeminiContent[] {
  const nameById = new Map<string, string>();
  const out: GeminiContent[] = [];
  for (const m of messages) {
    const role: GeminiContent["role"] = m.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    if (typeof m.content === "string") {
      if (m.content.trim()) parts.push({ text: m.content });
    } else {
      // One permissive shape (as in intentCli.ts): intersecting the union narrows `type` to "tool_result".
      type AnyBlock = Omit<ContentBlock, "type"> & Partial<Omit<ToolResultBlock, "type">> & { type: string };
      for (const b of m.content as AnyBlock[]) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          parts.push({ text: b.text });
        } else if (b.type === "tool_use" && b.name) {
          if (b.id) nameById.set(b.id, b.name);
          const sig = (b.id && signatures.get(b.id)) || (opts.needsSignature ? SKIP_SIGNATURE : undefined);
          parts.push({
            functionCall: { name: b.name, args: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown> },
            ...(sig ? { thoughtSignature: sig } : {}),
          });
        } else if (b.type === "tool_result") {
          const name = (b.tool_use_id && nameById.get(b.tool_use_id)) || "tool";
          parts.push({ functionResponse: { name, response: { content: String(b.content ?? ""), ...(b.is_error ? { error: true } : {}) } } });
        } else if (b.type === "image" && b.source?.type === "base64" && b.source.data) {
          parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
        }
      }
    }
    if (!parts.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else out.push({ role, parts });
  }
  return out;
}

let idCounter = 0;
function mintId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `gm_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/** Gemini generateContent JSON → ContentBlocks (+ usage). Throws when nothing usable came back. */
export function fromGeminiResponse(json: unknown): { blocks: ContentBlock[]; usage: GeminiUsage | null } {
  const j = (json ?? {}) as {
    candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
  };
  const u = j.usageMetadata;
  const usage: GeminiUsage | null = u
    ? {
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      totalTokens: u.totalTokenCount ?? (u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    }
    : null;
  const cand = j.candidates?.[0];
  if (!cand) throw new Error(`Gemini returned no candidates${j.promptFeedback?.blockReason ? ` (blocked: ${j.promptFeedback.blockReason})` : ""}`);
  const blocks: ContentBlock[] = [];
  for (const p of cand.content?.parts ?? []) {
    if (p.thought) continue;
    if (p.functionCall?.name) {
      const id = mintId();
      if (p.thoughtSignature) rememberSignature(id, p.thoughtSignature);
      blocks.push({ type: "tool_use", id, name: p.functionCall.name, input: p.functionCall.args ?? {} });
    } else if (typeof p.text === "string" && p.text) {
      blocks.push({ type: "text", text: p.text });
    }
  }
  if (!blocks.length) {
    const why = cand.finishReason === "MAX_TOKENS"
      ? "output budget exhausted before any answer (thinking tokens count against maxOutputTokens)"
      : `empty answer (finishReason ${cand.finishReason ?? "unknown"})`;
    throw new Error(`Gemini: ${why}`);
  }
  return { blocks, usage };
}

// ── Transport ───────────────────────────────────────────────────────────────────────────────────

export interface GeminiDeps { fetchImpl?: typeof fetch; timeoutMs?: number; baseUrl?: string }

export async function geminiGenerate(key: string, model: string, body: Record<string, unknown>, deps: GeminiDeps = {}): Promise<unknown> {
  const id = model.replace(/^models\//, "");
  const r = await (deps.fetchImpl ?? fetch)(`${deps.baseUrl ?? GEMINI_BASE_URL}/models/${encodeURIComponent(id)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 90_000),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.json();
}

/** Plain text generation. */
export async function geminiGenerateText(input: {
  key: string; model: string; prompt: string; system?: string; maxTokens?: number; deps?: GeminiDeps;
}): Promise<{ text: string; usage: GeminiUsage | null }> {
  const json = await geminiGenerate(input.key, input.model, {
    contents: [{ role: "user", parts: [{ text: input.prompt }] }],
    ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
    generationConfig: { maxOutputTokens: input.maxTokens ?? geminiMaxOutput() },
  }, input.deps);
  const { blocks, usage } = fromGeminiResponse(json);
  return { text: blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim(), usage };
}

/** A `callModel` for runIntentLoop that runs on Gemini. Same contract as agent-core's anthropicCaller. */
export function geminiCaller(
  key: string,
  model: string,
  maxTokens = geminiMaxOutput(),
  opts: { deps?: GeminiDeps; onUsage?: (u: GeminiUsage) => void } = {},
) {
  const needsSignature = /^(models\/)?gemini-3/i.test(model);
  return async (input: CallModelInput): Promise<ContentBlock[]> => {
    const tools = toGeminiTools(input.tools);
    const json = await geminiGenerate(key, model, {
      contents: toGeminiContents(input.messages, { needsSignature }),
      ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
      ...(tools ? { tools, toolConfig: { functionCallingConfig: { mode: input.toolChoice === "none" ? "NONE" : "AUTO" } } } : {}),
      generationConfig: { maxOutputTokens: maxTokens },
    }, opts.deps);
    const { blocks, usage } = fromGeminiResponse(json);
    if (usage) { try { opts.onUsage?.(usage); } catch { /* the ledger must never break a turn */ } }
    return blocks;
  };
}

/** Test hook. */
export function _resetGeminiSignatures(): void {
  signatures.clear();
}
