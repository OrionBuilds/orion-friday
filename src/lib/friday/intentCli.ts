// FRIDAY — a `callModel` for the intent router that runs on the Claude Code CLI instead of the
// Anthropic API.
//
// WHY THIS EXISTS. agent-core's router takes its model call as an injected function, and ships
// `anthropicCaller`, which needs ANTHROPIC_API_KEY. FRIDAY deliberately has no API key — her whole
// brain is the Claude Code CLI on the owner's subscription (engines.ts: "the user's Claude Code CLI
// (subscription login). Primary planner/dev brain"). The consequence went unnoticed for a while:
// runIntent returned `failed: true` on EVERY call, so her router had never once run and every
// request fell through to the planner — the exact fallback the router was built to fence off.
//
// So this bridges the two. The CLI has no native tool-calling wire format, so the contract is moved
// into the prompt: the tool catalog is rendered as JSON, and the model is required to answer with a
// small JSON envelope that is parsed back into the ContentBlocks the router already understands.
//
// WHAT THIS DOES NOT WEAKEN. The router's safety properties do not live here. Gating, approvals and
// the verbatim tool-result reply all sit in the loop, downstream of this function; a tool named in
// the envelope is still looked up, gated and executed by the loop exactly as an API tool_use block
// would be. A hallucinated tool name resolves to nothing and is reported, not run. This function
// can only ever propose.

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { completeJSON, defaultEngine } from "@/lib/friday/engines";
import type { Engine } from "@/lib/friday/types";
import { OWNER_FIRST } from "@/lib/friday/persona";

// Mirrors agent-core's ContentBlock/AnthropicMessage. Declared structurally rather than imported so
// this file has no build-order dependency on the shared package's type exports.
interface ContentBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; source?: { type: "base64"; media_type: string; data: string } }
interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
interface AnthropicMessage { role: "user" | "assistant"; content: string | ContentBlock[] | ToolResultBlock[] }

interface WireTool { name: string; description: string; input_schema: Record<string, unknown> }

/** What the model is required to return. Anything else is treated as plain text. */
interface Envelope {
  text?: string;
  tool_calls?: { name?: string; input?: Record<string, unknown> }[];
}

/**
 * Flatten one message's content into text the CLI can read.
 *
 * The router builds a real Anthropic-shaped conversation — an assistant turn holding tool_use
 * blocks, then a user turn holding the matching tool_result blocks. Rendering those faithfully is
 * what lets a second turn work ("find the event, then move it"): the model has to be able to see
 * what its own previous call returned.
 */
