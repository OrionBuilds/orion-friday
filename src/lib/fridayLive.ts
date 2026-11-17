// FRIDAY live-run model — a per-run, in-memory picture of what an agent is doing RIGHT NOW.
//
// The agent-dispatch path (orchestrator.executeRun) feeds this reducer the structured events it gets
// while streaming claude `--output-format=stream-json` / `codex exec --json` (and a raw-text tail for
// hermes/antigravity). The full stream (liveText + per-action timeline) lives ONLY here in memory —
// served to the viewer by GET /api/friday/runs/[id]/live. A compact snapshot (headline/bugCount/…) is
// throttle-written onto the AgentRun so plain /api/friday/runs polling can show a headline too.
//
// Mirrors the shape/patterns of ultracodeRuns.applyEvent (12k tail cap, token sum) but is dispatch-
// shaped (single agent + tool actions), not swarm-shaped (subagents/verdicts).

import { store, nowISO } from "@/lib/persistence/store";
import type { AgentRunLive } from "@/lib/friday/types";

export type LiveActionKind = "write" | "edit" | "read" | "command" | "search" | "web" | "other";
export interface LiveAction { kind: LiveActionKind; target: string; at: number }

export interface FridayLiveRun {
  runId: string;
  role: string;
  engine: string;
  status: "running" | "done" | "error" | "stopped";
  startedAt: number;
  updatedAt: number;
  headline?: string;
  liveText: string;        // streamed reasoning/output, capped to a 12k tail
  actions: LiveAction[];   // tool/file/command timeline, capped ~200
  tokens: number;
  bugCount: number;        // QA/review: running count of blocker/bug/should-fix markers
  checking?: string;       // QA/review: file/target currently under inspection
}

const TAIL = 12_000;
const MAX_ACTIONS = 200;
const QA_ROLES = new Set(["qa", "review", "research-qa", "debug"]);
const BUG_RE = /\b(blocker|must[- ]fix|should[- ]?fix|critical bug|\bbug\b|vulnerabilit|security issue)/gi;
const FAIL_RE = /VERDICT:\s*FAIL/gi;

// ── Registry ────────────────────────────────────────────────────────────────
const runs = new Map<string, FridayLiveRun>();

export function startLive(runId: string, role: string, engine: string): FridayLiveRun {
  const run: FridayLiveRun = {
    runId, role, engine, status: "running",
    startedAt: Date.now(), updatedAt: Date.now(),
    liveText: "", actions: [], tokens: 0, bugCount: 0,
  };
  runs.set(runId, run);
  return run;
}
export function getLive(runId: string): FridayLiveRun | null { return runs.get(runId) ?? null; }
export function listLive(): FridayLiveRun[] { return [...runs.values()]; }
export function endLive(runId: string, status: FridayLiveRun["status"]): void {
  const r = runs.get(runId);
  if (r) { r.status = status; r.updatedAt = Date.now(); }
  // keep it in the map briefly so a final poll can read the terminal state; drop after 60s
  setTimeout(() => runs.delete(runId), 60_000);
}

// ── Text + markers ──────────────────────────────────────────────────────────
function appendText(run: FridayLiveRun, t: string): void {
  if (!t) return;
  const next = run.liveText + t;
  run.liveText = next.length > TAIL ? next.slice(-TAIL) : next;
  run.updatedAt = Date.now();
  scanMarkers(run, t); // scan the DELTA only (avoids re-counting the capped tail)
}
function scanMarkers(run: FridayLiveRun, delta: string): void {
  const bugs = (delta.match(BUG_RE)?.length ?? 0) + (delta.match(FAIL_RE)?.length ?? 0);
  if (bugs) run.bugCount += bugs;
}
function pushAction(run: FridayLiveRun, kind: LiveActionKind, target: string, headline: string): void {
  run.actions.push({ kind, target, at: Date.now() });
  if (run.actions.length > MAX_ACTIONS) run.actions.splice(0, run.actions.length - MAX_ACTIONS);
  run.headline = headline;
  run.updatedAt = Date.now();
  if (kind === "read" && QA_ROLES.has(run.role) && target) run.checking = target;
}
const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n) + "…" : s);
const base = (p: string) => (p.includes("/") || p.includes("\\") ? p.split(/[/\\]/).pop() || p : p);

