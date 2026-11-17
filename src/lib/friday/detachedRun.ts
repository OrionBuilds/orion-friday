// FRIDAY — detached child-process agent-run isolation (GAP-D, 2026-07-23).
//
// One answer to "one bad agent shouldn't OOM the whole app" is a full standalone worker
// (single-instance pidfile, CAS transitions). That fits an agent that must SERIALIZE browser
// writes for anti-bot. FRIDAY has the opposite need:
// concurrent agent runs are the point, and the risk is in-process OOM/hang blast radius.
//
// This module solves the isolation goal with a smaller shape: each agent run spawns a
// detached tsx subprocess (`scripts/friday/run-detached.ts --runId <id>`), so a rogue
// agent's memory blowup kills only that child. The Next process keeps handling requests.
//
// ─── When it's active ────────────────────────────────────────────────────────────────────
// FRIDAY_DETACHED_RUNS=1 flips dispatchRunAsync to use spawnDetachedRun instead of the
// in-process executeRun path. Default OFF — full soak week before promoting; a bad spawn
// path silently drops every dispatched task, which is a much worse failure than the
// in-process OOM risk we're trying to fix.
//
// ─── Pidfile hygiene ─────────────────────────────────────────────────────────────────────
// Every detached run writes ~/.agentic-os/friday/detached-runs/<runId>.pid on spawn and
// deletes it on clean exit. `sweepOrphanedRuns()` on Next startup finds pidfiles whose
// process is gone and marks the corresponding runs as errored with a distinctive note.
// This is FRIDAY's minimal analogue of a worker WAL sweep — no auto-retry, ever;
// a maybe-executed agent run needs the owner's eyes.
//
// ─── Fallback ────────────────────────────────────────────────────────────────────────────
// If spawn fails (missing tsx, path mangle, permission), spawnDetachedRun returns false
// and the caller falls back to in-process execution. Better degraded than dropped.

import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store, logEvent, nowISO } from "@/lib/persistence/store";

const PID_DIR = path.join(FRIDAY_DATA_DIR, "detached-runs");
const REPO_ROOT = process.cwd(); // Next runs from the repo root; runner script sits under it.

/** True when the operator has opted into detached spawn for agent runs. Env-only — no runtime toggle. */
export function detachedRunsEnabled(): boolean {
  return (process.env.FRIDAY_DETACHED_RUNS ?? "").trim() === "1";
}

async function ensurePidDir(): Promise<void> {
  await fs.mkdir(PID_DIR, { recursive: true });
}

function pidPath(runId: string): string {
  return path.join(PID_DIR, `${runId}.pid`);
}

/**
 * Spawn a detached child process to execute the run identified by runId. Returns true
 * on successful spawn (the child is now running independently), false on any failure so
 * the caller can fall back to in-process execution.
 *
 * The child:
 *  - Runs `npx tsx scripts/friday/run-detached.ts --runId <id>` from repo root
 *  - Inherits env (so LM_STUDIO_URL, OAuth tokens, etc. are all present)
 *  - Ignores stdio (its own logs land in store.logs via executeRun)
 *  - Is detached + unref'd so it survives Next restart / doesn't hold the parent alive
 */
export async function spawnDetachedRun(runId: string): Promise<boolean> {
  try {
    await ensurePidDir();
    const scriptPath = path.join(REPO_ROOT, "scripts", "friday", "run-detached.ts");
    if (!existsSync(scriptPath)) {
      await logEvent("dispatch.detached.script_missing", { runId, scriptPath }, { level: "warn" }).catch(() => {});
      return false;
    }
    const isWindows = process.platform === "win32";
    // On Windows, npx is a .cmd shim — spawn EINVAL without shell:true. shell:true is acceptable here: `runId` is a store-generated id from
    // `newId()` (hex string only), never user input. No injection surface.
    const child = spawn(
      isWindows ? "npx.cmd" : "npx",
      ["tsx", scriptPath, "--runId", runId],
      {
        cwd: REPO_ROOT,
        detached: true,
        stdio: "ignore",
        shell: isWindows,
        windowsHide: true,
      },
    );
    if (typeof child.pid !== "number") {
      await logEvent("dispatch.detached.no_pid", { runId }, { level: "warn" }).catch(() => {});
      return false;
    }
    await fs.writeFile(pidPath(runId), String(child.pid), "utf8").catch(() => {});
    child.unref();
    await logEvent("dispatch.detached.spawned", { runId, pid: child.pid }, { runId }).catch(() => {});
    return true;
  } catch (err) {
    await logEvent("dispatch.detached.spawn_error", { runId, err: String(err).slice(0, 200) }, { level: "warn" }).catch(() => {});
    return false;
  }
}

