# FRIDAY conventions

Extracted from ECC/rules (Wave D-2 2026-07-22), pruned to FRIDAY's Next.js + TypeScript +
agent-runtime + engine-registry stack.

## Boundary safety

- **`unknown` for external / untrusted input, narrow safely.** Client SMS text, LLM JSON,
  engine responses, MCP tool payloads — all boundary inputs. Never `any`.
- **Zod for schema-based validation** on the engine + approval boundaries. Types inferred from
  the schema so drift is caught at parse time.
- **Never hardcode secrets.** Every credential from env. Startup validates required vars.
- **Error messages never leak sensitive data.** Approval facts, PII, tool internals stay out
  of `Error.message`. Wrap at the throw site.

## Engine + tool discipline

- **If you delegate to an engine or MCP tool, own the collection.** Wait for the result,
  integrate, return. Fire-and-forget is forbidden. FRIDAY's engine registry (`engines.ts`)
  and orchestrator (`runAgentOnTask`) both enforce this by awaiting through.
- **Final message IS the deliverable.** Never end an agent turn with "waiting for background."
  If you spawned an Explore agent, wait for its `<task-notification>`; if you spawned Bash in
  the background, either wait or explicitly declare "not blocking on it."
- **Rate limit anything that spawns model calls.** `usage.ts` `withinRunBudget()` +
  `withinSpendBudget()` are the gates; every new engine call site consults them.

## React style

- **Define component props with a named `interface` or `type`.** Inline anonymous props leak
  into every consumer's type errors.
- **Do not use `React.FC`.** It brings implicit children + non-obvious return types. Write
  the function signature explicitly.

## Log hygiene

- **No `console.log` in production code paths.** `logEvent` for structured, `logger.*` for
  narrator lines. `console.log` bypasses filtering + lands raw in supervisor logs.
- **Log the shape, not the payload.** Truncate. Model outputs can carry client PII.

## Approval-gate discipline

- **Origin-aware autonomy (2026-09, `authority.decideAutonomy`) decides whether an approval row
  waits for the owner.** WHO ASKED decides, not the action class: origin `owner` | `clara` |
  `scheduler` ⇒ Tier 1 (auto — dispatch, merge, production deploy, client reply); origin `client`
  ⇒ Tier 1 only when the ask is inside the approved project scope (grounded by
  `taskIntake.resolveClientScope` — OS contract scope when mapped), otherwise Tier 3. Hard floors
  that gate for EVERY origin: `risk === "critical"` (delete/drop/wipe/DNS/credentials/secrets/API
  keys — `risk.ts` CRITICAL), the self-edit gate, and "costs money" (`risk.ts` `MONEY_STOP` — the
  ONE money definition; `taskIntake`'s bypass hard stop imports it). Every creator still inserts
  the approval row and auto-approves it through `decideApproval` (same mutex/idempotency path a
  human uses) — so the audit trail is uniform. Stamp `requestOrigin` on every task/approval you
  create: an unstamped task infers `client` from `requesterClientId`, else `owner`.
- **The `authority` dial is the master switch**: `off` ⇒ everything Tier 3; `shadow` ⇒ compute +
  log (`authority.shadow_auto`) only; `active` ⇒ act. `autonomy_policy=legacy` restores the
  Wave-1 profile × action-class table. Client-visible sends additionally need `client_comms=on`
  (enforced in `decideApproval` and the portal direct-post path).
- **Every write rides an approval row.** No exceptions — with ONE documented carve-out:
  `Client.bypassPolicy.enabled` (owner-granted per client, off by default) plus the global
  kill switch `FRIDAY_CLIENT_BYPASS` (off by default) together let a single client's
  requests skip approval entirely, including the deploy step — see
  `taskIntake.bypassEligible()` and `orchestrator.maybeAutoQA`'s bypass branch. Deletion/
  money/transfer content, high/critical risk, and a non-exact identity match all still
  force the normal approval flow even for that client. Do not add a second such carve-out
  without updating this line — the rule stays "no exceptions" for everyone else.
- **Every new `ApprovalKind`** needs a POLICY row in `authority.ts` + a
  `deriveActionClass` case + copy in `approvalCopy.ts`, and its creator must pass
  `origin` (+ `scope` for client asks) to `evaluateAuthority` — an absent origin defaults to
  `owner` (Tier 1 under the origin policy). Missing POLICY rows silently default to Tier 3 under
  the legacy policy, which is safe but hides intent.
- **Portal replies (osTickets.ts).** In-scope `cr_ack` / `cr_completed_reply` / bug-ticket acks
  post directly (`[ack-posted]` marker, no `portal_*_reply` approval) when the run is active,
  `client_comms=on`, and authority is `active` under the origin policy; out-of-scope CRs always
  park via `portal_cr_scope_approval`.
- **`notifyOwner` always with `dedupeKey`.** Otherwise every retry pages you.
- **Speaker-framed memory (2026-07-20 incident).** `indexMemory` writes for FRIDAY's own
  replies must be tagged as promises/status, not delivery records. Recall-poisoning risk.

## Prompt-injection defense (Wave B-3)

- **Every inbound client message goes through `detectPromptInjection()` BEFORE any LLM call.**
  Hits log + owner-notify CRITICAL + optionally hard-suppress (`FRIDAY_INJECTION_HARD=1`).
- **Canary registry via `FRIDAY_PROMPT_CANARIES` env** — never source-checked.
- **New heuristic patterns must be false-positive-audited** against a corpus of normal client
  messages before merge. Log-only mode is the default because a false positive suppressing a
  real client is worse than a missed injection.

## References in code

- Approval discipline: `src/lib/friday/risk.ts`, `authority.ts`, `orchestrator.ts`
- Delegation contract: `src/lib/friday/orchestrator.ts` `runAgentOnTask`
- Client-inbound safety: `src/lib/friday/clientChannel.ts` + `promptInjection.ts`
- Phase-gate methodology: `.claude/commands/phase-gate.md`
- Hook conventions: `.claude/hooks.md`
