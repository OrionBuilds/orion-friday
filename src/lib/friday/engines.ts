// FRIDAY engines — the brains FRIDAY and its agents can run on.
//
//   claude   → the user's Claude Code CLI (subscription login). Primary planner/dev brain.
//   lmstudio → local OpenAI-compatible server (LM Studio at :1234). Free/local brain for
//              routing, classification, drafting, and for running the whole loop offline.
//   codex/fcc → reserved (wired later via the existing CLI bridge).
//
// A single `complete()` returns a plain string; `completeJSON()` coerces to parsed JSON.
// Streaming for the chat UI is handled separately (see api/friday/chat).

import { run, spawnStream, type AgentName } from "@/lib/runner";
import { withUsSpelling } from "@/lib/friday/usEnglish";
import { config, CLAUDE_MODEL } from "@/lib/config";
import type { Engine } from "@/lib/friday/types";
import { extractJSON as sharedExtractJSON } from "@autom8ionlab/agent-core";
import { osAuth, osEnabled, OS_MCP_CONFIG_PATH, osCliAllowedTools, osCliMcpAllow } from "@/lib/friday/osClient";

// Read-shaped OS tool names (the planner's grounding surface). Exported for tests.
const OS_READ_TOOL = /(_list|_get|_search|_stats|_timeline)$|^agent_whoami$/;
export function osCliReadOnlyTools(agentId?: string): string {
  // OS agent settings narrow the list (osCliMcpAllow); no settings → OS_CLI_MCP_ALLOW unchanged.
  return osCliMcpAllow(agentId).filter((t) => OS_READ_TOOL.test(t.replace(/^mcp__orion__/, ""))).join(",");
}
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CompleteOpts {
  system?: string;
  prompt: string;
  engine?: Engine;
  cwd?: string;
  timeoutMs?: number;
  temperature?: number;
  json?: boolean; // hint the model to return JSON
  write?: boolean; // allow the agent to modify files + run git/network (coding roles). Default read-only.
  os?: boolean; // give a dispatched `claude -p` access to the Orion MCP (CRM) as FRIDAY's OS user.
  // With `os`, restrict the MCP surface to READ tools (list/get/search/…) and no local file/web tools.
  // The planner uses this to ground answers in OS data without being able to change anything.
  osReadOnly?: boolean;
  // Let the model READ the files under `cwd` (Read/Grep/Glob/LS) and nothing else: no shell, edits, network,
  // subagents or env/key files. Claude enforces it with an allow/deny list; Codex runs in its read-only sandbox.
  // Used by the project-knowledge explorer on a detached worktree. Ignored with `write` or `os`.
  readOnlyFiles?: boolean;
  // Live-streaming hooks (agent dispatch only). When onEvent is present AND AGENTIC_OS_FRIDAY_STREAM
  // !== "off", claude/codex run in structured-streaming mode and emit parsed events here as they work;
  // hermes/antigravity emit raw stdout via onChunk. onSpawn hands back the child so a Stop button can
  // kill it. All optional — the ~15 non-dispatch callers pass none and get today's buffered behaviour.
  runId?: string;
  onEvent?: (ev: unknown) => void;
  onChunk?: (text: string) => void;
  onSpawn?: (child: import("node:child_process").ChildProcess) => void;
  // Cost attribution (2.2) — carried through to the model-call ledger recorded in completeWithMeta.
  taskId?: string;
  projectId?: string;
  agentRole?: string;
  // Token capture (2.2) — each engine calls this with real usage when its output exposes it (LM Studio
  // usage block, Codex "tokens used" trailer, Claude stream result). Engines that can't stay silent.
  usageSink?: (u: TokenUsage) => void;
  // Extra env for the spawned agent process (e.g. the worm gate's hooks + PATH shims for write roles).
  extraEnv?: Record<string, string>;
  // Image files (absolute paths) the model should look at — owner-attached screenshots. Codex gets
  // them as `--image`; Claude reads them with its Read tool from an --add-dir'd folder. Other
  // engines ignore them.
  images?: string[];
}

/** Claude CLI args + prompt note so a headless `claude -p` can open the attached image files. */
export function claudeImageArgs(images: string[] | undefined): { args: string[]; note: string } {
  if (!images?.length) return { args: [], note: "" };
  const dirs = [...new Set(images.map((p) => path.dirname(p)))];
  return {
    // Attached form: `--add-dir` is variadic, so a separate value would swallow the prompt after it.
    args: dirs.map((d) => `--add-dir=${d}`),
    note: `\n\nAttached image file(s) — open each with your Read tool and look at it before answering:\n${images.map((p) => `- ${p}`).join("\n")}`,
  };
}

// Real token usage reported by an engine. Any field may be absent (not every CLI reports a split).
// costUsd is set only when the engine reports cost DIRECTLY (Claude's stream result total_cost_usd) —
// that's authoritative; otherwise the ledger derives cost from tokens + a price table.
export interface TokenUsage { tokensIn?: number; tokensOut?: number; tokensTotal?: number; costUsd?: number }

// Structured streaming is on unless explicitly disabled; the stream path only engages when a caller
// also passes onEvent, so it's scoped to agent dispatch.
const STREAM_DISPATCH = process.env.AGENTIC_OS_FRIDAY_STREAM !== "off";

// Which brain ACTUALLY served a completion (after any failover). Returned from completeWithMeta so
// callers can persist it per-run — the process-global lastBrainUsed() is last-write-wins and racy
// under concurrent dispatch, so it must never be the source of truth for a specific run.
export interface ServedBrain { engine: Engine; model?: string; fallback: boolean; intended: Engine }
export interface CompleteResult { text: string; served: ServedBrain }

// ── LM Studio (OpenAI-compatible) ────────────────────────────────────────
interface ChatMessage { role: "system" | "user" | "assistant"; content: string; }

