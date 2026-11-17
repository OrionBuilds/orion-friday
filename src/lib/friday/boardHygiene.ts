// FRIDAY — board hygiene (owner rule 2026-07-19: "we look so disorganized").
//
// The 170-open-task pile (120 in planning) grew because nothing ever reconciled the board. Two jobs
// live here, with deliberately different authority:
//   • runBoardHygiene — the DAILY sweep. Merges only near-certain duplicates (same project, planning,
//     similarity ≥ MERGE_THRESHOLD) into the oldest card, and reports — never deletes — stale cards.
//     A non-duplicate task is never silently destroyed by a cron job.
//   • sweepPlanning — the OWNER command ("sweep planning" by text). Deletes stale planning cards, but
//     only on the owner's explicit say-so, and only after snapshotting tasks.json to _board-sweeps/<stamp>/
//     (the same backup-first discipline as the 2026-07-19 fresh-start sweep).

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store, nowISO, logEvent } from "@/lib/persistence/store";
import { titleSimilarity } from "@/lib/friday/dedup";
import type { Task } from "@/lib/friday/types";

/** Same-project planning cards at/above this similarity are the same ask twice — auto-merge. */
export const MERGE_THRESHOLD = 0.85;
/** A planning card untouched this long is "stale": digested daily, deleted only by owner command. */
export const STALE_DAYS = 7;

export function staleCutoffMs(now = Date.now()): number {
  return now - STALE_DAYS * 86_400_000;
}

function stalePlanning(tasks: Task[], now = Date.now()): Task[] {
  const cutoff = staleCutoffMs(now);
  return tasks.filter((t) => {
    if (t.status !== "planning") return false;
    const touched = Date.parse(t.updatedAt ?? t.createdAt ?? "");
    return Number.isFinite(touched) && touched < cutoff;
  });
}

/**
 * Pure merge planner (eval-locked): group open `planning` tasks by project, pair up titles at/above
 * the threshold, and elect the OLDEST card of each cluster as survivor. Returns the merges to apply.
 */
export function planMerges(
  tasks: Array<{ id: string; projectId: string; title: string; status: string; createdAt: string }>,
  threshold = MERGE_THRESHOLD,
): Array<{ surviving: string; duplicate: string; score: number }> {
  const merges: Array<{ surviving: string; duplicate: string; score: number }> = [];
  const byProject = new Map<string, typeof tasks>();
  for (const t of tasks) {
    if (t.status !== "planning") continue;
    const list = byProject.get(t.projectId) ?? [];
    list.push(t);
    byProject.set(t.projectId, list);
  }
  for (const list of byProject.values()) {
    const sorted = [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)); // oldest first
    const absorbed = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      if (absorbed.has(sorted[i].id)) continue;
      for (let j = i + 1; j < sorted.length; j++) {
        if (absorbed.has(sorted[j].id)) continue;
        const score = titleSimilarity(sorted[i].title, sorted[j].title);
        if (score >= threshold) {
          merges.push({ surviving: sorted[i].id, duplicate: sorted[j].id, score });
          absorbed.add(sorted[j].id);
        }
      }
    }
  }
  return merges;
}

/**
 * Daily hygiene: apply the merge plan (details carried onto the survivor, dupe's Request cancelled,
 * dupe's pending approval rejected, dupe deleted — every step logged), then digest the stale count.
 */
export async function runBoardHygiene(): Promise<{ merged: number; stale: number }> {
  const tasks = await store.tasks.all();
  const merges = planMerges(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const { deleteTask, updateTask } = await import("@/lib/friday/repo");
  let merged = 0;
  for (const m of merges) {
    const dupe = byId.get(m.duplicate);
    const survivor = byId.get(m.surviving);
    if (!dupe || !survivor) continue;
    if (dupe.runId) continue; // a card with a run attached is live work, not clutter — leave it
    try {
      const carried = `Merged duplicate card (created ${dupe.createdAt.slice(0, 10)}, similarity ${m.score.toFixed(2)}): "${dupe.title}"${dupe.details ? ` — ${dupe.details.slice(0, 300)}` : ""}`;
      await updateTask(survivor.id, {
        details: `${survivor.details ? `${survivor.details}\n\n` : ""}${carried}`,
      });
      if (dupe.requestId) {
        await store.requests.update(dupe.requestId, { state: "cancelled", closedReason: "cancelled", updatedAt: nowISO() }).catch(() => {});
      }
      const pending = await store.approvals.find((a) => a.status === "pending" && a.taskId === dupe.id);
      for (const a of pending) {
        await store.approvals.update(a.id, { status: "rejected", decidedAt: nowISO() }).catch(() => {});
      }
      await deleteTask(dupe.id);
      merged++;
      await logEvent("board.merge", { surviving: survivor.title, duplicate: dupe.title, score: Number(m.score.toFixed(2)) }, { projectId: survivor.projectId });
    } catch (e) {
      await logEvent("board.merge_error", { duplicate: dupe.title, error: String(e).slice(0, 200) }, { level: "warn" });
    }
  }

  const stale = stalePlanning(await store.tasks.all()).length;
  if (stale > 0) {
    const { notifyOwner } = await import("@/lib/friday/notify");
    await notifyOwner({
      kind: "board", priority: "low",
      text: `🧹 Board: ${stale} planning task(s) untouched >${STALE_DAYS}d${merged ? ` (already auto-merged ${merged} exact duplicate(s) today)` : ""} — text "sweep planning" to clear them (backed up first).`,
      dedupeKey: `board-hygiene:${new Date().toDateString()}`,
    }).catch(() => {});
  }
  return { merged, stale };
}

/**
 * Owner command "sweep planning": snapshot tasks.json to _board-sweeps/<stamp>/, then delete stale
 * planning cards (cancelling their Requests, rejecting their pending approvals). Returns the reply.
 */
export async function sweepPlanning(): Promise<string> {
  const victims = stalePlanning(await store.tasks.all());
  if (!victims.length) return `Nothing to sweep — no planning tasks untouched >${STALE_DAYS}d.`;

  const stamp = nowISO().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = path.join(FRIDAY_DATA_DIR, "_board-sweeps", stamp);
  await fs.mkdir(backupDir, { recursive: true });
  await fs.copyFile(path.join(FRIDAY_DATA_DIR, "tasks.json"), path.join(backupDir, "tasks.json"));

  const { deleteTask } = await import("@/lib/friday/repo");
  let deleted = 0;
  for (const t of victims) {
    try {
      if (t.requestId) {
        await store.requests.update(t.requestId, { state: "cancelled", closedReason: "cancelled", updatedAt: nowISO() }).catch(() => {});
      }
      const pending = await store.approvals.find((a) => a.status === "pending" && a.taskId === t.id);
      for (const a of pending) {
        await store.approvals.update(a.id, { status: "rejected", decidedAt: nowISO() }).catch(() => {});
      }
      await deleteTask(t.id);
      deleted++;
    } catch (e) {
      await logEvent("board.sweep_error", { task: t.title, error: String(e).slice(0, 200) }, { level: "warn" });
    }
  }
  await logEvent("board.sweep", { deleted, backupDir });
  return `Swept ${deleted} stale planning task(s) (untouched >${STALE_DAYS}d). Backup: ${backupDir}`;
}