// Map a Claude tool_use (name + input) to a live action + a human headline.
function claudeTool(run: FridayLiveRun, name: string, input: Record<string, unknown>): void {
  const file = typeof input.file_path === "string" ? input.file_path : "";
  const cmd = typeof input.command === "string" ? input.command : "";
  const pat = typeof input.pattern === "string" ? input.pattern : (typeof input.query === "string" ? input.query : "");
  switch (name) {
    case "Write": return pushAction(run, "write", file, `Writing ${base(file)}`);
    case "Edit": case "MultiEdit": case "NotebookEdit": return pushAction(run, "edit", file, `Editing ${base(file)}`);
    case "Read": return pushAction(run, "read", file, `Reading ${base(file)}`);
    case "Bash": return pushAction(run, "command", cmd, `Running ${short(cmd, 48)}`);
    case "Grep": case "Glob": return pushAction(run, "search", pat, `Searching ${short(pat, 40)}`);
    case "WebFetch": case "WebSearch": return pushAction(run, "web", pat || file, `Browsing ${short(pat || file, 40)}`);
    default: return pushAction(run, "other", name, name);
  }
}

// ── Claude stream-json reducer ────────────────────────────────────────────────
export function applyClaudeEvent(run: FridayLiveRun, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const e = raw as Record<string, unknown>;
  const type = e.type;
  // Top-level streaming text (orchestrator output). Ignore subagent chatter (parent_tool_use_id set).
  if (type === "stream_event" && !e.parent_tool_use_id) {
    const ev = e.event as Record<string, unknown> | undefined;
    if (ev?.type === "content_block_delta") {
      const delta = ev.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.text === "string") appendText(run, delta.text);
    }
    return;
  }
  // Completed assistant message → tool_use blocks carry the full name + input (file_path/command).
  if (type === "assistant") {
    const msg = e.message as Record<string, unknown> | undefined;
    const content = Array.isArray(msg?.content) ? (msg!.content as Record<string, unknown>[]) : [];
    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        claudeTool(run, block.name, (block.input as Record<string, unknown>) ?? {});
      }
    }
    return;
  }
  if (type === "result") {
    const usage = e.usage as Record<string, unknown> | undefined;
    if (usage) {
      const n = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
        .reduce((s, k) => s + (typeof usage[k] === "number" ? (usage[k] as number) : 0), 0);
      if (n) run.tokens = n;
    }
  }
}

// ── Codex --json reducer ──────────────────────────────────────────────────────
export function applyCodexEvent(run: FridayLiveRun, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const e = raw as Record<string, unknown>;
  const type = e.type;
  if (type === "turn.completed") {
    const u = e.usage as Record<string, unknown> | undefined;
    if (u) {
      const n = ["input_tokens", "output_tokens", "reasoning_output_tokens"]
        .reduce((s, k) => s + (typeof u[k] === "number" ? (u[k] as number) : 0), 0);
      if (n) run.tokens = n;
    }
    return;
  }
  if (type === "item.started" || type === "item.completed") {
    const it = (e.item as Record<string, unknown>) ?? {};
    const itype = it.type;
    if (itype === "agent_message" || itype === "reasoning") {
      if (typeof it.text === "string") appendText(run, (type === "item.started" ? "" : it.text) || "");
      // note: reasoning/agent text often arrives complete on item.completed
      if (type === "item.completed" && typeof it.text === "string") { /* already appended */ }
    } else if (itype === "command_execution" && type === "item.started") {
      const cmd = typeof it.command === "string" ? it.command : "";
      pushAction(run, "command", cmd, `Running ${short(cmd, 48)}`);
      if (QA_ROLES.has(run.role) && cmd) run.checking = short(cmd, 60);
    } else if (itype === "file_change") {
      const f = typeof it.path === "string" ? it.path : (typeof it.file === "string" ? it.file : "");
      pushAction(run, "write", f, `Editing ${base(f)}`);
    } else if (itype === "web_search" && type === "item.started") {
      const q = typeof it.query === "string" ? it.query : "";
      pushAction(run, "web", q, `Searching ${short(q, 40)}`);
    }
  }
}

// Raw stdout tail (hermes/antigravity — no structured events).
export function applyRawChunk(run: FridayLiveRun, text: string): void { appendText(run, text); }

// ── Compact snapshot onto the AgentRun (throttled — store.runs.update rewrites runs.json) ──
const lastSnap = new Map<string, number>();
export async function maybeSnapshot(runId: string, force = false): Promise<void> {
  const run = runs.get(runId);
  if (!run) return;
  const now = Date.now();
  if (!force && now - (lastSnap.get(runId) ?? 0) < 2500) return;
  lastSnap.set(runId, now);
  const last = run.actions[run.actions.length - 1];
  const live: AgentRunLive = {
    headline: run.headline,
    lastAction: last ? `${last.kind}:${base(last.target)}` : undefined,
    actionsCount: run.actions.length,
    bugCount: run.bugCount,
    checking: run.checking,
    tokens: run.tokens,
    updatedAt: nowISO(),
  };
  try { await store.runs.update(runId, { live }); } catch { /* best-effort */ }
  if (force) lastSnap.delete(runId);
}
