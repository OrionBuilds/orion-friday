// Next.js instrumentation — `register()` runs once when a server instance boots (before it serves
// requests). We use it to start FRIDAY's always-on scheduler heartbeat. Node runtime only (the
// scheduler uses fs + child brains); the Edge runtime skips it.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Report every code run's start/finish to the OS (audit gap 6) — before the scheduler can dispatch.
  await import("@/lib/friday/codeRunsReport").then((m) => m.installCodeRunsReporter()).catch(() => {});
  const { startScheduler } = await import("@/lib/friday/scheduler");
  startScheduler();
  // Sweep runs whose executor is gone, so a restart can't leave rows stuck in "running".
  // Covers both detached runs (dead pidfile) and in-process runs (no pidfile at all) — the
  // latter is the common case, since detached spawn is off by default, and it is why runs
  // used to sit in "running" forever after any restart. Never retries; a maybe-executed run
  // is marked errored for a human. Best-effort; failures never block boot.
  const { sweepOrphanedRuns } = await import("@/lib/friday/detachedRun");
  sweepOrphanedRuns().catch(() => {});
  // Registry boot scan — the index persists on disk across restarts; rescan so a library change made
  // while FRIDAY was down is live before the first dispatch (the registry-scan job keeps it fresh).
  import("@/lib/friday/registry").then((m) => m.scanSources()).catch(() => {});
}
