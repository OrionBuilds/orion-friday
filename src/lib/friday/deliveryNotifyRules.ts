// Which client/owner notices fire when a task moves stage (audit gap 10). Pure, so it is unit-testable
// without the store or the engines.
//
// Two bugs fixed here:
//  1. The "work delivered" note fired only on `delivered`, but the PR shepherd lands merged work as
//     `completed` (prShepherd.landMerged) — so merged non-ticket work never notified anyone. Every
//     notice now fires ONCE, on the task's FIRST entry into a closed stage (completed OR delivered);
//     a later completed → delivered move is not a second event.
//  2. A bug that came from a portal ticket notified the client twice: the ticket's portal comment AND
//     an email draft. A task linked to a portal ticket/CR (the "[os-ticket:…]" / "[os-cr:…]" marker
//     osTickets writes into task.details) now relies on the portal comment only — no email draft.

import { isClosed } from "@/lib/friday/stages";

export interface NotifyTaskView {
  title: string;
  status: string;
  details?: string;
  requestKind?: string;
  requesterClientId?: string;
  requestId?: string;
}

export interface NotifyPlan {
  /** Bug fixed → client email draft (bugs not tied to a portal item). */
  bugResolved: boolean;
  /** Non-bug work done → owner nudge (always, when the move is the first close). */
  ownerNudge: boolean;
  /** Non-bug client-requested work done → client "it's ready" draft (not review-owned, not portal-linked). */
  workDelivered: boolean;
}

const PORTAL_LINK = /\[os-(ticket|cr):[^\]]+\]/i;

export function portalLinked(task: Pick<NotifyTaskView, "details">): boolean {
  return PORTAL_LINK.test(task.details ?? "");
}

function isBug(task: NotifyTaskView): boolean {
  return task.requestKind === "bug" || /^\[Bug\]/i.test(task.title);
}

export function deliveryNotifyPlan(fromStatus: string, task: NotifyTaskView): NotifyPlan {
  const none: NotifyPlan = { bugResolved: false, ownerNudge: false, workDelivered: false };
  const firstClose = isClosed(task.status) && !isClosed(fromStatus);
  if (!firstClose) return none;
  const linked = portalLinked(task);
  if (isBug(task)) return { ...none, bugResolved: !linked };
  return {
    bugResolved: false,
    ownerNudge: true,
    workDelivered: Boolean(task.requesterClientId) && !task.requestId && !linked
      && ["feature", "change", "other"].includes(task.requestKind ?? ""),
  };
}
