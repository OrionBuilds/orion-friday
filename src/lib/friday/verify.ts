// FRIDAY deliverable verification — after a coding agent runs, PROVE the work actually works by
// executing the project's own checks in the real checkout: typecheck (tsc --noEmit), build
// (npm run build), and the test suite (npm test). This turns "a PR exists" into "it compiles,
// builds, and passes its tests" before the run is trusted.
//
// Policy (Full gate): a check that RUNS and fails (non-zero exit) is a HARD FAIL — the caller
// bounces the task to Revisions instead of trusting it. A repo with no runnable checks (non-node,
// or no usable scripts) degrades to advisory: `ran:false`, mid confidence, nothing blocked.
//
// Everything here is best-effort and self-contained (no store writes): a crash or timeout yields a
// low-confidence "couldn't verify" result, never an exception that could un-complete a run.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { projectRepoDirs } from "@/lib/friday/delivery";
import type { Agent, AgentRun, Project, Task } from "@/lib/friday/types";

// Coding roles that produce code worth executing (mirrors deliverables.CODING_ROLES). QA/review
// produce reports, not code, so they're not verified here.
const CODING_ROLES = ["architect", "dev", "devops", "debug", "designer"];

export interface VerifyCheck { name: string; ok: boolean; ran: boolean; output: string }
export interface VerifyResult {
  ran: boolean;                 // did ANY check actually execute?
  checks: VerifyCheck[];
  hardFail: boolean;            // a check that ran returned non-zero (tests/build/typecheck RED)
  confidence: number;           // 0..1 — honest, bounded estimate the deliverable works
  evidenceMarkdown: string;     // per-check ✅/❌ + tail output — feeds the QA prompt + an artifact
  noChange: boolean;            // no repo had uncommitted work or commits ahead of main — the run
                                // changed nothing, so any RED check here was already RED before it
  malware?: string;             // set when the pre-build worm scan refused a repo (nothing was built)
  malwareKind?: "blocked" | "unavailable"; // found malware vs. couldn't finish the scan (retry)
}

// Run a command, capturing exit code + a TAIL of combined stdout/stderr. Uses a shell on Windows so
// `npm`/`npx` (which are .cmd shims) resolve. Never rejects — spawn/timeout errors resolve to a
// non-ok result flagged as not-actually-run so callers can tell "failed" from "couldn't start".
function exec(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string; spawnError: boolean }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell: process.platform === "win32", windowsHide: true });
    } catch (e) {
      resolve({ code: null, out: String(e), spawnError: true });
      return;
    }
    let out = "";
    let timedOut = false;
    const cap = (b: Buffer | string) => { out += b; if (out.length > 200_000) out = out.slice(-200_000); };
    const to = setTimeout(() => { timedOut = true; try { child!.kill(); } catch { /* already gone */ } }, timeoutMs);
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    child.on("close", (code) => { clearTimeout(to); resolve({ code: timedOut ? 124 : code, out, spawnError: false }); });
    child.on("error", (e) => { clearTimeout(to); cap(String(e)); resolve({ code: null, out, spawnError: true }); });
  });
}

// Last ~2500 chars of a command's output — enough to show the failing assertion / type error.
function tail(s: string, n = 2500): string {
  const t = s.trim();
  return t.length <= n ? t : `…\n${t.slice(-n)}`;
}

interface Check { name: string; cmd: string; args: string[]; timeoutMs: number }

