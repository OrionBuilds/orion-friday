---
name: "source-command-approve"
description: "Guidance for approving FRIDAY approvals — what to check before clicking approve"
---

# source-command-approve

Use this skill when the user asks to run the migrated source command `approve`.

## Command Template

# Approving a FRIDAY approval

FRIDAY approval rows carry a `facts` bundle that drives the owner-facing copy. Before you
approve any browser-write or client-facing send, check:

## For every approval

1. **Read the `action` line** — one sentence describing exactly what will happen. If it names an
   entity/count/URL/dollar figure that doesn't match your expectation, REJECT and ask FRIDAY to
   re-plan.
2. **Check the `authorityTier`** — Tier 3 means owner-decision floor was hit (money, first-
   impression, deploy, live-ad edit). Tier 2 means the policy would auto-approve under
   `FRIDAY_AUTHORITY=active` for standard-profile clients. Tier 1 = read-only agent work.
3. **Look for `idempotencyKey`** (browser-change approvals only). If two approvals in the queue
   have the same key, one is a duplicate — reject the newer, approve the older, and let the
   idempotency layer no-op the newer at dispatch time.

## For browser writes specifically (`change.op` set)

1. **`change.accountRef`** matches the client account you expect
2. **`change.op`** is the op you'd hand-type in the Google/Meta UI
3. For `edit_final_url`: `change.finalUrl` is the exact URL, spelled correctly, https
4. For `appeal --appeal-scope account-all-disapproved`: `change.appealTargetAdIds` is a
   reasonable count (a full-account bulk of 74 is fine; 500 is the hard cap, anything above 100
   deserves a second look)
5. **`GOOGLE_WRITE_READY.<op>`** flag — if false, approval will dispatch to a NotYetMappedError
   (safe soft-fail, but pointless approval). Only flip after a drill session.

## For client-facing sends (`emailBody` / `smsBody` set)

1. **No dollar figures unless they're in `facts`** — the numeric-fidelity validator should have
   already caught invented numbers; a fresh eyeball catches drift.
2. **First-name greeting present + spelled right**
3. **No `{placeholder}` tokens leaked** — a stray `{firstName}` means the template didn't
   render. Reject; FRIDAY will re-draft.
4. **Sign-off matches persona** — each agent signs as itself (FRIDAY as FRIDAY). Cross-signing is
   a bug.

## Approving via email (threaded flow)

Reply to the approval thread with the literal word `approve` or `reject` (case-insensitive).
Anything else is treated as a question and forwarded to FRIDAY to answer in-thread. See
`approvalEmail.ts classifyOwnerReply` for the exact parser.

## When to escalate instead of approving

- If FRIDAY drafted a reply that mentions the owner/handoff/"come back to you", that's Tier 3
  language — FRIDAY should have created a task-with-approval, not a bare reply. If the approval
  isn't attached, that's the 2026-07-20 client-SMS incident pattern.
  Approve the reply, THEN check that a matching task-approval exists in the queue.
- If two approvals target the same entity within a minute of each other and DON'T share an
  `idempotencyKey`, one is a bug — either the change payload differs subtly, or the queue-time
  dedupe missed. Reject both and re-plan.
