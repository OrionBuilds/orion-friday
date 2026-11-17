// FRIDAY — self-healing QA round bookkeeping (Wave-1 #3).
//
// The auto-QA gate (orchestrator.ts maybeAutoQA) used to stop at "QA failed → open a [Fix] task →
// tell the owner" — the fix task then WAITED for a human dispatch, putting the owner back in the loop for
// every failure. Self-heal closes that loop: the fix task is dispatched automatically to the original
// role, its result re-enters QA, and only EXHAUSTION (round > max) or SUCCESS reaches the owner.
//
// Round state is carried in the task title — `[Fix R2] …` — deliberately schema-free: it survives
// every store round-trip, it's visible on the board, and it can't drift from a separate counter.
//
// Kill switch: FRIDAY_QA_SELFHEAL=off reverts to the old behavior (fix task created, NOT dispatched).

import type { Task } from "@/lib/friday/types";

export const DEFAULT_MAX_ROUNDS = 3;

export function selfHealEnabled(): boolean {
  return (process.env.FRIDAY_QA_SELFHEAL ?? "").trim().toLowerCase() !== "off";
}

export function maxHealRounds(): number {
  const n = Number(process.env.FRIDAY_QA_MAX_ROUNDS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_ROUNDS;
}

/** Review-comment rounds on a PR branch (`[Review Rn]`) — FRIDAY_REVIEW_MAX_ROUNDS, default 4. */
export function maxReviewRounds(): number {
  const n = Number(process.env.FRIDAY_REVIEW_MAX_ROUNDS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}

/** Conflict-resolution rounds on a PR branch (`[Rebase Rn]`) — FRIDAY_REBASE_MAX_ROUNDS, default 1. */
export function maxRebaseRounds(): number {
  const n = Number(process.env.FRIDAY_REBASE_MAX_ROUNDS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Round kinds: qa/checks are `[Fix Rn]`, review comments are `[Review Rn]`, conflicts are `[Rebase Rn]`. */
export type RoundKind = "qa" | "checks" | "review" | "rebase";

const ROUND_PREFIX = /^\s*\[(fix|review|rebase)(?:\s*r(\d+))?\]/i;

/** Round encoded in a task title: `[Fix R2] …` / `[Review R1] …` / `[Rebase R1] …` → n; legacy `[Fix] …` → 1; else 0. */
export function parseFixRound(title: string): number {
  const m = title.match(ROUND_PREFIX);
  if (!m) return 0;
  const n = Number(m[2]);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Which kind of round a title is, or null. */
export function parseRoundKind(title: string): "fix" | "review" | "rebase" | null {
  const m = title.match(ROUND_PREFIX);
  return m ? (m[1].toLowerCase() as "fix" | "review" | "rebase") : null;
}

/** Title for a QA round of `title`: exactly one "[QA]" prefix, however many the source carried. */
export function qaRoundTitle(title: string): string {
  return `[QA] ${title.replace(/^(?:\s*\[QA\]\s*)+/i, "")}`.slice(0, 120);
}

/** Strip any `[Fix …]` / `[Review …]` / `[Rebase …]` / `[QA] `-style prefix chain so round titles never nest. */
export function stripFixPrefix(title: string): string {
  let out = title;
  // Repeated strip: a fix-of-a-fix title like "[Fix R2] [Fix] X" collapses to "X".
  for (let i = 0; i < 6; i++) {
    const next = out
      .replace(/^\s*\[(?:fix(?:\s*r\d+)?|review(?:\s*r\d+)?|rebase(?:\s*r\d+)?|qa)\]\s*(?:—\s*)?/i, "")
      .replace(/^(?:issues from QA|failing checks|review comments|merge conflicts)\s*—\s*/i, "");
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/** The next round's task title, round-stamped and non-nesting. */
export function nextFixTitle(currentTitle: string, kind: RoundKind): { title: string; round: number } {
  const round = parseFixRound(currentTitle) + 1;
  const base = stripFixPrefix(currentTitle);
  const tag = kind === "review" ? "Review" : kind === "rebase" ? "Rebase" : "Fix";
  const label = kind === "qa" ? "issues from QA" : kind === "checks" ? "failing checks" : kind === "review" ? "review comments" : "merge conflicts";
  return { title: `[${tag} R${round}] ${label} — ${base}`.slice(0, 120), round };
}

/**
 * "Already QA'd" is decided per RUN, never per title. The old guard compared the first 24 characters
 * of `[QA] <title>` — and "[QA] [Deps] acme-aicoach" is exactly 24 characters, so every weekly deps
 * sweep after the first was silently skipped (never QA'd, never merged; 2026-09-24 incident). A QA
 * round exists for this task's current run iff a `[QA]` sibling was spawned from that run.
 */
export function qaAlreadyRanFor(task: Pick<Task, "id" | "runId">, siblings: Array<Pick<Task, "title" | "sourceRunId" | "sourceTaskId">>): boolean {
  if (!task.runId) return false;
  return siblings.some((t) => /^\s*\[qa\]/i.test(t.title) && t.sourceRunId === task.runId);
}

/** A `[Fix …]` round spawned from this task's current run already exists (same run-keyed rule). */
export function fixRoundExistsFor(task: Pick<Task, "id" | "runId">, siblings: Array<Pick<Task, "title" | "sourceRunId" | "sourceTaskId">>): boolean {
  if (!task.runId) return false;
  return siblings.some((t) => /^\s*\[(?:fix|review|rebase)/i.test(t.title) && t.sourceRunId === task.runId);
}