/**
 * Clean up a run's pidfile after its executor completes (called from the child's finally).
 * Best-effort — a leftover pidfile just becomes an orphan on next sweep.
 */
export async function clearRunPid(runId: string): Promise<void> {
  await fs.unlink(pidPath(runId)).catch(() => {});
}

/**
 * On Next startup, transition every run that no longer has a live executor to a terminal
 * state. NEVER auto-retry (see module header) — just make the queue honest.
 *
 * Two populations, and only one of them used to be swept:
 *
 *  1. **Detached runs** own a pidfile, so a dead pid is provable. That was the original sweep.
 *  2. **In-process runs write no pidfile at all.** Detached spawn is off by default
 *     (`detachedRunsEnabled()`), so in practice every run executes inside Next — which meant
 *     the sweep had nothing to find and a restart left those rows stuck in "running"
 *     permanently. Nothing else ever resolved them.
 *
 * The second case needs no pid check: an in-process run lives inside THIS process, so if a row
 * is still "running" when we are only now starting up, its executor died with the previous
 * process by definition. The one thing to exclude is a detached run legitimately still alive
 * across a Next restart — hence `liveRunIds`.
 */
export async function sweepOrphanedRuns(): Promise<{ swept: number; still: number; inProcess: number }> {
  try {
    await ensurePidDir();
    const files = await fs.readdir(PID_DIR).catch(() => [] as string[]);
    const liveRunIds = new Set<string>();
    let swept = 0, still = 0;
    for (const f of files) {
      if (!f.endsWith(".pid")) continue;
      const runId = f.replace(/\.pid$/, "");
      const pidStr = await fs.readFile(path.join(PID_DIR, f), "utf8").catch(() => "");
      const pid = Number.parseInt(pidStr.trim(), 10);
      let alive = false;
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch { /* ESRCH → dead */ }
      }
      if (alive) { still++; liveRunIds.add(runId); continue; }
      // Process gone; mark the run errored (only if still stuck in "running").
      const run = await store.runs.get(runId).catch(() => null);
      if (run && run.status === "running") {
        await store.runs.update(runId, {
          status: "error",
          error: `detached executor exited without terminal state (pid ${pid} gone) — supervisor kill or OOM`,
          endedAt: nowISO(),
        }).catch(() => {});
        await logEvent("dispatch.detached.orphan_swept", { runId, pid }, { level: "warn", runId }).catch(() => {});
      }
      await fs.unlink(path.join(PID_DIR, f)).catch(() => {});
      swept++;
    }

    // In-process orphans: still "running" at startup, with no live detached executor.
    let inProcess = 0;
    const stuck = await store.runs.find((r) => r.status === "running" && !liveRunIds.has(r.id)).catch(() => []);
    for (const run of stuck) {
      await store.runs.update(run.id, {
        status: "error",
        error: "executor died with the app (in-process run, no detached pidfile) — outcome unknown, not retried",
        endedAt: nowISO(),
      }).catch(() => {});
      await logEvent("dispatch.inprocess.orphan_swept", { runId: run.id }, { level: "warn", runId: run.id }).catch(() => {});
      inProcess++;
    }

    return { swept, still, inProcess };
  } catch {
    return { swept: 0, still: 0, inProcess: 0 };
  }
}
