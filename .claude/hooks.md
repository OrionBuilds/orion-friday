---
description: "Hook conventions for FRIDAY's evaluate-then-execute engine + approval-gate enforcement"
---

# FRIDAY hook conventions

Adopted from shanraisshan/claude-code-best-practice + adapted. FRIDAY doesn't run inside the
Claude Code hook runtime directly — she IS the runtime for her own agents. These conventions
apply to how her orchestrator invokes engines + guards writes.

## Pre-write hooks (existing, documented here for consistency)

Every browser write walks this chain BEFORE executing:

1. **Kill switch** — env var per feature (`FRIDAY_DEP_SWEEP`, `FRIDAY_STALL_CHECKIN`, etc.).
   Off ⇒ engine returns "skipped" without touching the store.
2. **Live-writes arming** — `livewrites.ts` OP_LEVEL check. Op must be at or below the armed
   level, and account must be on the allowlist. Off / mismatch ⇒ `PreflightError` returned to
   the executor.
3. **Authority POLICY** — `authority.ts evaluateAuthority` maps kind × profile → tier. Tier 3
   requires human approval; Tier 1/2 may auto-approve under `active` mode.
4. **Idempotency (Wave A-1)** — deterministic key on the BrowserChange; dispatchApproval
   refuses a second execution within 24h if a prior approval with the same key completed.
5. **Preflight params** — `preflight.ts validateParams` per-op sanity: URL valid, entityRef
   present when scope requires, target-id count under cap.
6. **Per-op WRITE_READY flag** — driver refuses live execution when the flag is false;
   dry-run is allowed (that's how the drill flip is earned).

## Post-write hooks

1. **Evidence capture** — `evidence.ts snap()` at before/dryrun/after/error labels; every
   attempt gets a per-attempt directory under `~/.agentic-os/friday/evidence/<approvalId or adhoc>/`.
2. **Owner notify** — `notify.ts notifyOwner()` on critical/normal priority; batched into a
   digest on `low`. SMS + email dual-channel (post-incident fix, 2026-07-20).
3. **Speaker-framed memory** — `memory.ts indexMemory()` writes `<agent> replied (status/
   promise — NOT a delivery record)` framing so downstream recall doesn't mistake a promise
   for a delivered fact (smoke finding 2026-07-20).

## Pre-approval hooks (Wave-B-3 addition)

Every inbound client message routes through `promptInjection.detectPromptInjection()` BEFORE
reaching the LLM plan-generator. Triggered → owner notify + optional hard-suppress. Never
false-positive-blocks a real client by default (log-only mode).

## Anti-patterns

- **Never bypass the queue** — every write, no matter how "safe", rides an approval. The
  approval is the audit trail; skipping it silently is worse than a wrong write.
- **Never runtime-toggle a WRITE_READY flag** — flip in `google/selectors.ts` by hand only,
  after a drill certifies. Runtime toggles turn safety flags into config values, defeating
  the whole gate.
- **Never `--no-verify` on git commits** — the pre-commit hook is the last line of defense
  against a bad diff reaching main.
