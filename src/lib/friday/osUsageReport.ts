// FRIDAY → OS model-call usage (OS MCP tool `agent_usage_report`, Orion mcp-server/src/tools/agent-usage.ts).
//
// FRIDAY keeps her own ledger of model calls (store.modelCalls: engine, model, tokens, cost, task).
// The OS Agent Health dashboard shows each agent's tokens and spend next to what the OS meters
// itself, so FRIDAY pushes new ledger rows there in small batches. The OS dedupes on our ledger id
// (external_id), so re-sending a row is a no-op — the cursor below only saves work, it isn't what
// keeps the data correct.
//
// Gates, in order (each returns a short status line for the scheduler log; nothing here throws):
//   FRIDAY_OS_USAGE_REPORT=off → skipped.
//   `agent_usage_report` not in agent-core's FRIDAY_OS_TOOLS → skipped. The native client's allow
//      predicate would refuse the call anyway; the allowlist (agent-core/src/osmcp/allowlists.ts)
//      needs the entry before this does anything.
//   not signed in to the OS → skipped.
//
// Not pushed: ~/.agentic-os/token-usage.jsonl. That file is the Agentic OS dashboard's own ledger
// (Claude agent chat, Hermes talk, Apollo …), not FRIDAY's agent work, and filing it under the
// `friday` agent in the OS would misattribute it.

import path from "node:path";
import { promises as fs } from "node:fs";
import type { ModelCall } from "@/lib/friday/types";

export const USAGE_TOOL = "agent_usage_report";
const BATCH = 200;          // the tool takes ≤500; smaller keeps one bad row from costing much
const MAX_BATCHES_PER_TICK = 5;

export interface UsageCall {
  id: string;
  ts: string;
  provider: string;
  model?: string;
  auth_type: "subscription" | "api_key" | "local" | "unknown";
  engine?: string;
  purpose?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number | null;
  cost_source?: "reported" | "estimated";
  task_ref?: string;
  status?: "ok" | "error";
}

// engine → [provider, auth type, how its cost figure is obtained (engines.ts costFromUsage)]
const ENGINE_MAP: Record<string, [string, UsageCall["auth_type"], UsageCall["cost_source"]]> = {
  claude: ["anthropic", "subscription", "reported"],         // Claude Code CLI on the owner's plan; CLI reports total_cost_usd
  codex: ["openai", "subscription", "estimated"],             // Codex CLI signed in to the ChatGPT workspace; blended estimate
  antigravity: ["google", "subscription", "estimated"],
  lmstudio: ["lmstudio", "local", "estimated"],
  hermes: ["minimax", "unknown", "estimated"],
  "gemini-api": ["google", "api_key", "estimated"],
  "anthropic-api": ["anthropic", "api_key", "estimated"],
};

const int = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined);

/** One ledger row → one agent_usage_report call entry. Pure. */
export function toUsageCall(c: ModelCall): UsageCall {
  const [provider, auth, costSource] = ENGINE_MAP[c.engine] ?? [c.provider ?? "unknown", "unknown", "estimated"];
  const cost = typeof c.costUsd === "number" && Number.isFinite(c.costUsd) && c.costUsd >= 0 ? c.costUsd : null;
  return {
    id: c.id,
    ts: c.ts,
    provider: c.provider ?? provider,
    ...(c.model ? { model: c.model.slice(0, 120) } : {}),
    auth_type: c.authType ?? auth,
    engine: c.engine.slice(0, 80),
    ...(c.agentRole ? { purpose: c.agentRole.slice(0, 120) } : {}),
    ...(int(c.tokensIn) !== undefined ? { input_tokens: int(c.tokensIn) } : {}),
    ...(int(c.tokensOut) !== undefined ? { output_tokens: int(c.tokensOut) } : {}),
    cost_usd: cost,
    ...(cost !== null ? { cost_source: costSource } : {}),
    ...(c.taskId || c.runId ? { task_ref: String(c.taskId ?? c.runId).slice(0, 200) } : {}),
    status: "ok",
  };
}

interface Cursor { ts: string; ids: string[] }

/**
 * Rows not yet pushed, oldest first: newer than the cursor, or at the cursor's timestamp but not in
 * its id set (ties). `sinceISO` bounds the very first push so a fresh install doesn't replay months.
 */
export function pendingCalls(rows: ModelCall[], cursor: Cursor | null, sinceISO: string): ModelCall[] {
  const floor = cursor?.ts ?? sinceISO;
  const seen = new Set(cursor?.ts ? cursor.ids : []);
  return rows
    .filter((r) => typeof r.ts === "string" && (r.ts > floor || (r.ts === floor && !seen.has(r.id))))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Advance the cursor past a pushed batch (sorted oldest first). Pure. */
export function advanceCursor(cursor: Cursor | null, batch: ModelCall[]): Cursor | null {
  if (!batch.length) return cursor;
  const ts = batch[batch.length - 1].ts;
  const atTs = batch.filter((r) => r.ts === ts).map((r) => r.id);
  return { ts, ids: cursor?.ts === ts ? Array.from(new Set([...cursor.ids, ...atTs])) : atTs };
}

export function usageReportEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.FRIDAY_OS_USAGE_REPORT ?? "on").trim().toLowerCase() !== "off";
}