// Which engines are CONFIGURED (binary/URL present). Cheap — no auth probe (the failover layer + the
// "last served" indicator surface real auth failures at run time). Powers the Brains card chips.
export async function engineHealth(): Promise<{ claude: boolean; codex: boolean; antigravity: boolean; hermes: boolean; lmstudio: boolean }> {
  const models = await lmStudioModels();
  return {
    claude: Boolean(config.claude),
    codex: Boolean((config as unknown as Record<string, unknown>).codex),
    antigravity: Boolean((config as unknown as Record<string, unknown>).antigravity),
    hermes: Boolean((config as unknown as Record<string, unknown>).hermes),
    lmstudio: models.length > 0,
  };
}

// Deep health — actually PROBES whether each engine can authenticate, not just whether its binary is
// present. authed: true = verified working, false = verified broken/unauthed, null = couldn't cheaply
// verify (binary present but login not probed). Cached ~60s on globalThis so the status poll (every
// ~8s) never storms the CLIs. Powers the Brains-card dot color.
export interface DeepHealth {
  configured: boolean;
  authed: boolean | null;
  detail?: string;
  // 2026-08-20: a failed auth probe used to always mean "re-login", but FRIDAY runs enough
  // concurrent claude CLI jobs to periodically trip its own session/usage limits, which fail the
  // probe the same way a genuine logout does — a "re-login" instruction is actively wrong there.
  // "transient" ⇒ don't page/don't say re-login; "auth" ⇒ genuine, keep today's behavior.
  reason?: "transient" | "auth" | "unknown";
}
export type DeepHealthMap = Record<Engine, DeepHealth>;
const deepHealthCache = globalThis as unknown as { __fridayDeepHealth?: { at: number; data: DeepHealthMap } };

// Confirmed from logs.jsonl (2026-08-20): real failures on this box include "You've hit your
// session limit · resets 5am" and an apiKeyHelper/ANTHROPIC_API_KEY precedence error — neither
// means the owner needs to run `claude`/login again, but the probe couldn't tell them apart from
// a genuine logout before this. Checked in order: an explicit auth marker wins over a transient
// one if a message somehow contains both (fail closed toward "needs a real look").
function classifyAuthFailure(text: string): "transient" | "auth" | "unknown" {
  if (/not logged in|please (run|log ?in)|\/login|invalid api key|unauthorized|\b401\b/i.test(text)) return "auth";
  if (/session limit|usage limit|rate limit|resets? (at|in|\d)/i.test(text)) return "transient";
  return "unknown";
}

async function probeCli(bin: AgentName, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; text: string }> {
  try {
    const out = await run(bin, args, { timeoutMs });
    return { ok: out.ok, text: `${out.stdout}\n${out.stderr}` };
  } catch (e) {
    return { ok: false, text: String(e) };
  }
}

export async function engineHealthDeep(): Promise<DeepHealthMap> {
  const cached = deepHealthCache.__fridayDeepHealth;
  if (cached && Date.now() - cached.at < 60_000) return cached.data;

  const cfg = config as unknown as Record<string, unknown>;
  const [models, codexProbe, claudeProbe, agyProbe] = await Promise.all([
    lmStudioModels(),
    Boolean(cfg.codex) ? probeCli("codex", ["login", "status"]) : Promise.resolve(null),
    // 6s used to be enough, but on this box `claude --version` measured ~9s live (2026-08-10) —
    // a tight timeout here reads as "claude not runnable" even when it's genuinely fine, which
    // would flip-flop the engine-auth-watch job's transition-only alerts once AGENTIC_OS_DEEP_AUTH_PROBE
    // is on. 15s matches the margin already given to the real completion probe below.
    Boolean(config.claude) ? probeCli("claude", ["--version"], 15000) : Promise.resolve(null),
    Boolean(cfg.antigravity) ? probeCli("antigravity", ["--version"], 6000) : Promise.resolve(null),
  ]);

  // Codex: `codex login status` prints the auth state.
  let codex: DeepHealth = { configured: Boolean(cfg.codex), authed: null };
  if (codexProbe) {
    if (codexProbe.ok && /logged in|authenticated|chatgpt|api key/i.test(codexProbe.text)) codex = { configured: true, authed: true, detail: "codex login ok" };
    else if (/not logged in|logged out|no.*credential|sign ?in|log ?in/i.test(codexProbe.text)) codex = { configured: true, authed: false, detail: "run `codex login`" };
    else codex = { configured: true, authed: codexProbe.ok ? null : false, detail: codexProbe.ok ? "status unclear" : "codex not runnable" };
  }

  // Claude: `--version` proves the binary only. A real auth probe (a tiny completion) is opt-in via
  // AGENTIC_OS_DEEP_AUTH_PROBE=1 because it costs tokens AND 401s inside a nested Claude Code session.
  let claude: DeepHealth = { configured: Boolean(config.claude), authed: null, detail: "login not probed (set AGENTIC_OS_DEEP_AUTH_PROBE=1)" };
  if (claudeProbe && !claudeProbe.ok) claude = { configured: true, authed: false, detail: "claude not runnable" };
  if (claudeProbe?.ok && process.env.AGENTIC_OS_DEEP_AUTH_PROBE === "1") {
    const ping = await probeCli("claude", ["-p", "--model", "haiku", "say ok"], 20000);
    const reason = classifyAuthFailure(ping.text);
    claude = {
      configured: true, authed: ping.ok, reason: ping.ok ? undefined : reason,
      detail: ping.ok ? "completion ok" : `${reason === "transient" ? "session/usage limit" : "auth/completion failed"} (nested session 401s here)`,
    };
  }

  // Antigravity: `--version` proves the binary; login can't be cheaply verified → null with a hint.
  let antigravity: DeepHealth = { configured: Boolean(cfg.antigravity), authed: null };
  if (agyProbe) antigravity = agyProbe.ok ? { configured: true, authed: null, detail: "binary ok — run `agy auth login` to enable" } : { configured: true, authed: false, detail: "agy not runnable" };

  // Hermes: NEVER invoke (~62s startup). Shallow FS check of its creds file.
  const hermesAuth = path.join(os.homedir(), ".hermes", "auth.json");
  const hermes: DeepHealth = Boolean(cfg.hermes)
    ? (existsSync(hermesAuth) ? { configured: true, authed: null, detail: "creds present (not invoked; ~62s startup)" } : { configured: true, authed: false, detail: "no ~/.hermes/auth.json" })
    : { configured: false, authed: false };

  const data: DeepHealthMap = {
    lmstudio: { configured: true, authed: models.length > 0, detail: `${models.length} model(s)` },
    codex, claude, antigravity, hermes,
  };
  deepHealthCache.__fridayDeepHealth = { at: Date.now(), data };
  return data;
}

