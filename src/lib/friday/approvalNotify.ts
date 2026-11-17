// Telling the owner a decision is waiting. The decision itself is made in the OS (their approval inbox) or
// by telling Clara ("approve the Pat email"); FRIDAY's job is only to make sure they find out. This replaces
// the threaded Gmail approval email: one push through the OS ladder (an email from Clara; never a text),
// deduped per approval so a retry can't ping twice.

import type { Approval } from "@/lib/friday/types";

export interface PendingNotice {
  kind: string;
  priority: "critical";
  headline: string;
  text: string;
  dedupeKey: string;
  needsDecision: { question: string; options: string[]; approvalId: string };
}

/** Pure: what the owner is told about a pending approval. */
export function approvalNotice(a: Pick<Approval, "id" | "action" | "detail" | "risk">): PendingNotice {
  const headline = `Approval needed: ${a.action}`.slice(0, 140);
  return {
    kind: "approval.pending",
    priority: "critical",
    headline,
    text: `${headline}\n${a.detail ?? ""}`.trim(),
    dedupeKey: `approval:${a.id}`,
    needsDecision: { question: a.detail ?? a.action, options: ["approve", "reject"], approvalId: a.id },
  };
}

/** Best-effort push; never throws into the approval path (the pending row is the gate, this is only the nudge). */
export async function notifyApprovalPending(a: Pick<Approval, "id" | "action" | "detail" | "risk">): Promise<void> {
  try {
    const { notifyOwner } = await import("@/lib/friday/notify");
    await notifyOwner(approvalNotice(a));
  } catch { /* the row still shows in the OS inbox */ }
}
