// FRIDAY — Delegated Authority. Origin-aware autonomy (2026-09) on top of the Wave-1 three-tier model.
//
//   Tier 1 — auto (digest-level note)          Tier 2 — auto + notify the owner          Tier 3 — approve
//
// ── The model (autonomy_policy = "origin", the default) ──────────────────────────────────────────
// WHO ASKED decides, not which action class or which client profile:
//   • origin owner | clara | scheduler  ⇒ Tier 1 — the owner asked (directly, through CLARA's bridge,
//     or by standing up a scheduled job), so FRIDAY does the work: dispatches, merges, deploys to
//     production, sends the reply. No approval row.
//   • origin client                     ⇒ Tier 1 ONLY when the ask is inside the approved project
//     scope (scope "in_scope"); "new" or "unknown" scope ⇒ Tier 3, the owner decides.
//   • "contract/signature"              ⇒ Tier 3 regardless of origin (risk.ts CONTRACT_STOP).
//   • "costs money"                     ⇒ Tier 3 regardless of origin. None of FRIDAY's native actions
//     spend money, so this is a TEXT guard (risk.ts MONEY_STOP: charge/payment/invoice/refund/payout/
//     wire/transfer/bank+routing+account number/credit card/ad spend/budget increase).
//   • Safety floor, regardless of origin: risk === "critical" ⇒ Tier 3; the self-edit gate ⇒ Tier 3.
// decideAutonomy() below is the pure function; evaluateAuthority() wraps it for callers that also
// need the mode and the stamped row fields.
//
// ── The master switch is unchanged ───────────────────────────────────────────────────────────────
//   authority = off     → module inert: every evaluation is Tier 3 (conservative fallback)
//   authority = shadow  → compute + log what WOULD auto-run; behaviour unchanged (still asks)
//   authority = active  → Tier 1/2 take the approve click (or skip the row entirely at the intent gate)
// Both are dials (dials.ts: dial > env > default), so they flip from a phone with no restart.
//
// ── Legacy model (autonomy_policy = "legacy") ────────────────────────────────────────────────────
// The Wave-1 per-client profile × action-class POLICY table below, with the high/critical risk floor
// and the Wave-2 format lane (first-of-kind-then-auto for weekly_update / client_notify /
// meeting_followup). Kept intact and selectable so the previous behaviour is one dial flip away.
//
// Independent implementation — FRIDAY and its sibling agents share no code or runtime surfaces (owner hard rule,
// 2026-07-17). FRIDAY's approval surface has three creators (orchestrator.ts): agent task dispatch
// (queueApproval), commitment-bearing email replies (queueEmailApproval), and production deploys
// (queueDeployApproval) — plus the intent router's gate (intent.ts). All four consult this module.

import { store, logEvent } from "@/lib/persistence/store";
import { dial } from "@/lib/friday/dials";
import { MONEY_STOP, CONTRACT_STOP } from "@/lib/friday/risk";
import type { RequestOrigin, Risk, Task } from "@/lib/friday/types";

export type AuthorityProfile = "conservative" | "standard" | "aggressive";
export type AuthorityMode = "off" | "shadow" | "active";
export type AuthorityTier = 1 | 2 | 3;
export type AutonomyPolicy = "legacy" | "origin";
/** Was a CLIENT ask inside the approved project scope? `unknown` = could not be determined (gates). */
export type ScopeVerdict = "in_scope" | "new" | "unknown";

export type ActionClass = "task_dispatch" | "email_reply" | "deploy" | "weekly_update" | "client_notify" | "meeting_offer" | "other";

// Reads the dial first, then FRIDAY_AUTHORITY, then the shadow default (dials.ts owns that
// precedence). Still synchronous, so every existing caller and eval harness is unchanged — but a
// change now takes effect on the next call instead of on the next restart, which is what lets this
// be flipped from a phone.
export function authorityMode(): AuthorityMode {
  const v = dial("authority");
  return v === "off" || v === "active" ? v : "shadow";
}

/** Which autonomy model evaluateAuthority applies: origin-aware (default) or the legacy table. */
export function autonomyPolicy(): AutonomyPolicy {
  return dial("autonomy_policy") === "legacy" ? "legacy" : "origin";
}

/**
 * Best-effort origin for a task that predates the `requestOrigin` stamp (or a caller that never set
 * it): a task a client asked for carries `requesterClientId`; everything else on the board is the
 * owner's own work. Prefers the explicit stamp when present.
 */
export function inferOrigin(task: Pick<Task, "requesterClientId"> & { requestOrigin?: RequestOrigin }): RequestOrigin {
  if (task.requestOrigin) return task.requestOrigin;
  return task.requesterClientId ? "client" : "owner";
}

/**
 * What an auto-round ([QA] / [Fix Rn] / [Review Rn] / [Rebase Rn]) inherits from the task it serves.
 * Before this, fix and QA tasks were created without `requestOrigin`/`requesterClientId`, so
 * inferOrigin() read them as OWNER work and a fix round on a client's ask auto-shipped at Tier 1.
 * The chain root (`sourceTaskId`) and the PR (`prUrl`) ride along so the shepherd can find them.
 */
