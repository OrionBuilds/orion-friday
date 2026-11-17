// FRIDAY — the intent router's model call, honouring the OS's per-agent model settings.
//
// Order per call:
//   1. rate_limit_per_minute (OS) — over the limit → the call does not go out (the loop reports it).
//   2. each OS candidate (effective, then fallback — see agentSettings.modelCandidates):
//        anthropic → the API caller with that model, when ANTHROPIC_API_KEY is set
//        google    → the Gemini caller, when GEMINI_API_KEY / GOOGLE_AI_API_KEY is set
//        other     → skipped (no caller for that provider in FRIDAY)
//      A candidate that can't run is skipped and one that errors falls through to the next; both
//      are logged with the reason (once per agent+reason, so a misconfig doesn't flood the log).
//   3. the built-in default, exactly as before this change: the Anthropic API on claude-sonnet-5
//      with a key, otherwise the Claude/Codex CLI on the owner's subscription (intentCli.ts).
//
// max_tokens (OS) narrows each caller's own output cap: 1200 for Anthropic (agent-core's default),
// GEMINI_MAX_OUTPUT_TOKENS/8192 for Gemini (thinking tokens count there). The CLI has no such knob.

import { anthropicCaller, anthropicStreamingCaller } from "@autom8ionlab/agent-core";
import { geminiCaller, type CallModelInput, type ContentBlock, type GeminiUsage } from "@/lib/friday/gemini";
import { takeRateSlot, type ModelChoice } from "@/lib/friday/agentSettings";

export type Caller = (input: CallModelInput) => Promise<ContentBlock[]>;

export interface RouterModelOpts {
  /** "friday" or "friday.<subagent>" — rate-limit bucket and log tag. */
  agentKey: string;
  candidates: ModelChoice[];
  anthropicKey?: string | null;
  geminiKey?: string | null;
  onToken?: (text: string) => void;
  defaultModel: string;
  anthropicMaxTokens: number;
  geminiMaxTokens: number;
  rateLimitPerMinute: number | null;
  /** FRIDAY_GEMINI_TOOLS=off → Gemini only for tool-less turns; tool loops go to the default. */
  geminiTools?: boolean;
  log?: (what: string, meta?: Record<string, unknown>) => void | Promise<void>;
  /** Ledger hook for calls whose usage we can see (Gemini). */
  recordUsage?: (u: { provider: string; model: string; usage: GeminiUsage; agentKey: string }) => void;
  /** Injection points for tests. */
  make?: {
    anthropic?: (key: string, model: string, maxTokens: number, onToken?: (t: string) => void) => Caller;
    gemini?: (key: string, model: string, maxTokens: number, onUsage: (u: GeminiUsage) => void) => Caller;
    cli?: () => Caller;
  };
}

const logged = new Set<string>();
/** Test hook. */
export function _resetRouterModelLog(): void { logged.clear(); }

export function geminiToolsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.FRIDAY_GEMINI_TOOLS ?? "on").trim().toLowerCase() !== "off";
}

export function routerCallModel(o: RouterModelOpts): Caller {
  const note = (what: string, meta: Record<string, unknown>, dedupe: string) => {
    const k = `${o.agentKey}|${dedupe}`;
    if (logged.has(k)) return;
    logged.add(k);
    try { void o.log?.(what, { agent: o.agentKey, ...meta }); } catch { /* logging never breaks a turn */ }
  };
  const anthropic = o.make?.anthropic ?? ((key, model, max, onToken) =>
    (onToken ? anthropicStreamingCaller(key, onToken, model, max) : anthropicCaller(key, model, max)) as Caller);
  const gemini = o.make?.gemini ?? ((key, model, max, onUsage) => geminiCaller(key, model, max, { onUsage }) as Caller);
  const cli = o.make?.cli ?? (() => { throw new Error("no CLI caller configured"); });

  return async (input) => {
    if (!takeRateSlot(o.agentKey, o.rateLimitPerMinute)) {
      throw new Error(`rate limit: ${o.agentKey} is capped at ${o.rateLimitPerMinute} model calls per minute in the OS agent settings`);
    }
    for (const c of o.candidates) {
      const provider = c.provider ?? "";
      let caller: Caller | null = null;
      if (provider === "anthropic") {
        if (o.anthropicKey) caller = anthropic(o.anthropicKey, c.model_key, o.anthropicMaxTokens, o.onToken);
        else note("settings.model_skipped", { model: c.model_key, reason: "no ANTHROPIC_API_KEY — the router runs on the CLI" }, `noanthropic:${c.model_key}`);
      } else if (provider === "google") {
        if (!o.geminiKey) note("settings.model_skipped", { model: c.model_key, reason: "no GEMINI_API_KEY / GOOGLE_AI_API_KEY" }, `nogemini:${c.model_key}`);
        else if (input.tools.length && o.geminiTools === false) note("settings.model_skipped", { model: c.model_key, reason: "FRIDAY_GEMINI_TOOLS=off — tool loops stay on the default model" }, `geminitools:${c.model_key}`);
        else caller = gemini(o.geminiKey, c.model_key, o.geminiMaxTokens, (usage) => o.recordUsage?.({ provider: "google", model: c.model_key, usage, agentKey: o.agentKey }));
      } else {
        note("settings.model_skipped", { model: c.model_key, provider, reason: `no ${provider || "unknown"} caller in FRIDAY` }, `noprovider:${provider}:${c.model_key}`);
      }
      if (!caller) continue;
      try {
        return await caller(input);
      } catch (e) {
        // Not deduped: a live failure is worth one line per occurrence.
        try { void o.log?.("settings.model_failed", { agent: o.agentKey, provider, model: c.model_key, error: String(e instanceof Error ? e.message : e).slice(0, 200) }); } catch { /* never */ }
      }
    }
    return o.anthropicKey
      ? anthropic(o.anthropicKey, o.defaultModel, o.anthropicMaxTokens, o.onToken)(input)
      : cli()(input);
  };
}