export async function lmStudioModels(): Promise<string[]> {
  try {
    const r = await fetch(`${config.lmStudioBaseUrl}/models`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data ?? []).map((m: { id: string }) => m.id);
  } catch {
    return [];
  }
}

/**
 * Try to bring LM Studio back up, mirroring the supervisor's `Ensure-LMStudio` preflight.
 *
 * The supervisor only runs that preflight immediately before it starts Next (if you run one),
 * so it repairs LM Studio on a FRIDAY restart and never at any other time. If the local server dies
 * while FRIDAY is perfectly healthy — the common case, since it is a separate desktop app — nothing
 * brought it back and the failover brain was quietly absent until the next restart. The scheduler's
 * `lmstudio-watch` job calls this.
 *
 * `--bind 0.0.0.0` matters: config.lmStudioBaseUrl points at the Tailscale address, and the default
 * 127.0.0.1 bind does not answer there.
 */
export async function reviveLMStudio(): Promise<{ revived: boolean; detail: string }> {
  const { execFile } = await import("node:child_process");
  const isWindows = process.platform === "win32";
  const lms = (args: string[]) =>
    new Promise<boolean>((resolve) => {
      // shell:true only on Windows, where `lms` is a .cmd shim that execFile cannot exec directly.
      // Every argument below is a literal or the validated model id — no interpolated user input.
      execFile(isWindows ? "lms.cmd" : "lms", args, { timeout: 90_000, shell: isWindows, windowsHide: true },
        (err) => resolve(!err));
    });

  if (!(await lms(["version"]))) return { revived: false, detail: "lms CLI not installed" };
  await lms(["server", "start", "--bind", "0.0.0.0"]);

  // A pinned model id is a config value, but it reaches a shell — refuse anything that isn't the
  // conservative id charset rather than trusting the config file.
  const model = config.lmStudioModel;
  if (model && /^[\w.@:/-]+$/.test(model)) await lms(["load", model, "-y"]);

  const models = await lmStudioModels();
  return models.length > 0
    ? { revived: true, detail: `${models.length} model(s) after restart` }
    : { revived: false, detail: model ? `server start + load ${model} did not take` : "server start did not take" };
}

async function completeLMStudio(opts: CompleteOpts): Promise<string> {
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });
  let model = config.lmStudioModel;
  if (!model) {
    // Auto-pick a CHAT model. LM Studio's /models lists everything loaded, including embedding
    // models (e.g. text-embedding-nomic-…) which 400 on /chat/completions — skip those.
    const models = await lmStudioModels();
    model = models.find((m) => !/embed/i.test(m)) ?? models[0] ?? "local-model";
  }
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    stream: false,
  };
  // Note: we intentionally do NOT set response_format:{type:"json_object"} — LM Studio's
  // server rejects it (wants "json_schema" or "text"). JSON is enforced via the prompt and
  // recovered by extractJSON(), which tolerates fences/prose.
  const r = await fetch(`${config.lmStudioBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`LM Studio HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  if (j.usage) opts.usageSink?.({ tokensIn: j.usage.prompt_tokens, tokensOut: j.usage.completion_tokens, tokensTotal: j.usage.total_tokens });
  return j.choices?.[0]?.message?.content ?? "";
}

// ── Claude Code CLI ──────────────────────────────────────────────────────
/** Claude flags for an OS-enabled run. Pure and exported so a test can pin the `--allowedTools=` form. */
export function osCliArgs(opts: Pick<CompleteOpts, "osReadOnly" | "write" | "agentRole">): string[] {
  // Deliberately NO --dangerously-skip-permissions here: it silently VOIDS --allowedTools, which
  // would defeat scoping. acceptEdits + an explicit allow-list keeps the local + MCP surface bounded;
  // the real per-department boundary is server-side RLS on FRIDAY's scoped OS role.
  return [
    "--mcp-config", OS_MCP_CONFIG_PATH,
    "--strict-mcp-config",
    "--permission-mode", "acceptEdits",
    // Narrowed by the OS settings for this specialist (`friday.<role>`), else FRIDAY's own row.
    // `--flag=value` on purpose: the spaced form is variadic and swallows the prompt that follows it
    // as one more tool name ("Input must be provided…"), which broke every buffered OS run on Claude,
    // including the failover when Codex is out of credits (2026-11-10: 42 factory steps failed).
    `--allowedTools=${opts.osReadOnly ? osCliReadOnlyTools(opts.agentRole) : osCliAllowedTools(!!opts.write, opts.agentRole)}`,
  ];
}

// Extra flags + env that let a dispatched `claude -p` reach the Orion MCP as FRIDAY's OS user.
interface OsWiring { args: string[]; env: Record<string, string> }
async function osWiring(opts: CompleteOpts): Promise<OsWiring | null> {
  if (!opts.os) return null;
  if (!osEnabled()) {
    console.warn("[engines] os:true requested but FRIDAY isn't signed in to Orion — running without OS access (visit /api/os/auth)");
    return null;
  }
  let jwt: string;
  try { jwt = await osAuth.getFreshOsJwt(); }
  catch (e) { console.warn(`[engines] Orion JWT mint failed (${String(e).slice(0, 120)}) — running without OS access`); return null; }
  return {
    args: osCliArgs(opts),
    env: { ORION_JWT: jwt },
  };
}

