// FRIDAY → review-orchestrator bridge.
//
// The orchestrator (<FRIDAY_ORCHESTRATOR_HOME>/orchestrator/orchestrator.py) runs read-only review agents —
// Claude SDK code review / test run / git check, plus Codex and Antigravity second opinions — against
// a client project checkout under FRIDAY_PROJECTS_ROOT and writes a Markdown report to
// <FRIDAY_ORCHESTRATOR_HOME>/reports/<project>/. It never touches the project. A run takes 5-10 minutes, and
// FRIDAY's chat route awaits tools inline (nobody sets deferSlow), so `start` spawns the run detached
// and returns at once — the deep_work pattern — then posts the summary to the web thread when it lands.
//
// Secrets: the child gets a minimal env (PATH/HOME/keyring bus only). FRIDAY's own .env.local values
// never reach the orchestrator; it loads its own .env. The orchestrator additionally scrubs its
// subprocess env and blocks .env reads via the SDK hook.

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { store, newId, nowISO } from "@/lib/persistence/store";

// Machine layout is config: FRIDAY_PROJECTS_ROOT (default ~/client-projects) holds the checkouts,
// FRIDAY_ORCHESTRATOR_HOME (default ~/ai-agents) holds the orchestrator and its reports.
export const PROJECTS_ROOT = process.env.FRIDAY_PROJECTS_ROOT?.trim() || path.join(os.homedir(), "client-projects");
const ORCHESTRATOR_HOME = process.env.FRIDAY_ORCHESTRATOR_HOME?.trim() || path.join(os.homedir(), "ai-agents");
export const REPORTS_ROOT = path.join(ORCHESTRATOR_HOME, "reports");
const RUN_SCRIPT = path.join(ORCHESTRATOR_HOME, "orchestrator", "run-review.sh");
const DEFAULT_SKIP = "--skip=netlify,supabase";
// "Name", "Group/Name" or "Group/Sub/Name" — up to three plain path segments (spaces allowed inside
// a segment, e.g. "GitHub/Acme Co/acme-site"), no traversal.
const SEGMENT = /^[A-Za-z0-9._-][A-Za-z0-9._ -]*[A-Za-z0-9._-]$|^[A-Za-z0-9._-]$/;
const MAX_SEGMENTS = 3;

const running = new Set<string>(); // one run per project at a time (this process)

async function isDir(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

function relUnderRoot(abs: string): string | null {
  const rel = path.relative(PROJECTS_ROOT, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const segs = rel.split(path.sep);
  return segs.length <= MAX_SEGMENTS && segs.every((s) => SEGMENT.test(s)) ? segs.join("/") : null;
}

/**
 * Resolve what the user called the project to a "Name" or "Group/Name" under PROJECTS_ROOT.
 * Accepts a folder path relative to the root, or a registered FRIDAY project whose workspaceDir
 * lives under the root. Returns null when nothing matches — never a path outside the root.
 */
export async function resolveProject(input: string): Promise<string | null> {
  const raw = input.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (raw) {
    const segs = raw.split("/");
    if (segs.length <= MAX_SEGMENTS && segs.every((s) => SEGMENT.test(s)) && !segs.some((s) => s === "." || s === "..")) {
      if (await isDir(path.join(PROJECTS_ROOT, ...segs))) return segs.join("/");
    }
    // Fall back to FRIDAY's project registry by name.
    const projects = await store.projects.all().catch(() => []);
    const hit = projects.find((p) => p.name.toLowerCase() === raw.toLowerCase() && p.workspaceDir);
    if (hit?.workspaceDir) {
      const rel = relUnderRoot(path.resolve(hit.workspaceDir));
      if (rel && (await isDir(path.join(PROJECTS_ROOT, rel)))) return rel;
    }
  }
  return null;
}

/** Report folder = last path segment (the orchestrator uses the checkout's basename). */
export function reportName(project: string): string {
  return project.split("/").at(-1)!;
}

export interface ReportSummary { file: string; when: string; summary: string }

/** Newest report for a project: header + one line per agent block. */
export async function latestReport(project: string): Promise<ReportSummary | null> {
  const dir = path.join(REPORTS_ROOT, reportName(project));
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /^\d{8}-\d{6}\.md$/.test(f)).sort();
  const file = files.at(-1);
  if (!file) return null;
  const raw = await fs.readFile(path.join(dir, file), "utf8");
  const header = raw.split("\n").filter((l) => l.startsWith("- ")).slice(0, 3).join("\n");
  const blocks = [...raw.matchAll(/^\[([A-Z ]+)\] \(([^)]*)\)\n([^\n]*)/gm)]
    .filter((m) => m[2] !== "skipped") // skipped agents are listed once, below
    .map((m) => `· ${m[1]} (${m[2]}): ${m[3].trim().slice(0, 180)}`);
  const skipped = [...raw.matchAll(/^\[([A-Z ]+)\] \(skipped\)/gm)].map((m) => `· ${m[1]}: skipped`);
  const when = `${file.slice(0, 4)}-${file.slice(4, 6)}-${file.slice(6, 8)} ${file.slice(9, 11)}:${file.slice(11, 13)}`;
  return { file: path.join(dir, file), when, summary: [header, ...blocks, ...skipped].join("\n") };
}

/** Start a detached orchestrator run; returns immediately. */
export function startOrchestratorReview(project: string): { ok: boolean; line: string } {
  if (running.has(project)) {
    return { ok: false, line: `orchestrator_review: a review of ${project} is already running — ask for the latest report in a few minutes.` };
  }
  // Minimal env — Next types ProcessEnv with a required NODE_ENV, hence the cast at spawn.
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  let child: ChildProcess;
  try {
    child = spawn(RUN_SCRIPT, [project, DEFAULT_SKIP], { cwd: path.dirname(RUN_SCRIPT), detached: true, stdio: "ignore", env: env as NodeJS.ProcessEnv });
  } catch (e) {
    return { ok: false, line: `orchestrator_review: couldn't start — ${String(e).slice(0, 200)}` };
  }
  running.add(project);
  const startedAt = Date.now();
  child.on("error", (e) => {
    running.delete(project);
    void store.messages.append({ id: newId(), channel: "web", role: "friday", text: `Orchestrator review of ${project} failed to start: ${String(e).slice(0, 200)}`, ts: nowISO() }).catch(() => {});
  });
  child.on("exit", (code) => {
    running.delete(project);
    void (async () => {
      const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
      const latest = await latestReport(project).catch(() => null);
      const text = code === 0
        ? `Orchestrator review of ${project} finished (${mins} min). Report: ${latest?.file ?? "(not found)"}\n${latest?.summary ?? ""}`
        : `Orchestrator review of ${project} FAILED (exit ${code ?? "signal"}) after ${mins} min — check \`journalctl --user\` / ${path.join(REPORTS_ROOT, reportName(project))}.`;
      const { notifyOwner } = await import("@/lib/friday/notify");
      await notifyOwner({ kind: "orchestrator.review.done", text: text.split("\n")[0], priority: code === 0 ? "normal" : "critical", dedupeKey: `orch:${project}:${startedAt}` }).catch(() => {});
      await store.messages.append({ id: newId(), channel: "web", role: "friday", text, ts: nowISO() }).catch(() => {});
    })();
  });
  child.unref();
  return { ok: true, line: `orchestrator_review: started on ${project} — Claude review/tests/git plus Codex and Antigravity second opinions, 5-10 minutes. I'll post the summary here when it lands; ask for the latest report any time.` };
}