function renderContent(content: AnthropicMessage["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  // One permissive shape rather than the ContentBlock|ToolResultBlock union: intersecting them
  // narrows `type` to the literal "tool_result" and makes every other branch unreachable.
  type AnyBlock = { type: string; text?: string; name?: string; input?: unknown; content?: string; is_error?: boolean };
  for (const block of content as AnyBlock[]) {
    if (block.type === "image") parts.push("[attached an image — it's one of the image files you were given]");
    else if (block.type === "text" && block.text) parts.push(block.text);
    else if (block.type === "tool_use") parts.push(`[called ${block.name} with ${JSON.stringify(block.input ?? {})}]`);
    else if (block.type === "tool_result") {
      const label = block.is_error ? "FAILED" : "returned";
      parts.push(`[${label}: ${String(block.content ?? "").slice(0, 4000)}]`);
    }
  }
  return parts.join("\n");
}

function renderConversation(messages: AnthropicMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? OWNER_FIRST : "You"}: ${renderContent(m.content)}`)
    .join("\n\n");
}

function toolContract(tools: WireTool[]): string {
  const catalog = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  return [
    "You have a set of tools. They are the ONLY way you can affect anything or read live data.",
    "",
    "TOOLS:",
    JSON.stringify(catalog, null, 2),
    "",
    "Reply with ONLY a JSON object, no prose around it, in exactly this shape:",
    `{"text": "<what to say to ${OWNER_FIRST}>", "tool_calls": [{"name": "<tool name>", "input": {<arguments>}}]}`,
    "",
    "Rules:",
    '- To use tools, list them in "tool_calls". Use the exact tool names above and obey each input_schema.',
    '- To just talk, omit "tool_calls" (or pass an empty array) and put your reply in "text".',
    "- NEVER claim you did something unless you called the tool that does it. If you cannot do",
    "  something, say so plainly rather than describing it as done.",
    "- If a previous turn shows a tool result, use those real values in your answer. Do not invent",
    "  numbers, names, dates or outcomes that are not in a tool result.",
  ].join("\n");
}

/**
 * Build a `callModel` backed by the Claude CLI.
 *
 * Returns text-only content on any parse failure — never throws — so a malformed envelope ends the
 * turn honestly instead of surfacing as a router crash.
 */
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/**
 * The CLI can't take image blocks inline, so owner-attached images (already sanitized by the loop)
 * are written to a private per-call temp folder and handed to the engine as files: Codex attaches
 * them with --image, Claude opens them with its Read tool. Removed after the call.
 */
export async function imageFiles(messages: AnthropicMessage[]): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const blocks = messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as ContentBlock[]) : []))
    .filter((b) => b.type === "image" && b.source?.type === "base64" && b.source.data);
  if (!blocks.length) return { paths: [], cleanup: async () => {} };
  const dir = await mkdtemp(path.join(os.tmpdir(), "friday-intent-img-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const paths: string[] = [];
  try {
    for (const b of blocks) {
      const bytes = Buffer.from(b.source!.data, "base64");
      const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${EXT[b.source!.media_type] ?? "png"}`;
      const file = path.join(dir, name);
      if (!paths.includes(file)) { await writeFile(file, bytes, { mode: 0o600 }); paths.push(file); }
    }
  } catch (e) {
    // The caller has no cleanup handle yet — remove what was already written before rethrowing.
    await cleanup().catch(() => {});
    throw e;
  }
  return { paths, cleanup };
}

/**
 * Only Codex (--image) and Claude (Read tool) can look at an attached image; lmstudio, hermes and
 * antigravity ignore CompleteOpts.images. An image turn on one of those would get an answer about a
 * placeholder, so it runs on Codex instead (which fails over to Claude like any other turn).
 */
export function imageCapableEngine(selected: Engine): Engine {
  return selected === "codex" || selected === "claude" ? selected : "codex";
}

export function cliCaller(timeoutMs = 120_000) {
  return async (input: { system: string; tools: WireTool[]; messages: AnthropicMessage[] }): Promise<ContentBlock[]> => {
    const files = await imageFiles(input.messages);
    let env: Envelope | null;
    try {
      env = await completeJSON<Envelope>({
        system: `${input.system}\n\n${toolContract(input.tools)}`,
        prompt: renderConversation(input.messages),
        json: true,
        timeoutMs,
        // Read-only: the router's tools do their own work through FRIDAY's libraries. The CLI here is
        // only choosing between them, and must never touch the filesystem or run git to do that.
        write: false,
        images: files.paths.length ? files.paths : undefined,
        ...(files.paths.length ? { engine: imageCapableEngine(defaultEngine()) } : {}),
      });
    } finally {
      await files.cleanup().catch(() => {});
    }

    if (!env) return [{ type: "text", text: "" }];

    const blocks: ContentBlock[] = [];
    if (typeof env.text === "string" && env.text.trim()) blocks.push({ type: "text", text: env.text.trim() });

    const known = new Set(input.tools.map((t) => t.name));
    (env.tool_calls ?? []).forEach((call, i) => {
      // Drop anything not in the catalog here rather than downstream: the loop reports an unknown
      // tool as a failed call, which reads to the owner like their request broke when in fact the model
      // just named something that does not exist.
      if (!call?.name || !known.has(call.name)) return;
      blocks.push({
        type: "tool_use",
        // Stable within the turn, which is all the loop needs to pair a result to its call.
        id: `cli_${Date.now()}_${i}`,
        name: call.name,
        input: call.input ?? {},
      });
    });

    return blocks.length ? blocks : [{ type: "text", text: env.text?.trim() ?? "" }];
  };
}