// Decide which checks a repo can run, from its package.json scripts + tsconfig presence.
async function detectChecks(repoDir: string): Promise<Check[]> {
  const pkgPath = path.join(repoDir, "package.json");
  if (!existsSync(pkgPath)) return []; // non-node repo → nothing we know how to run
  let scripts: Record<string, string> = {};
  try { scripts = (JSON.parse(await readFile(pkgPath, "utf8")).scripts ?? {}) as Record<string, string>; } catch { return []; }
  const checks: Check[] = [];

  // Typecheck — prefer an explicit script, else `tsc --noEmit` when the repo is TypeScript.
  if (scripts.typecheck || scripts["type-check"]) {
    checks.push({ name: "typecheck", cmd: "npm", args: ["run", scripts.typecheck ? "typecheck" : "type-check"], timeoutMs: 180_000 });
  } else if (existsSync(path.join(repoDir, "tsconfig.json"))) {
    checks.push({ name: "typecheck", cmd: "npx", args: ["--no-install", "tsc", "--noEmit"], timeoutMs: 180_000 });
  }

  // Build — only a real build script (skip if it's obviously a no-op).
  if (scripts.build && !/^(echo|true|:)\b/.test(scripts.build.trim())) {
    checks.push({ name: "build", cmd: "npm", args: ["run", "build"], timeoutMs: 420_000 });
  }

  // Tests — a real test script, not the npm placeholder ("Error: no test specified"). No extra flags:
  // jest is single-run by default and vitest auto-runs-once under a non-TTY spawn, while a runner-
  // specific flag like `--run` would be misread by others (e.g. jest treats it as a path filter).
  if (scripts.test && !/no test specified/i.test(scripts.test)) {
    checks.push({ name: "test", cmd: "npm", args: ["test"], timeoutMs: 420_000 });
  }
  return checks;
}

// Install deps if the repo hasn't been installed in this workspace yet. node_modules persists in the
// reused workspace, so this is slow only on the first verify per repo. Prefer `npm ci` (respects the
// lockfile), fall back to `npm install` when there's no lockfile.
async function ensureDeps(repoDir: string): Promise<boolean> {
  if (existsSync(path.join(repoDir, "node_modules"))) return true;
  const hasLock = existsSync(path.join(repoDir, "package-lock.json")) || existsSync(path.join(repoDir, "npm-shrinkwrap.json"));
  const r = await exec("npm", hasLock ? ["ci"] : ["install"], repoDir, 300_000);
  return r.code === 0;
}

// Does this repo actually have a change to verify (uncommitted work or commits ahead of main)?
// Used both to skip unchanged repos in a multi-repo project and to nudge confidence.
async function repoHasChange(repoDir: string): Promise<boolean> {
  if (!existsSync(path.join(repoDir, ".git"))) return false;
  const status = await exec("git", ["status", "--porcelain"], repoDir, 20_000);
  if (status.out.trim()) return true;
  // Compare against origin's default first: in a worktree the owner's LOCAL main can be weeks stale,
  // which would make a fresh, untouched branch look "ahead".
  for (const base of ["origin/main", "origin/master", "main", "master"]) {
    const ahead = await exec("git", ["rev-list", "--count", `${base}..HEAD`], repoDir, 20_000);
    if (ahead.code === 0) return Number(ahead.out.trim()) > 0;
  }
  return false;
}

// Run all detected checks for one repo.
async function verifyRepo(repoDir: string): Promise<{ checks: VerifyCheck[]; ran: boolean }> {
  const detected = await detectChecks(repoDir);
  if (!detected.length) return { checks: [], ran: false };
  if (!(await ensureDeps(repoDir))) {
    // Couldn't install deps → we can't honestly run anything. Advisory, not a hard fail.
    return { checks: [{ name: "deps", ok: false, ran: false, output: "npm install/ci failed — could not verify" }], ran: false };
  }
  const checks: VerifyCheck[] = [];
  for (const c of detected) {
    const r = await exec(c.cmd, c.args, repoDir, c.timeoutMs);
    checks.push({ name: c.name, ok: r.code === 0, ran: !r.spawnError, output: tail(r.out) });
  }
  return { checks, ran: checks.some((c) => c.ran) };
}

function scoreConfidence(checks: VerifyCheck[], ran: boolean, hasChange: boolean): number {
  const green = (name: string) => checks.some((c) => c.ran && c.ok && c.name === name);
  const anyRed = checks.some((c) => c.ran && !c.ok);
  if (!ran) return hasChange ? 0.5 : 0.4;                 // couldn't verify — capped
  let score = 0.5;
  if (green("typecheck")) score += 0.2;
  if (green("build")) score += 0.2;
  if (green("test")) score += 0.2;
  if (hasChange) score += 0.1;
  if (anyRed) score = Math.min(score, 0.2);               // any RED check caps confidence low
  return Math.max(0, Math.min(1, score));
}