export function inheritLineage(task: Pick<Task, "id" | "requestOrigin" | "requesterClientId" | "bypassAuthority" | "requestId" | "sourceTaskId" | "prUrl" | "prHeadRef">): {
  requestOrigin: RequestOrigin; requesterClientId?: string; bypassAuthority?: boolean; requestId?: string; sourceTaskId: string; prUrl?: string; prHeadRef?: string;
} {
  return {
    requestOrigin: task.requestOrigin ?? inferOrigin(task),
    requesterClientId: task.requesterClientId,
    bypassAuthority: task.bypassAuthority,
    requestId: task.requestId,
    sourceTaskId: task.sourceTaskId ?? task.id,
    prUrl: task.prUrl,
    prHeadRef: task.prHeadRef,
  };
}

export interface AutonomyInput {
  origin: RequestOrigin;
  actionClass: ActionClass;
  risk: Risk;
  /** Client asks only. Absent ⇒ "unknown" (gates). Ignored for non-client origins. */
  scope?: ScopeVerdict;
  /** Caller already knows the action spends money (none of FRIDAY's native actions do). */
  costsMoney?: boolean;
  /** Caller already knows the action signs/changes a contract or scope. */
  touchesContract?: boolean;
  /** The self-edit gate fired (write-role agent inside FRIDAY's own source). */
  selfEdit?: boolean;
  /** The ask's text (title + details / email body) — scanned with MONEY_STOP. */
  text?: string;
  /** Client asks only: the requester is a retainer client (retainer.ts) — no scope gate. */
  retainer?: boolean;
}

/**
 * The origin-aware autonomy decision. PURE — no store, no dial, no mode; the caller layers the
 * master switch on top (see evaluateAuthority). Order matters:
 *   1. self-edit gate and money — no origin auto-runs these (money still gets one owner OK);
 *   2. the owner's own ask, or CLARA relaying it, IS the approval for everything else — critical
 *      risk included (owner rule 2026-09-15: "if I ask an agent to do something then there should
 *      be no approval needed from me again, I asked for the task"; money excepted by their choice);
 *   3. the critical-risk floor — for work nobody asked for (scheduler) and for clients;
 *   4. then who asked.
 */
export function decideAutonomy(input: AutonomyInput): { tier: AuthorityTier; reason: string } {
  if (input.selfEdit) return { tier: 3, reason: "self-edit gate" };
  if (input.costsMoney || (!!input.text && MONEY_STOP.test(input.text))) return { tier: 3, reason: "costs money" };
  // Contracts and signatures always get one owner OK, whoever asked (owner rule 2026-09-24:
  // "only money and out-of-scope ask me" — a signature is money by another name).
  if (input.touchesContract || (!!input.text && CONTRACT_STOP.test(input.text))) return { tier: 3, reason: "contract/signature" };
  if (input.origin === "owner" || input.origin === "clara") {
    return { tier: 1, reason: `${input.origin}-origin ${input.actionClass} — the owner asked (their ask is the approval)` };
  }
  if (input.risk === "critical") return { tier: 3, reason: "critical risk floor" };
  if (input.origin !== "client") return { tier: 1, reason: `${input.origin}-origin ${input.actionClass} (owner-sanctioned)` };
  // Retainer clients (owner rule 2026-09-29): "if they ask for something, go ahead and do it". Money,
  // contracts and the critical-risk floor above still apply; only the scope gate is lifted.
  if (input.retainer) return { tier: 1, reason: `retainer client ${input.actionClass} — no approval gate (owner rule 2026-09-29)` };
  const scope: ScopeVerdict = input.scope ?? "unknown";
  if (scope === "in_scope") return { tier: 1, reason: `client-origin ${input.actionClass} in approved scope` };
  return { tier: 3, reason: `client-origin ${input.actionClass} — scope ${scope}` };
}

// ── Legacy policy table (autonomy_policy = "legacy") ─────────────────────────────────────────────
// Task dispatch is the only auto-eligible class. Everything else is floored at 3.
const POLICY: Record<ActionClass, Record<AuthorityProfile, AuthorityTier>> = {
  task_dispatch: { conservative: 3, standard: 2, aggressive: 1 },
  email_reply:   { conservative: 3, standard: 3, aggressive: 3 }, // HARD FLOOR (legacy) — a commitment to a client
  deploy:        { conservative: 3, standard: 3, aggressive: 3 }, // HARD FLOOR (legacy) — ships to a live site
  weekly_update: { conservative: 3, standard: 2, aggressive: 2 }, // facts-grounded status email, QA-gated
  client_notify: { conservative: 3, standard: 2, aggressive: 2 }, // "your work is done" note — factual, deterministic template
  meeting_offer: { conservative: 3, standard: 2, aggressive: 2 }, // slot offers (today ALL offers ride the commitment draft path; this class is the future auto lane)
  other:         { conservative: 3, standard: 3, aggressive: 3 },
};

/** Pure tier lookup (eval-harness friendly). Legacy table. */
export function classifyActionTier(actionClass: ActionClass, profile: AuthorityProfile): AuthorityTier {
  return POLICY[actionClass]?.[profile] ?? 3;
}