/** Claude flags for `readOnlyFiles`: read tools only; everything that writes, runs or reaches out is denied. Exported for tests. */
export const CLAUDE_READ_ONLY_FILE_ARGS: string[] = [
  "--permission-mode", "default",
  // `--flag=value` on purpose: the space-separated form is variadic in the CLI and swallows the prompt
  // that follows as extra tool names. Only tool names the CLI knows (an unknown one aborts the run).
  "--allowedTools=Read,Grep,Glob,LS",
  "--disallowedTools=Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,TodoWrite,Read(**/.env*),Read(**/*.pem),Read(**/*.key),Read(**/secrets/**),Read(**/.ssh/**)",
];

async function completeClaude(opts: CompleteOpts, model: string = CLAUDE_MODEL): Promise<string> {
  const os = await osWiring(opts);
  // Live path: stream structured events for the viewer while returning the SAME final text.
  if (STREAM_DISPATCH && opts.onEvent) return streamClaude(opts, model, os);
  const args = ["-p", "--model", model];
  // Non-OS coding runs need to edit files + run git/gh; headless `claude -p` refuses tool calls
  // without this (it just describes what it "would" do). OS runs instead use acceptEdits +
  // an allow-list (added via os.args below) so skip-permissions can't void the MCP scoping.
  if (opts.write && !os) args.push("--dangerously-skip-permissions");
  if (opts.system) args.push("--append-system-prompt", opts.system);
  if (os) args.push(...os.args);
  else if (opts.readOnlyFiles && !opts.write) args.push(...CLAUDE_READ_ONLY_FILE_ARGS);
  const img = claudeImageArgs(opts.images);
  args.push(...img.args, opts.prompt + img.note);
  const out = await run("claude", args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 180_000, extraEnv: { ...opts.extraEnv, ...os?.env } });
  if (!out.ok) {
    throw new Error(`claude CLI failed (code ${out.code}): ${(out.stderr || out.stdout).slice(0, 300)}`);
  }
  return out.stdout.trim();
}

// Streaming Claude: same invocation + a stream-json output format so we can surface live tool activity.
// Returns the terminal `result` event's text — byte-identical to what buffered `claude -p` prints — so
// all downstream (G1 served, G3 verify) is unchanged. Empty stream rejects into the normal failover.
function streamClaude(opts: CompleteOpts, model: string, os: OsWiring | null = null): Promise<string> {
  const args = ["-p", "--model", model];
  if (opts.write && !os) args.push("--dangerously-skip-permissions");
  if (opts.system) args.push("--append-system-prompt", opts.system);
  if (os) args.push(...os.args);
  const img = claudeImageArgs(opts.images);
  args.push(...img.args, "--output-format=stream-json", "--include-partial-messages", "--verbose", opts.prompt + img.note);
  return new Promise<string>((resolve, reject) => {
    const child = spawnStream("claude", args, { cwd: opts.cwd, extraEnv: { ...opts.extraEnv, ...os?.env } });
    opts.onSpawn?.(child);
    let resultText = ""; let sawResult = false; let deltas = "";
    let buf = "";
    let capped = false;
    const timer = setTimeout(() => { capped = true; try { child.kill("SIGKILL"); } catch {} }, opts.timeoutMs ?? 180_000);
    const line = (l: string) => {
      const t = l.trim(); if (!t) return;
      let ev: unknown; try { ev = JSON.parse(t); } catch { return; }
      const e = ev as Record<string, unknown>;
      if (e.type === "result") {
        if (typeof e.result === "string") { resultText = e.result; sawResult = true; }
        const u = e.usage as Record<string, number> | undefined;
        const cost = typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined;
        if (u || cost !== undefined) opts.usageSink?.({ tokensIn: u?.input_tokens, tokensOut: u?.output_tokens, tokensTotal: (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) || undefined, costUsd: cost });
      }
      if (e.type === "stream_event" && !e.parent_tool_use_id) {
        const inner = (e.event as Record<string, unknown>)?.delta as Record<string, unknown> | undefined;
        if (inner && typeof inner.text === "string") deltas += inner.text;
      }
      try { opts.onEvent?.(ev); } catch { /* viewer must never break the run */ }
    };
    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString(); let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l); }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) line(buf);
      // Killed at the cap with no terminal `result`: the partial `deltas` are an unfinished
      // transcript ("…let me set up the branch and make the change"), NOT a result. Resolving them
      // marked a coding run done that had changed nothing (mAI Dashboard, 2026-09-14). Fail it.
      if (capped && !sawResult) return reject(new Error(runCapError("claude", opts.timeoutMs)));
      const text = (sawResult && resultText ? resultText : deltas).trim();
      if (text) return resolve(text);
      reject(new Error(`claude CLI failed (code ${code}): stream produced no result`));
    });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`claude CLI failed: ${String(e)}`)); });
  });
}

// ── Hermes (the "does things" agent — tool-calling) ──────────────────────
// Runs the Hermes CLI one-shot. Hermes uses its own configured provider chain
// (LM Studio primary → Claude fallback), so we don't pin a model here. --yolo
// skips interactive tool approvals (FRIDAY's own approval gate handles risk upstream).
async function completeHermes(opts: CompleteOpts): Promise<string> {
  const prompt = opts.system ? `${opts.system}\n\n${opts.prompt}` : opts.prompt;
  const out = await run("hermes", ["-z", prompt, "--yolo"], { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 180_000, onChunk: opts.onChunk, extraEnv: opts.extraEnv });
  if (!out.ok) throw new Error(`hermes CLI failed (code ${out.code}): ${(out.stderr || out.stdout).slice(0, 300)}`);
  return out.stdout.trim();
}

