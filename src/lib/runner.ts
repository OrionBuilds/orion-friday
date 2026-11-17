import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { config } from "./config";
import {
  runProcess, spawnProcess, safeArg, validateFlagArgs, HOME_DIR,
  type RunResult, type AgentEnvOptions,
} from "@autom8ionlab/agent-core";

export { safeArg, validateFlagArgs };
export type { RunResult };

// "codex" is OpenAI's Codex CLI (≥ 0.125 — supports `codex exec --json` for streaming).
// "openclaw"/"fcc" are gateway CLIs reached via /api/run (binFor resolves them from config at
// runtime, throwing a clear "not installed" if the binary isn't configured).
export type AgentName = "claude" | "hermes" | "antigravity" | "codex" | "kimi" | "grok" | "ant" | "openclaw" | "fcc";

function binFor(agent: AgentName): string {
  const key = agent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bin = (config as any)[key];
  if (!bin) throw new Error(`${agent} is not installed or not configured. Set AGENTIC_OS_${key.toUpperCase()}_BIN or install the CLI.`);
  return bin;
}

const appdata = process.env.APPDATA ?? path.join(HOME_DIR, "AppData", "Roaming");
const localAppdata = process.env.LOCALAPPDATA ?? path.join(HOME_DIR, "AppData", "Local");
const IS_WIN = process.platform === "win32";

// FRIDAY-specific PATH additions beyond the shared common set: kimi-code, Python user-scripts
// dirs (where `pip install --user hermes-agent` puts hermes.exe), Antigravity's agy.exe.
const EXTRA_PATH_DIRS = IS_WIN
  ? [
      path.join(HOME_DIR, ".kimi-code", "bin"),
      path.join(appdata, "Python", "Python314", "Scripts"),
      path.join(appdata, "Python", "Python313", "Scripts"),
      path.join(appdata, "Python", "Python312", "Scripts"),
      path.join(localAppdata, "agy", "bin"),
    ]
  : [path.join(HOME_DIR, "local", "node", "bin"), path.join(HOME_DIR, ".kimi-code", "bin")];

// FRIDAY's own deploy/infra credentials. These let her trigger a Netlify build or hit the Supabase
// management API IN-PROCESS — a spawned CLI agent must NOT inherit them, so a client-influenced task
// can never shell out with production deploy/infra rights. Always stripped (independent of the
// host-env opt-out); a task that genuinely needs a token gets it passed explicitly via extraEnv.
// NB: the real deploy guard is the approval gate — this denylist is defence in depth.
const SECRET_ENV_DENYLIST = [
  "NETLIFY_AUTH_TOKEN",
  "SUPABASE_ACCESS_TOKEN",
];

// 2026-08-20 incident: claude-code-router (CCR), an unrelated, separately-installed tool on this
// machine, sets ANTHROPIC_MODEL (and these sibling vars) in the ambient environment for its own
// proxy routing. With no --model flag, the real `claude` CLI falls back to reading it — and the
// combined "LM Studio/qwen/..." string it holds is rejected outright by the real Anthropic API.
// Every scheduled dispatch failed on a 5-minute cadence until this was stripped.
//
// ANTHROPIC_API_KEY belongs in the same bucket, and turned out to be FRIDAY's actual live bug
// that same night (found via the engine-auth-watch page misleadingly saying "re-login" — the owner was
// already logged in; every dispatch was really failing with "claude.ai connectors are disabled
// because ANTHROPIC_API_KEY ... takes precedence over your claude.ai login"). It's a FALLBACK-ONLY
// credential for FRIDAY's own direct-HTTP call sites; the spawned `claude` CLI must never inherit
// it, or an invalid/wrongly-scoped key silently overrides the real subscription login. CLARA
// already strips this for itself — FRIDAY never got the equivalent fix until now.
const HOST_ENV_LEAK_DENYLIST = ["ANTHROPIC_MODEL", "ANTHROPIC_API_BASE_URL", "CCR_CLAUDE_CODE_MODEL", "CODEXL_CLAUDE_CODE_MODEL", "ANTHROPIC_API_KEY"];

export const ENV_OPTIONS: AgentEnvOptions = {
  extraPathDirs: EXTRA_PATH_DIRS,
  alwaysStripDenylist: SECRET_ENV_DENYLIST,
  extraHostDenylist: HOST_ENV_LEAK_DENYLIST,
  keepHostEnvFlag: "AGENTIC_OS_KEEP_HOST_ENV",
};

// 2026-08-20: stripping the env vars above (HOST_ENV_LEAK_DENYLIST) turned out not to be enough —
// the CCR hijack (apiKeyHelper + ANTHROPIC_BASE_URL/API_BASE_URL/MODEL) lives in the owner's global
// ~/.claude/settings.json, which the `claude` CLI reads for itself at startup regardless of what
// env the parent process passed in. The owner wants CCR kept for their own interactive use, so the fix
// isn't to touch that file — it's to have every FRIDAY-spawned `claude` call skip the "user"
// settings scope entirely via --setting-sources, while still honoring any project/local settings
// FRIDAY's own directory carries. Their own sessions (which never pass this flag) are untouched.
function withSettingSources(agent: AgentName, args: readonly string[]): readonly string[] {
  return agent === "claude" ? ["--setting-sources", "project,local", ...args] : args;
}

export async function run(
  agent: AgentName,
  args: readonly string[],
  opts: { timeoutMs?: number; cwd?: string; input?: string; extraEnv?: Record<string, string>; onChunk?: (text: string) => void } = {}
): Promise<RunResult> {
  let bin: string;
  try { bin = binFor(agent); }
  catch (e) { return { ok: false, code: -1, stdout: "", stderr: String(e), durationMs: 0 }; }
  return runProcess(bin, withSettingSources(agent, args), { ...opts, envOptions: ENV_OPTIONS });
}

export function spawnStream(
  agent: AgentName,
  args: readonly string[],
  opts: { cwd?: string; input?: string; extraEnv?: Record<string, string> } = {}
): ChildProcessWithoutNullStreams {
  const bin = binFor(agent);
  return spawnProcess(bin, withSettingSources(agent, args), { ...opts, envOptions: ENV_OPTIONS });
}
