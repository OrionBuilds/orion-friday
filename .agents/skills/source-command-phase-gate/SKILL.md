---
name: "source-command-phase-gate"
description: "Phase-gate methodology for runAgentOnTask work (gstack-derived Think→Plan→Build→Review→Test→Ship→Reflect)"
---

# source-command-phase-gate

Use this skill when the user asks to run the migrated source command `phase-gate`.

## Command Template

# Phase-gate for agent runs

Adopted from garrytan/gstack + shanraisshan/Codex-best-practice, adapted for FRIDAY's
existing `runAgentOnTask` + `maybeAutoQA` + `qaHeal` primitives. Every non-trivial dev task
FRIDAY dispatches (`kind: dev|architect|debug`) walks these seven gates. Trivial tasks
(`kind: pm|support|research`) collapse to Think→Ship.

## The gates

| # | Gate | What happens | FRIDAY primitive |
|---|---|---|---|
| 1 | **Think** | Restate the ask in FRIDAY's own words. Enumerate assumptions, constraints, questions. Ask the operator if any assumption is load-bearing and unverified. | Task creation (`createTask`) + optional client clarification round |
| 2 | **Plan** | Read the relevant code. Draft an approach that names files to touch + primitives to reuse. Explicit "NOT doing" list. | LLM plan pass inside `runAgentOnTask`; approval facts capture the plan |
| 3 | **Build** | Write the code. Small commits per logical unit. Never batch. | Agent turn(s) via `runAgentOnTask` — Codex or Codex per `agent.engine` |
| 4 | **Review** | Adversarial read: what would this break? What edge cases weren't handled? What existing invariant did this touch? Look for silent-fail changes especially. | `maybeAutoQA` self-review pass |
| 5 | **Test** | Run tsc, run eval, run smoke probe if the change is behavioral. No test for a new-op change = insufficient. | `qaHeal` fix rounds when checks fail |
| 6 | **Ship** | Commit with a message that says the WHY (why this change was needed) not the WHAT (the diff already shows what). Restart if runtime-affecting. | Existing git-commit + supervisor-restart flow |
| 7 | **Reflect** | One-line memory entry when something surprising was learned. Skip if nothing surprising. | `indexMemory` speaker-framed write |

## When to skip gates

- **Trivial fix** (typo, one-line rename, comment change): Think + Ship. No plan/review/test.
- **Emergency** (production down, security patch): Think + Build + Ship. Retroactively fill in Review + Test after the fire is out.
- **Research-only** (Explore agent, read-only): Think + Reflect. No Build.

Never skip: **Review** on any code that changes an approval-gate, authority POLICY, or a
GOOGLE_WRITE_READY flag. Those failures are unrecoverable in prod.

## Anti-patterns (from actual incidents)

- **Silent-fail regression** — e.g. `disapprovalWatch.ts:23` seen-zid dedupe silently blocked
  canary-account scans after Wave-4 filter shipped. The Review gate is specifically for catching this
  class of "your change added a filter — did the existing dedupe stop making sense?".
- **Type-schema drift** — adding `BrowserChange.op` values without updating every downstream
  Record<op, T> table. Test gate catches this via tsc; skipping tsc after schema change is a
  known cause of build breakage.
- **Wrong-search-box mis-click** — Wave-4 iteration 10 typed into Google Ads' assistant search
  because a scoped selector fell through to an unscoped fallback. The Review gate for browser
  writes must explicitly check "is the selector scoped tightly enough that no page rearrangement
  breaks it silently."

## References in code

- `runAgentOnTask` — [src/lib/friday/orchestrator.ts](src/lib/friday/orchestrator.ts)
- `maybeAutoQA` — same file, per-run auto-review pass
- `qaHeal` — [src/lib/friday/qaHeal.ts](src/lib/friday/qaHeal.ts)
- `indexMemory` — [src/lib/friday/memory.ts](src/lib/friday/memory.ts)
- `notifyOwner` for approval visibility — [src/lib/friday/notify.ts](src/lib/friday/notify.ts)

## Related plan

This command is part of the 4-wave external-repo enhancement plan (Wave B-2).