// ── Codex (OpenAI's coding agent — DevOps, QA, review, debugging) ─────────
// `codex exec` runs non-interactively. We pin a never-prompt policy + a sandbox
// (read-only by default so analysis/QA/review/debug can't mutate anything; FRIDAY's
// approval gate governs anything that needs write/deploy). Uses the user's `codex login`.
async function completeCodex(opts: CompleteOpts & { sandbox?: "read-only" | "workspace-write" }): Promise<string> {
  // Coding runs need writes + network (git push / gh pr create). On Windows, Codex's `workspace-write`
  // sandbox has no OS enforcement and silently degrades to read-only — only `danger-full-access`
  // actually permits writes. FRIDAY runs on the user's own machine in the project's repo checkout, so
  // full access is acceptable for the write path; analysis roles stay read-only.
  const sandbox = opts.write ? "danger-full-access" : (opts.sandbox ?? "read-only");
  const prompt = opts.system ? `${opts.system}\n\n${opts.prompt}` : opts.prompt;
  if (STREAM_DISPATCH && opts.onEvent) return streamCodex(opts, sandbox, prompt);
  // `codex exec -` reads the prompt from stdin (cleaner than a positional arg — no shell/
  // arg-length limits, and Codex prefers it non-interactively).
  // `--image=a,b` (attached form) so the trailing "-" is never swallowed as another image path.
  const args = ["exec", "--skip-git-repo-check", "-c", "approval_policy=never", "--sandbox", sandbox,
    ...(opts.images?.length ? [`--image=${opts.images.join(",")}`] : []), "-"];
  const out = await run("codex", args, { cwd: opts.cwd, input: prompt, timeoutMs: opts.timeoutMs ?? 180_000, extraEnv: opts.extraEnv });
  // The actionable error (auth/login/rate-limit) is at the END; the banner is at the head.
  if (!out.ok) throw new Error(`codex CLI failed (code ${out.code}): ${(out.stderr || out.stdout).slice(-500)}`);
  const tk = codexTokens(out.stdout);
  if (tk) opts.usageSink?.({ tokensTotal: tk });
  return extractCodexMessage(out.stdout);
}

/** The failure text from one `codex exec --json` event, or null. Codex emits
 *  {"type":"error","message":…} and {"type":"turn.failed","error":{"message":…}} when a turn can't run. */
export function codexEventError(e: Record<string, unknown>): string | null {
  if (e.type === "error" && typeof e.message === "string") return e.message;
  const err = e.error as Record<string, unknown> | undefined;
  if (e.type === "turn.failed" && err && typeof err.message === "string") return err.message;
  return null;
}

// Streaming Codex: `codex exec --json` emits one JSON event per line. Final text = the latest
// agent_message; fallback = extractCodexMessage over any non-JSON tail. Same sandbox/policy as buffered.
function streamCodex(opts: CompleteOpts, sandbox: string, prompt: string): Promise<string> {
  // Prompt via stdin (`-`) — codex prompts can exceed the OS/arg-length cap that safeArg enforces, so
  // a positional prompt would be dropped. spawnStream writes+ends stdin from opts.input for us.
  const args = ["exec", "--json", "--skip-git-repo-check", "-c", "approval_policy=never", "--sandbox", sandbox,
    ...(opts.images?.length ? [`--image=${opts.images.join(",")}`] : []), "-"];
  return new Promise<string>((resolve, reject) => {
    const child = spawnStream("codex", args, { cwd: opts.cwd, input: prompt, extraEnv: opts.extraEnv });
    opts.onSpawn?.(child);
    let finalMsg = ""; let rawTail = ""; let buf = "";
    let codexErr: string | null = null;
    let capped = false;
    const timer = setTimeout(() => { capped = true; try { child.kill("SIGKILL"); } catch {} }, opts.timeoutMs ?? 180_000);
    const line = (l: string) => {
      const t = l.trim(); if (!t) return;
      let ev: unknown; try { ev = JSON.parse(t); } catch { rawTail += l + "\n"; return; }
      const e = ev as Record<string, unknown>;
      const it = (e.item as Record<string, unknown>) ?? {};
      if (e.type === "item.completed" && it.type === "agent_message" && typeof it.text === "string") finalMsg = it.text;
      const failure = codexEventError(e);
      if (failure) codexErr = failure;
      // Best-effort token capture from any event carrying a usage/token count (codex --json shape varies).
      const usage = (e.usage ?? (e.info as Record<string, unknown>)?.usage) as Record<string, number> | undefined;
      const tot = usage?.total_tokens ?? (typeof e.token_count === "number" ? e.token_count : undefined);
      if (tot) opts.usageSink?.({ tokensTotal: tot, tokensIn: usage?.input_tokens, tokensOut: usage?.output_tokens });
      try { opts.onEvent?.(ev); } catch { /* viewer must never break the run */ }
    };
    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString(); let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l); }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) line(buf);
      const tk = codexTokens(rawTail);          // trailer fallback if no usage event fired
      if (tk) opts.usageSink?.({ tokensTotal: tk });
      // Same rule as streamClaude: an intermediate agent_message from a run killed at the cap is
      // not the run's answer.
      if (capped) return reject(new Error(runCapError("codex", opts.timeoutMs)));
      const text = (finalMsg || extractCodexMessage(rawTail)).trim();
      if (text) return resolve(text);
      // Codex reports why a turn failed as {"type":"error"} / {"type":"turn.failed"} events (out of
      // credits, auth, rate limits). Surface that text — the old generic message matched none of
      // the failover/usage-limit patterns, so an empty workspace balance looked like a hard failure
      // and every QA round died silently (2026-09-29).
      reject(new Error(`codex CLI failed (code ${code}): ${codexErr ?? "stream produced no message"}`));
    });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`codex CLI failed: ${String(e)}`)); });
  });
}