/** Pure risk floor (legacy table): high/critical work always needs the human. */
export function applyRiskFloor(tier: AuthorityTier, risk: Risk): AuthorityTier {
  return risk === "high" || risk === "critical" ? 3 : tier;
}

export interface AuthorityDecision {
  mode: AuthorityMode;
  profile: AuthorityProfile;
  actionClass: ActionClass;
  tier: AuthorityTier;
  wouldAuto: boolean;
  reason: string;
  /** Wave-2 Track B: the active format grant backing a Tier-2 format lane (reason "format-grant:<id>"). Legacy policy only. */
  formatGrantId?: string;
  /** Origin policy: what the decision was made for — callers stamp these on the approval row. */
  origin?: RequestOrigin;
  scope?: ScopeVerdict;
}

/**
 * Evaluate an approval-to-be. Read-only; never throws (failures degrade to Tier 3). The client is
 * resolved through the project (FRIDAY approvals are project-scoped; emailClientId is direct).
 *
 * Origin policy (default): the decision is decideAutonomy({origin, actionClass, risk, scope, text,
 * selfEdit}); the POLICY table, applyRiskFloor and the format lane are skipped. `origin` defaults to
 * "owner" — FRIDAY's own initiative is owner-sanctioned — so every caller that acts on a CLIENT's
 * behalf MUST pass origin: "client" (and the scope verdict).
 *
 * Legacy policy: the Wave-1 table. `formatKind` marks a recurring client-facing FORMAT (weekly_update /
 * client_notify / meeting_followup) decided by the format registry: granted (clientId, formatKind) →
 * Tier 2; not granted → Tier 3. The risk floor still applies.
 */
export async function evaluateAuthority(input: {
  actionClass: ActionClass;
  risk: Risk;
  projectId?: string;
  clientId?: string;
  formatKind?: string;
  origin?: RequestOrigin;
  scope?: ScopeVerdict;
  text?: string;
  selfEdit?: boolean;
}): Promise<AuthorityDecision> {
  const mode = authorityMode();
  const fallback: AuthorityDecision = { mode, profile: "conservative", actionClass: input.actionClass, tier: 3, wouldAuto: false, reason: "conservative fallback" };
  if (mode === "off") return { ...fallback, reason: "authority off" };
  try {
    let clientId = input.clientId;
    if (!clientId && input.projectId) {
      const project = await store.projects.get(input.projectId).catch(() => null);
      clientId = project?.clientId;
    }
    const client = clientId ? await store.clients.get(clientId).catch(() => null) : null;
    const profile: AuthorityProfile = (client?.authorityProfile as AuthorityProfile) ?? "conservative";

    // ── Origin-aware policy (default) ──
    // Fail CLOSED: a caller that did not say who asked falls through to the legacy per-client
    // table below (conservative ⇒ tier 3). Only stamped origins get the origin lane — otherwise a
    // client-driven path that forgot to stamp would silently auto-approve as "owner".
    if (autonomyPolicy() === "origin" && input.origin) {
      const origin: RequestOrigin = input.origin;
      const scope: ScopeVerdict | undefined = origin === "client" ? (input.scope ?? "unknown") : input.scope;
      const d = decideAutonomy({ origin, actionClass: input.actionClass, risk: input.risk, scope, text: input.text, selfEdit: input.selfEdit });
      return {
        mode, profile, actionClass: input.actionClass, tier: d.tier, wouldAuto: d.tier < 3,
        reason: `origin-policy: ${d.reason}`,
        origin, scope,
      };
    }

    // ── Legacy policy ──
    // Format lane (first-of-kind-then-auto) — overrides the policy table for stamped kinds.
    if (input.formatKind && clientId) {
      const { formatGranted } = await import("@/lib/friday/formatRegistry");
      const grant = await formatGranted(clientId, input.formatKind);
      const rawTier: AuthorityTier = grant ? 2 : 3;
      const tier = applyRiskFloor(rawTier, input.risk);
      return {
        mode, profile, actionClass: input.actionClass, tier, wouldAuto: tier < 3,
        reason: grant
          ? `format-grant:${grant.id}${tier === 3 ? ` (${input.risk} risk floor)` : ""}`
          : `format ${input.formatKind} not granted — first-of-kind gates`,
        formatGrantId: grant?.id,
        origin: input.origin, scope: input.scope,
      };
    }

    const tier = applyRiskFloor(classifyActionTier(input.actionClass, profile), input.risk);
    const wouldAuto = tier < 3;
    const floored = tier === 3 && classifyActionTier(input.actionClass, profile) < 3;
    return {
      mode, profile, actionClass: input.actionClass, tier, wouldAuto,
      reason: `${input.actionClass} × ${profile} → tier ${tier}${floored ? ` (${input.risk} risk floor)` : ""}`,
      origin: input.origin, scope: input.scope,
    };
  } catch (e) {
    await logEvent("authority.error", { error: String(e instanceof Error ? e.message : e).slice(0, 160) }, { level: "warn" }).catch(() => {});
    return fallback;
  }
}
