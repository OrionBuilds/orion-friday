// Tolerant Orion tool calls for the 2026-10-28 audit fixes.
//
// Several of the tools FRIDAY now depends on (agent_code_runs_report, client_reviews_*,
// conversation_log_message, org_settings_get, …) ship in the OS batch that deploys separately
// from FRIDAY. Until that lands, a call can fail because the tool doesn't exist yet. The rule
// for every caller: LOG the miss (once per tool per process, so the log isn't flooded) and
// DEGRADE SAFELY — never crash a loop, and never fall back to the retired local/Gmail paths.
//
// It also classifies OS auth failures (`refresh_token_already_used` & friends). Those are the
// failure that cut FRIDAY off from the OS for 2.5 days unnoticed, so they are recorded here for
// the liveness alarm (see osLiveness.ts) instead of being swallowed as "just another error".

import { osClient, osEnabled } from "@/lib/friday/osClient";
import { logEvent } from "@/lib/persistence/store";

export type OsToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; missing: boolean; auth: boolean; error: string };

/** Unwrap an MCP `content` array into the JSON payload of its first text block. */
export function unwrapOs(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

/** List tools answer a bare array or `{ rows|data|items|<plural>: [] }` — take the first array. */
export function osRows<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    for (const val of Object.values(v as Record<string, unknown>)) if (Array.isArray(val)) return val as T[];
  }
  return [];
}

/** True when the error means "this tool doesn't exist (yet)" rather than "the tool ran and failed". */
export function isMissingToolError(e: unknown): boolean {
  const s = String(e instanceof Error ? e.message : e);
  return /not in this agent's allow-list/i.test(s)
    || /tool\s+["']?[\w.-]+["']?\s+not found/i.test(s)
    || /unknown tool/i.test(s)
    || /method not found/i.test(s)
    || /-32601/.test(s);
}

export { isOsAuthError, noteOsCallOutcome, osAuthFailureState } from "@/lib/friday/osAuthLedger";
import { isOsAuthError, noteOsCallOutcome, _resetOsAuthLedger } from "@/lib/friday/osAuthLedger";

/** Test hook. */
export function _resetOsToolState(): void {
  _resetOsAuthLedger();
  missingLogged.clear();
}

const missingLogged = new Set<string>();

export interface CallOsToolOpts {
  /** Injected client (tests / PollContext.osClient). Defaults to FRIDAY's native client. */
  client?: { callTool(name: string, args?: Record<string, unknown>): Promise<unknown> };
  /** Extra context for the miss/failure log line. */
  context?: Record<string, unknown>;
}

/**
 * Call an OS tool and never throw. A missing tool is logged once per process
 * (`os.tool_missing`) and reported as `{ok:false, missing:true}` so the caller can degrade.
 */
export async function callOsTool<T = unknown>(
  name: string,
  args: Record<string, unknown> = {},
  opts: CallOsToolOpts = {},
): Promise<OsToolResult<T>> {
  const client = opts.client ?? osClient;
  if (!opts.client && !osEnabled()) {
    return { ok: false, missing: false, auth: true, error: "Orion not connected" };
  }
  try {
    const raw = await client.callTool(name, args);
    if (opts.client) noteOsCallOutcome(null); // the native osClient records its own outcomes
    return { ok: true, data: unwrapOs(raw) as T };
  } catch (e) {
    if (opts.client) noteOsCallOutcome(e);
    const error = String(e instanceof Error ? e.message : e).slice(0, 300);
    const missing = isMissingToolError(e);
    const auth = isOsAuthError(e);
    if (missing) {
      if (!missingLogged.has(name)) {
        missingLogged.add(name);
        await logEvent("os.tool_missing", { tool: name, error, ...opts.context }, { level: "warn" }).catch(() => {});
      }
    } else {
      await logEvent("os.tool_failed", { tool: name, error, auth, ...opts.context }, { level: auth ? "error" : "warn" }).catch(() => {});
    }
    return { ok: false, missing, auth, error };
  }
}