// `codex exec` prints a banner + role markers, then the assistant reply, then "tokens used\n<n>".
// Pull out just the assistant message so task results/Obsidian stay clean.
function extractCodexMessage(raw: string): string {
  let s = raw;
  const tok = s.lastIndexOf("\ntokens used");
  if (tok !== -1) s = s.slice(0, tok);
  const marker = s.lastIndexOf("\ncodex\n");
  if (marker !== -1) s = s.slice(marker + "\ncodex\n".length);
  return s.trim();
}

// Codex prints "tokens used\n<n>" (total for the exec). Pull it for the cost ledger (2.2).
function codexTokens(raw: string): number | undefined {
  const m = raw.match(/tokens used[:\s]+([\d,]+)/i);
  const n = m ? Number(m[1].replace(/,/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ── Antigravity (Google's agent — browser control & automations) ─────────
// `agy -p <prompt>` one-shot. Inert until the user installs `agy` and runs `agy auth login`.
async function completeAntigravity(opts: CompleteOpts): Promise<string> {
  const prompt = opts.system ? `${opts.system}\n\n${opts.prompt}` : opts.prompt;
  const out = await run("antigravity", ["-p", prompt], { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 300_000, onChunk: opts.onChunk, extraEnv: opts.extraEnv });
  if (!out.ok) throw new Error(`antigravity CLI failed (code ${out.code}): ${(out.stderr || out.stdout).slice(0, 300)}`);
  // Strip ANSI escapes the Antigravity TUI emits.
  return out.stdout.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
}

// ── Last-brain telemetry (which brain actually served the most recent request) ───────────
// Stored on globalThis so it's shared across all API route handlers in the process and survives
// Next.js dev HMR module re-evaluation (a plain module-level `let` gets reset per route/reload).
export interface BrainUsage { engine: Engine; model?: string; fallback: boolean; at: string }
const brainState = globalThis as unknown as { __fridayLastBrain?: BrainUsage | null };
export function lastBrainUsed(): BrainUsage | null { return brainState.__fridayLastBrain ?? null; }
function markBrain(engine: Engine, model: string | undefined, fallback: boolean): void {
  brainState.__fridayLastBrain = { engine, model, fallback, at: new Date().toISOString() };
}

// ── Unified surface ──────────────────────────────────────────────────────
export function defaultEngine(): Engine {
  // Explicit override wins (e.g. AGENTIC_OS_FRIDAY_ENGINE=claude to run fully on the CLI).
  const forced = process.env.AGENTIC_OS_FRIDAY_ENGINE as Engine | undefined;
  if (forced === "claude" || forced === "lmstudio" || forced === "codex" || forced === "antigravity" || forced === "hermes") return forced;
  // 2026-09-13 owner directive: LM Studio is retired — Codex is the default brain. A recoverable
  // Codex failure (auth / not installed) fails over to Claude in completeWithMeta below.
  return "codex";
}

// Faster brain for PHONE/VOICE turns — the caller is on the line waiting, so response latency matters
// more than the planner's absolute-best reasoning. Codex by default (LM Studio retired 2026-09-13);
// override with AGENTIC_OS_FRIDAY_VOICE_ENGINE. If Codex can't run, the built-in failover routes the
// turn to Claude, so this stays safe.
export function voiceEngine(): Engine {
  const forced = process.env.AGENTIC_OS_FRIDAY_VOICE_ENGINE as Engine | undefined;
  if (forced === "claude" || forced === "lmstudio" || forced === "codex" || forced === "antigravity" || forced === "hermes") return forced;
  return "codex";
}

function isAuthError(e: unknown): boolean {
  const s = String(e);
  return /401|authenticate|authentication_error|invalid.*credential/i.test(s);
}

// Owner-directed 2026-08-07: text the owner the moment their Claude subscription hits its usage limit.
//
// There is no supported way to read remaining capacity BEFORE it's exhausted — confirmed live,
// `claude auth status --json` returns only {loggedIn, authMethod, apiProvider}, and `claude --help`
// has no usage/quota subcommand at all. So this is reactive: catch the CLI's own refusal, not a
// meter. The exact wording of that refusal has never been observed in this codebase (no historical
// trace in any of the three agents' logs), so the match below is deliberately broad, and the FULL
// raw text is logged the first time it fires (see the caller in completeWithMeta) specifically so
// the pattern can be corrected from a real sample instead of staying a guess indefinitely.
export function isUsageLimitError(e: unknown): boolean {
  const s = String(e);
  // 429 only as an HTTP status ("HTTP 429", "status 429", "status code: 429", "429 Too Many Requests"),
  // never a bare number that happens to appear in a Codex/Claude error message.
  return /usage limit|usage_limit_exceeded|rate.?limit|quota exceeded|insufficient_quota|out of credits|add credits|credits? (?:depleted|exhausted)|too many requests|\b(?:http|status(?: code)?)\W{0,3}429\b/i.test(s);
}

// Best-effort: Claude Code CLI limit messages are commonly shaped like "reason|<epoch-seconds>".
// Returns null rather than throwing/guessing when no timestamp is present — the alert still fires
// without a reset time, it just can't tell the owner exactly when.
function parseUsageLimitResetAt(e: unknown): Date | null {
  const s = String(e);
  const m = s.match(/\|(\d{10,13})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  // 10 digits = seconds, 13 = milliseconds.
  const ms = m[1].length <= 10 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Pure: the owner-facing alert for a capped/out-of-credit engine. Codex "out of credits" is a
 *  billing question (money → the owner), so it's a plain timely email; a Claude cap keeps its page. */
export function usageLimitAlert(engine: Engine, e: unknown, now = new Date()): {
  text: string; headline: string; emergency: boolean; dedupeKey: string;
} {
  const resetAt = parseUsageLimitResetAt(e);
  const credits = /out of credits|add credits|credits? (?:depleted|exhausted)|insufficient_quota/i.test(String(e));
  if (engine === "codex") {
    return credits
      ? {
          headline: "Codex is out of credits",
          text: "The OpenAI Codex workspace FRIDAY uses is out of credits, so Codex can't run. She is switching her QA, review and coding work to Claude so nothing stalls. To bring Codex back, add credits to the OpenAI/ChatGPT workspace billing page.",
          emergency: false,
          dedupeKey: `usagelimit:codex:credits:${now.toISOString().slice(0, 10)}`,
        }
      : {
          headline: "Codex hit its usage limit",
          text: `Codex hit its usage limit${resetAt ? ` (resets ${resetAt.toLocaleString()})` : ""}. FRIDAY is switching to Claude until it resets.`,
          emergency: false,
          dedupeKey: `usagelimit:codex:${resetAt ? resetAt.toISOString() : now.toISOString().slice(0, 13)}`,
        };
  }
  return {
    headline: "Claude usage limit hit",
    text: resetAt
      ? `Claude usage limit hit, resets ${resetAt.toLocaleString()}. FRIDAY is switching to Codex until then; nothing's broken, just capped.`
      : "Claude usage limit hit. FRIDAY is switching to Codex until it resets. Check the Anthropic plan if this keeps happening.",
    emergency: true,
    dedupeKey: `usagelimit:${resetAt ? resetAt.toISOString() : now.toISOString().slice(0, 13)}`,
  };
}

async function notifyUsageLimitHit(e: unknown, engine: Engine = "claude"): Promise<void> {
  try {
    const alert = usageLimitAlert(engine, e);
    const { notifyOwner } = await import("@/lib/friday/notify");
    await notifyOwner({
      kind: "engine.usage_limit",
      priority: "critical",
      // A capped Claude subscription blocks FRIDAY's own dev/planning work, same as a lapsed CLI
      // login, so it keeps the "production" emergency category (notify.ts has no category rule for
      // this kind; without it a critical demotes to a timely email). Codex credits are a billing
      // matter for the owner — a timely email, not an emergency.
      ...(alert.emergency ? { emergencyCategory: "production" as const } : {}),
      headline: alert.headline,
      text: alert.text,
      dedupeKey: alert.dedupeKey,
    });
    const { logEvent } = await import("@/lib/persistence/store");
    await logEvent("engine.usage_limit_raw", { engine, raw: String(e).slice(0, 500) }, { level: "warn" }).catch(() => {});
  } catch { /* alerting must never break the completion path it's reporting on */ }
}

// External CLI engines (claude/codex/antigravity/hermes) can fail because they're not
// logged in OR not installed yet. In those cases fall back to the local LM Studio brain
// so FRIDAY keeps working instead of dead-ending.
const FAILOVER_ENGINES: Engine[] = ["claude", "codex", "antigravity"];

// When the local LM Studio brain fails for ANY reason (server down, no chat model loaded, model
// error, timeout), fall back to Claude's latest Sonnet via the CLI so FRIDAY keeps working.
// "sonnet" is a CLI alias that always resolves to the newest Sonnet; override with
// AGENTIC_OS_FRIDAY_FALLBACK_MODEL (e.g. a pinned "claude-sonnet-5").
const SONNET_FALLBACK_MODEL = process.env.AGENTIC_OS_FRIDAY_FALLBACK_MODEL?.trim() || "sonnet";
/**
 * Error for a streamed run killed at its time cap. Worded to match NONE of isRecoverable's patterns
 * (no "timed out", "SIGKILL", "code null", "limit", "log in"): a run that was working for the whole
 * cap is not a hung/missing CLI, and failing over would start the same long job from scratch on the
 * backup engine. The dispatcher marks the run failed and tells the owner instead.
 */
export function runCapError(engine: string, timeoutMs?: number): string {
  const mins = Math.round((timeoutMs ?? 180_000) / 60_000);
  return `${engine} run stopped at its ${mins}-minute cap before finishing — partial output discarded, nothing is assumed done`;
}

function isRecoverable(e: unknown): boolean {
  const s = String(e);
  return (
    isAuthError(e) ||
    /not installed|not configured|not logged in|log ?in|sign ?in|unauthorized|forbidden|ENOENT|command not found|no such file/i.test(s) ||
    // A hung CLI is just as recoverable as a missing one, and until now it wasn't treated that
    // way. `run()` kills the child on timeout, which surfaces as "code null" (killed by signal,
    // no exit code) with empty stdout AND stderr — so the message reads
    // "claude CLI failed (code null): " with nothing after the colon. That string matched none
    // of the patterns above, so the LM Studio failover below was skipped and the reply
    // dead-ended, even with LM Studio up and healthy. A real client SMS was answered with that
    // raw error text on 2026-07-29.
    /code null|timed? ?out|ETIMEDOUT|SIGKILL|SIGTERM/i.test(s) ||
    // A capped subscription is exactly as recoverable as a missing login — LM Studio picks up the
    // slack either way. Owner is told separately (notifyUsageLimitHit, called by the caller before
    // this decides whether to fail over) — that's a DIFFERENT question from "can we keep working".
    isUsageLimitError(e)
  );
}

async function completeOnce(engine: Engine, opts: CompleteOpts): Promise<string> {
  switch (engine) {
    case "lmstudio":
      return completeLMStudio(opts);
    case "hermes":
      return completeHermes(opts);
    case "codex":
      return completeCodex(opts);
    case "antigravity":
      return completeAntigravity(opts);
    case "claude":
      return completeClaude(opts);
    default:
      return completeLMStudio(opts);
  }
}

// Full completion + which brain actually served it (after failover). Prefer this when the caller
// needs to record/act on the served engine (e.g. persisting it on a run, failing loud on a
// tool-less fallback). `complete()` is the thin text-only wrapper for the ~15 existing callers.
// Per-engine token prices (USD per 1M tokens). Fallback only — Claude reports total_cost_usd directly.
// Codex reports a single total (no split), so it carries a blended per-1M rate. Local brains are free.
const ENGINE_PRICES: Record<string, { in?: number; out?: number; total?: number }> = {
  claude: { in: 15, out: 75 },   // opus-tier fallback estimate; real cost comes from the stream result
  codex: { total: 3 },           // blended estimate for the exec total
  lmstudio: { total: 0 }, hermes: { total: 0 }, antigravity: { total: 0 },
};

function costFromUsage(engine: string, u: TokenUsage | null): number | undefined {
  if (!u) return undefined;
  if (typeof u.costUsd === "number") return u.costUsd; // engine-reported (authoritative)
  const p = ENGINE_PRICES[engine];
  if (!p) return undefined;
  if (u.tokensIn != null && u.tokensOut != null && (p.in != null || p.out != null)) {
    return (u.tokensIn / 1e6) * (p.in ?? 0) + (u.tokensOut / 1e6) * (p.out ?? 0);
  }
  if (u.tokensTotal != null && p.total != null) return (u.tokensTotal / 1e6) * p.total;
  return undefined;
}

async function recordModelCall(opts: CompleteOpts, served: ServedBrain, usage: TokenUsage | null): Promise<void> {
  try {
    const { store, newId, nowISO } = await import("@/lib/persistence/store");
    await store.modelCalls.insert({
      id: newId(), ts: nowISO(), engine: served.engine, model: served.model,
      runId: opts.runId, taskId: opts.taskId, projectId: opts.projectId, agentRole: opts.agentRole,
      tokensIn: usage?.tokensIn, tokensOut: usage?.tokensOut, tokensTotal: usage?.tokensTotal,
      costUsd: costFromUsage(served.engine, usage), fallback: served.fallback,
    });
  } catch { /* ledger is best-effort — never break a completion */ }
}

export async function completeWithMeta(opts: CompleteOpts): Promise<CompleteResult> {
  const engine = opts.engine ?? defaultEngine();
  let usage: TokenUsage | null = null;
  const o: CompleteOpts = { ...opts, system: withUsSpelling(opts.system), usageSink: (u) => { usage = u; } };
  try {
    const out = await completeOnce(engine, o);
    const model = engine === "claude" ? CLAUDE_MODEL : undefined;
    markBrain(engine, model, false);
    const served: ServedBrain = { engine, model, fallback: false, intended: engine };
    void recordModelCall(o, served, usage);
    return { text: out, served };
  } catch (e) {
    // Tell the owner the moment their Claude subscription is capped — independent of whether it's
    // recoverable. It always is (LM Studio picks up the slack below), which is exactly why this
    // needed its own check: "should FRIDAY keep working" and "should the owner be told" are different
    // questions, and only the first one had an answer before this.
    if ((engine === "claude" || engine === "codex") && isUsageLimitError(e)) void notifyUsageLimitHit(e, engine);

    // Resilience: if an external CLI engine can't authenticate or isn't installed yet, fail over to
    // the other reliable CLI brain — Codex, or Claude when Codex itself failed — so FRIDAY keeps
    // working rather than dead-ending. Other errors propagate. (LM Studio, the old failover target,
    // is retired — 2026-09-13.)
    if (FAILOVER_ENGINES.includes(engine) && isRecoverable(e)) {
      const backup: Engine = engine === "codex" ? "claude" : "codex";
      try {
        const out = await completeOnce(backup, o);
        markBrain(backup, undefined, true);
        const served: ServedBrain = { engine: backup, model: undefined, fallback: true, intended: engine };
        void recordModelCall(o, served, usage);
        return { text: out, served };
      } catch (e2) {
        // Backup failed too — surface the ORIGINAL error below, but never lose why the backup failed.
        console.warn(`[engines] ${engine} failed and the ${backup} failover failed too: ${String(e2).slice(0, 300)}`);
        void import("@/lib/persistence/store").then(({ logEvent }) => logEvent("engine.failover_failed", { engine, backup, error: String(e2).slice(0, 500) }, { level: "warn" })).catch(() => {});
      }
    }
    // Reverse resilience: if the local LM Studio brain fails for ANY reason (server down, no
    // chat model, model error, timeout), fall back to Claude's latest Sonnet via the CLI. If
    // Claude also fails, surface the ORIGINAL LM Studio error.
    if (engine === "lmstudio") {
      try {
        console.warn(`[engines] LM Studio failed (${String(e).slice(0, 120)}) — falling back to Claude ${SONNET_FALLBACK_MODEL}`);
        const out = await completeClaude(o, SONNET_FALLBACK_MODEL);
        markBrain("claude", SONNET_FALLBACK_MODEL, true);
        const served: ServedBrain = { engine: "claude", model: SONNET_FALLBACK_MODEL, fallback: true, intended: engine };
        void recordModelCall(o, served, usage);
        return { text: out, served };
      } catch (e2) {
        // Same alert as the primary path — the owner needs to know their subscription is capped even
        // when it's LM Studio's own outage that surfaced it first. Falls through regardless: the
        // ORIGINAL LM Studio error is still what gets thrown below, unchanged.
        if (isUsageLimitError(e2)) void notifyUsageLimitHit(e2, "claude");
      }
    }
    throw e;
  }
}

export async function complete(opts: CompleteOpts): Promise<string> {
  return (await completeWithMeta(opts)).text;
}

export const extractJSON = sharedExtractJSON;

export async function completeJSON<T = unknown>(opts: CompleteOpts): Promise<T | null> {
  const text = await complete({ ...opts, json: true });
  return extractJSON<T>(text);
}
