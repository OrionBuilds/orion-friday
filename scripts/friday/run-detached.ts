// FRIDAY — standalone detached agent-run executor (GAP-D, 2026-07-23).
//
// Invoked as `npx tsx scripts/friday/run-detached.ts --runId <id>` by spawnDetachedRun
// (src/lib/friday/detachedRun.ts). Loads the run + task + project + agent from the shared
// JSON store, executes the run in isolation, clears its pidfile, and exits.
//
// This process:
//  - Shares the on-disk JSON store with Next (same pattern as the sibling agents)
//  - Runs the FULL executeRun path (engines, deliverables, verify, qaHeal, notifyOwner) —
//    everything transitively-imported works because the src/ graph doesn't care whether
//    it's inside Next or a standalone Node process
//  - Never re-enters the run if it's already terminal (defensive against a manual re-invoke)
//  - Never auto-retries on failure (that's the owner's call — a maybe-executed run needs eyes)

import { store } from "../../src/lib/persistence/store";
import { runOne } from "../../src/lib/friday/orchestrator";
import { clearRunPid } from "../../src/lib/friday/detachedRun";

function parseArgs(): { runId: string } {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--runId");
  if (idx < 0 || !args[idx + 1]) {
    console.error("[detached] usage: run-detached.ts --runId <id>");
    process.exit(2);
  }
  return { runId: args[idx + 1] };
}

async function main(): Promise<void> {
  const { runId } = parseArgs();
  const run = await store.runs.get(runId);
  if (!run) {
    console.error(`[detached] run ${runId} not found`);
    process.exit(2);
  }
  if (run.status !== "running") {
    console.error(`[detached] run ${runId} not in running state (status=${run.status}) — refusing to re-execute`);
    await clearRunPid(runId).catch(() => {});
    process.exit(0);
  }
  try {
    await runOne(runId);
  } finally {
    await clearRunPid(runId).catch(() => {});
  }
}

main().catch(async (err) => {
  console.error(`[detached] unhandled error: ${String(err).slice(0, 500)}`);
  process.exit(1);
});
