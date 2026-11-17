// FRIDAY — deterministic idempotency keys on approvals.
//
// GAP-B-2 (2026-07-23, port from a sibling agent): FRIDAY already has strong same-process
// decision guards (`decidingNow` mutex + `status !== "pending"` re-entry block in
// decideApproval), so cross-process double-fire is the primary residual risk — a supervisor
// respawn mid-decideApprovalInner, or a manual re-approve of a rebuilt approval row that
// slipped past queueApproval's duplicate-suppressed guard.
//
// This layer is defense-in-depth at DECISION time: every approval carries a deterministic
// key hashing the operative side-effect fields; decideApprovalInner refuses the side effect
// when another approval with the same key already reached a terminal-approved state today.
//
// Pure — key computation has zero side effects and is eval-testable.

import type { Approval } from "@/lib/friday/types";
import { store } from "@/lib/persistence/store";

// Stable JSON stringify: sort object keys AND array entries recursively so the key is
// caller-order-independent. Ported verbatim from a sibling agent's idempotency.ts.
function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    const parts = v.map(stableStringify).sort();
    return `[${parts.join(",")}]`;
  }
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Compute a deterministic idempotency key for an approval. FRIDAY's approvals wear several
 * hats — deploy, email, task-dispatch — and each has different identity fields. Encode the
 * TYPE prefix so a task-dispatch approval and a deploy approval never collide even if their
 * ids happen to hash the same. Pure.
 *
 * Returns undefined for approvals with no side-effectful identity (freshly-inserted rows
 * pre-supersedes chain, or rows whose only outcome is a status flip with no downstream
 * dispatch).
 */
export function computeIdempotencyKey(a: Partial<Pick<Approval,
  "taskId" | "action" | "deployProjectId" | "deployClearCache" | "emailDraftId" | "emailAccount" | "emailClientId"
>>): string | undefined {
  // Deploy is the highest-blast-radius side effect — Netlify build for the same project
  // twice within a day should never fire regardless of who clicked approve.
  if (a.deployProjectId) {
    return `deploy:${fnv1a32(stableStringify({
      projectId: a.deployProjectId,
      clearCache: !!a.deployClearCache,
    }))}`;
  }
  // Email approvals carry a Gmail draft id (already unique per Gmail); the account +
  // draft-id pair is a strong natural key. Include clientId for a legibility sanity check.
  if (a.emailDraftId) {
    return `email:${fnv1a32(stableStringify({
      draftId: a.emailDraftId,
      account: a.emailAccount ?? "friday",
      clientId: a.emailClientId ?? null,
    }))}`;
  }
  // Task-dispatch approvals — approving twice would spawn two agent runs on the same task.
  // Includes action label because a task could rationally get separate approvals for
  // separate phases (dispatch vs. deliver) tracked as different action strings.
  if (a.taskId) {
    return `task:${fnv1a32(stableStringify({
      taskId: a.taskId,
      action: (a.action ?? "").slice(0, 200),
    }))}`;
  }
  return undefined;
}

/**
 * True when another approval carrying the same idempotencyKey already reached a terminal
 * "did the thing" state within the window. `decideApprovalInner` calls this immediately
 * after flipping status to "approved" but BEFORE firing the side effect (deploy / sendDraft /
 * dispatchRunAsync), so a re-approve becomes a no-op logged in `resultNote` instead of a
 * double-fire.
 *
 * Window: 24h default; tune via FRIDAY_IDEMPOTENCY_WINDOW_HOURS.
 */
export async function idempotencyAlreadyExecuted(key: string, currentApprovalId: string): Promise<Approval | null> {
  if (!key) return null;
  const hours = Number(process.env.FRIDAY_IDEMPOTENCY_WINDOW_HOURS);
  const windowMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000;
  const cutoff = Date.now() - windowMs;
  const rows = await store.approvals.find((a) =>
    a.id !== currentApprovalId
    && a.idempotencyKey === key
    && a.status === "approved"
    && a.executedAt !== undefined
    && Date.parse(a.executedAt) >= cutoff,
  );
  return rows[0] ?? null;
}
