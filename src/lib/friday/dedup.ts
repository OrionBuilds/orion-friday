// FRIDAY — duplicate-ask defense (owner rule 2026-07-19: "we look so disorganized").
//
// The board rotted because the write path never consulted the read path: every extracted client ask
// became a task, so a re-ask ("any update on the July 20th block?") minted a twin, and 120 planning
// cards piled up. This module is the deterministic check the intake/approval/hygiene paths run BEFORE
// creating anything: is this ask already an open task, or work we recently completed?
//
// Deliberately NOT an LLM call. A similarity judgment that gates task creation must be reproducible,
// eval-lockable, and free (it runs on every extracted request). Token-set Jaccard over normalized
// titles is crude but honest: high scores mean the same words, and the ambiguous band (0.45–0.7)
// CREATES-with-a-flag rather than guessing — a false "duplicate" that silently eats a real ask is
// worse than a duplicate card. Zero app imports so evals and bare harnesses can exercise it directly.

/** Same-ask threshold: at/above this the ask is treated as a duplicate (skip create). */
export const DUP_THRESHOLD = 0.7;
/** Related-ask threshold: [ambiguous, dup) creates the task but flags it "possible duplicate". */
export const AMBIGUOUS_THRESHOLD = 0.45;
/** A completed/delivered task older than this no longer counts as "we already did that". */
export const RECENT_DONE_DAYS = 14;

// Filler that carries no signal about WHAT the work is. Moderate on purpose: over-stripping
// ("new", "off") is fine — dates, nouns, and verbs are what distinguish asks — but the list stays
// short enough that two genuinely different asks can't collapse to the same token set.
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "on", "for", "to", "of", "off", "from", "in", "at", "by",
  "with", "is", "are", "was", "were", "be", "been", "it", "its", "we", "our", "you", "your", "they",
  "their", "i", "my", "me", "us", "as", "so", "do", "does", "did", "please", "can", "could", "would",
  "should", "will", "just", "also", "up", "that", "this", "these", "those", "into", "onto", "about",
  "make", "get", "have", "has", "need", "want", "like",
]);

/** Light plural stem so "deliveries"/"delivery" and "footers"/"footer" compare equal. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * Normalize a task/ask title to its signal tokens: lowercase, ordinals collapsed (20th → 20),
 * punctuation dropped, stop-words removed, plurals stemmed. "[Fix R2] Update footer" and
 * "update the footers" both → ["fix", "r2", "update", "footer"] / ["update", "footer"].
 */
export function normalizeTitle(s: string): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/(\d+)(?:st|nd|rd|th)\b/g, "$1")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .map(stem);
}

/** Token-set Jaccard similarity of two titles, 0..1. Either side empty → 0 (nothing to match). */
export function titleSimilarity(a: string, b: string): number {
  const A = new Set(normalizeTitle(a));
  const B = new Set(normalizeTitle(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Does a recent commit message look like it already shipped this task? Requires ≥2 shared signal
 * tokens — one shared generic verb ("fix", "update") must never claim a match, and the real incident
 * pairs ("Block delivery availability for July 20th" / "block July 20 delivery", "Update order
 * confirmation email footer" / "Order email: replace phone footer") share 3-4. Advisory only: it
 * feeds the approval state note a human reads, never an automatic decision.
 */
export function commitMatchesTitle(title: string, commitMessage: string): boolean {
  const T = new Set(normalizeTitle(title));
  const C = new Set(normalizeTitle(commitMessage));
  let inter = 0;
  for (const t of T) if (C.has(t)) inter++;
  return inter >= 2;
}

export interface DupTaskLike {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
}

export interface DupMatch<T extends DupTaskLike = DupTaskLike> {
  kind: "open" | "recent_done";
  task: T;
  score: number;
}

/**
 * Best existing task the candidate title plausibly duplicates, or null. Returns matches down to the
 * AMBIGUOUS floor — the CALLER compares `score` against DUP_THRESHOLD to decide skip vs flag.
 * "recent_done" = a done-status task touched within `recentDoneDays` (stale completions don't count:
 * re-asking for something finished months ago is usually a genuinely new round of the same work).
 * Ties prefer the open task — appending a note to live work beats pointing at a closed card.
 */
export function findDuplicateTask<T extends DupTaskLike>(
  candidateTitle: string,
  tasks: T[],
  opts?: { now?: number; doneStatuses?: string[]; recentDoneDays?: number; minScore?: number },
): DupMatch<T> | null {
  const now = opts?.now ?? Date.now();
  const done = new Set(opts?.doneStatuses ?? ["completed", "delivered"]);
  const recentMs = (opts?.recentDoneDays ?? RECENT_DONE_DAYS) * 86_400_000;
  const minScore = opts?.minScore ?? AMBIGUOUS_THRESHOLD;
  let best: DupMatch<T> | null = null;
  for (const t of tasks) {
    const isDone = done.has(t.status);
    if (isDone) {
      const touched = Date.parse(t.updatedAt ?? "");
      if (!Number.isFinite(touched) || now - touched > recentMs) continue;
    }
    const score = titleSimilarity(candidateTitle, t.title);
    if (score < minScore) continue;
    const kind: DupMatch<T>["kind"] = isDone ? "recent_done" : "open";
    if (!best || score > best.score || (score === best.score && best.kind === "recent_done" && kind === "open")) {
      best = { kind, task: t, score };
    }
  }
  return best;
}