export interface PushDeps {
  /** Default: agent-core FRIDAY_OS_TOOLS. */
  allowlist?: readonly string[];
  enabled?: () => boolean;
  rows?: () => Promise<ModelCall[]>;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  cursorFile?: string;
  now?: () => number;
  log?: (what: string, meta: Record<string, unknown>) => Promise<void>;
}

async function readCursor(file: string): Promise<Cursor | null> {
  try {
    const c = JSON.parse(await fs.readFile(file, "utf8")) as Cursor;
    return typeof c?.ts === "string" && Array.isArray(c.ids) ? c : null;
  } catch {
    return null;
  }
}

async function writeCursor(file: string, c: Cursor): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(c), "utf8");
  await fs.rename(`${file}.tmp`, file);
}

let allowlistWarned = false;

/** Push new ledger rows. Returns a status line; never throws. */
export async function pushModelCallUsage(deps: PushDeps = {}): Promise<string> {
  try {
    if (!usageReportEnabled()) return "usage report off (FRIDAY_OS_USAGE_REPORT=off)";
    const allowlist = deps.allowlist ?? (await import("@autom8ionlab/agent-core")).FRIDAY_OS_TOOLS;
    if (!allowlist.includes(USAGE_TOOL)) {
      if (!allowlistWarned) {
        allowlistWarned = true;
        await (deps.log ?? defaultLog)("os.usage_report_not_allowlisted", {
          tool: USAGE_TOOL,
          fix: "add \"agent_usage_report\" to FRIDAY_OS_TOOLS in agent-core/src/osmcp/allowlists.ts",
        });
      }
      return `${USAGE_TOOL} is not in FRIDAY_OS_TOOLS (agent-core allowlist) — usage not pushed`;
    }
    const enabled = deps.enabled ?? (await import("@/lib/friday/osClient")).osEnabled;
    if (!enabled()) return "os not connected";
    const store = deps.rows && deps.cursorFile ? null : await import("@/lib/persistence/store");
    const cursorFile = deps.cursorFile ?? path.join(store!.FRIDAY_DATA_DIR, "os-usage-cursor.json");
    const rows = await (deps.rows ?? (() => store!.store.modelCalls.all()))();
    const now = (deps.now ?? Date.now)();
    const backfillDays = Number(process.env.FRIDAY_OS_USAGE_BACKFILL_DAYS);
    const since = new Date(now - (Number.isFinite(backfillDays) && backfillDays >= 0 ? backfillDays : 7) * 86_400_000).toISOString();
    let cursor = await readCursor(cursorFile);
    const pending = pendingCalls(rows, cursor, since);
    if (!pending.length) return "usage: nothing new";
    const callTool = deps.callTool ?? (async (name: string, args: Record<string, unknown>) => {
      const { callOsTool } = await import("@/lib/friday/osTool");
      const r = await callOsTool(name, args);
      if (!r.ok) throw new Error(r.error);
      return r.data;
    });
    let accepted = 0;
    let rejected = 0;
    let batches = 0;
    for (let i = 0; i < pending.length && batches < MAX_BATCHES_PER_TICK; i += BATCH, batches++) {
      const batch = pending.slice(i, i + BATCH);
      const out = (await callTool(USAGE_TOOL, { calls: batch.map(toUsageCall) })) as { accepted?: number; rejected?: unknown[] } | null;
      accepted += typeof out?.accepted === "number" ? out.accepted : batch.length;
      rejected += Array.isArray(out?.rejected) ? out.rejected.length : 0;
      cursor = advanceCursor(cursor, batch);
      if (cursor) await writeCursor(cursorFile, cursor);
    }
    const left = Math.max(0, pending.length - batches * BATCH);
    return `usage: pushed ${accepted}${rejected ? `, ${rejected} rejected by the OS` : ""}${left ? `, ${left} queued for next tick` : ""}`;
  } catch (e) {
    // The scheduler logs the line; the cursor only advanced for batches the OS accepted.
    return `usage push failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`;
  }
}

async function defaultLog(what: string, meta: Record<string, unknown>): Promise<void> {
  try {
    const { logEvent } = await import("@/lib/persistence/store");
    await logEvent(what, meta, { level: "warn" });
  } catch { /* best-effort */ }
}

/** Test hook. */
export function _resetUsageReportWarnings(): void {
  allowlistWarned = false;
}