function renderEvidence(perRepo: { repo: string; checks: VerifyCheck[] }[]): string {
  const lines: string[] = ["# Verification"];
  for (const { repo, checks } of perRepo) {
    lines.push(`\n## ${repo}`);
    if (!checks.length) { lines.push("_no runnable checks detected_"); continue; }
    for (const c of checks) {
      const mark = !c.ran ? "⏭️ skipped" : c.ok ? "✅ pass" : "❌ FAIL";
      lines.push(`\n**${c.name}** — ${mark}`);
      if (!c.ok && c.output) lines.push("```\n" + c.output + "\n```");
    }
  }
  return lines.join("\n");
}

// Verify a finished coding run. Returns null when verification doesn't apply (non-coding role,
// kill-switched, or no project). Never throws.
export async function verifyCodeRun(project: Project | null, agent: Agent, _run: AgentRun, _task: Task, opts: { dirs?: { url: string; dir: string }[] } = {}): Promise<VerifyResult | null> {
  if (process.env.AGENTIC_OS_VERIFY === "off") return null;
  if (!project || !CODING_ROLES.includes(agent.role)) return null;
  try {
    // A shepherd round ran in a PR-branch worktree — verify THAT checkout, not the owner's.
    const dirs = (opts.dirs ?? projectRepoDirs(project)).filter((d) => existsSync(path.join(d.dir, ".git")));
    // Prefer repos that actually changed; if none report a change, fall back to all (a committed +
    // pushed change may already be merged/absent locally — still worth building).
    const changed: { url: string; dir: string }[] = [];
    for (const d of dirs) if (await repoHasChange(d.dir)) changed.push(d);
    const targets = changed.length ? changed : dirs;
    if (!targets.length) return null;

    const perRepo: { repo: string; checks: VerifyCheck[] }[] = [];
    const allChecks: VerifyCheck[] = [];
    let anyRan = false;
    let malware: string | undefined;
    let malwareKind: "blocked" | "unavailable" | undefined;
    const { guardWorkspace } = await import("@/lib/friday/wormGuard");
    for (const { url, dir } of targets) {
      // Worm guard: never build a checkout carrying the tip-rewrite worm (its payload runs on build).
      const worm = await guardWorkspace({ cwd: dir, repoUrls: [url], source: "verify", projectId: project.id });
      if (worm.kind !== "clean") {
        // Found malware, or couldn't finish the scan: either way this checkout is not built.
        // A real finding outranks an incomplete scan; reason and kind always move together.
        if (worm.kind === "blocked" || !malwareKind) {
          malwareKind = worm.kind;
          malware = worm.kind === "blocked" ? worm.reason : `not built — ${worm.reason}`;
        }
        const c: VerifyCheck = { name: "malware-scan", ok: false, ran: false, output: worm.kind === "blocked" ? worm.reason : `not built — ${worm.reason}` };
        allChecks.push(c);
        perRepo.push({ repo: url.replace(/\.git$/, "").split(/[\\/]/).slice(-2).join("/"), checks: [c] });
        continue;
      }
      const { checks, ran } = await verifyRepo(dir);
      anyRan = anyRan || ran;
      allChecks.push(...checks);
      perRepo.push({ repo: url.replace(/\.git$/, "").split(/[\\/]/).slice(-2).join("/"), checks });
    }
    const hardFail = allChecks.some((c) => c.ran && !c.ok);
    const confidence = scoreConfidence(allChecks, anyRan, changed.length > 0);
    return {
      ran: anyRan,
      checks: allChecks,
      hardFail,
      confidence,
      evidenceMarkdown: renderEvidence(perRepo),
      noChange: changed.length === 0,
      ...(malware ? { malware, malwareKind } : {}),
    };
  } catch {
    return null; // best-effort — a verify crash must never un-complete the run
  }
}
