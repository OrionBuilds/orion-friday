// FRIDAY risk classification + approval gating.
// Anything client-facing, destructive, or that spends money must pause for the operator.
// Ported in spirit from the VoltAgent desktop orchestrator's classifyRisk()/approval-gate.

import type { Risk, Task } from "@/lib/friday/types";

// 2026-09 origin-aware autonomy: "prod(uction) deploy" moved CRITICAL → HIGH. A production deploy is
// FRIDAY's core deliverable and now rides decideAutonomy (auto for owner/CLARA/scheduler-origin work);
// keeping it CRITICAL would have re-gated it through the safety floor for every origin. DNS and
// credential/secret/API-key changes moved the other way (HIGH → CRITICAL): they are the class of
// change that takes a client site or an account down irreversibly, so they stay owner-gated
// regardless of who asked.
const CRITICAL = /\b(delete|drop|destroy|wipe|charge|payment|invoice|refund|wire|transfer|force[- ]?push|rm -rf|dns|credentials?|secrets?|api keys?)\b/i;
const HIGH = /\b(deploy|production deploy|prod deploy|publish|send (an? )?(email|sms|message|text)|email the client|text the client|push to|merge|go live|domain|billing)\b/i;

// Money guard (2026-09). None of FRIDAY's native actions spend money, so the only way "costs money"
// enters her pipeline is through the TEXT of an ask — a client (or an injected payload) asking for a
// charge, a refund, a payout, an ad-budget bump. decideAutonomy floors any ask matching this at
// Tier 3 no matter the origin. Superset of taskIntake's former BYPASS_HARD_STOP money terms (that
// module now imports this) plus the ad-spend/budget phrases the plan added.
export const MONEY_STOP = /\b(charge|payment|invoice|refund|payout|withdraw|wire|transfer|bank account|routing number|account number|credit card|ad spend|budget increase)\b/i;
/** Anything that signs or changes a contract/scope always asks the owner, whoever asked (2026-09-24). */
export const CONTRACT_STOP = /\b(contracts?|agreements?|signatures?|signing|sign(?![- ]?(?:in|up|on|off|out)s?\b)|e-?sign(?:ed|ing)?|docusign|SOW|MSA|NDA|terms of service|proposal accept(?:ance|ed)|accept(?:s|ed|ing)?\s+(?:\w+\s+){0,4}proposal|approv(?:e|es|ed|ing)\s+(?:\w+\s+){0,4}proposal)\b/i;
/** True when the text reads as a contract/signature action (see CONTRACT_STOP). */
export function touchesContract(text: string): boolean {
  return CONTRACT_STOP.test(text);
}

/** True when the text of an ask reads as spending or moving money (see MONEY_STOP). */
export function costsMoney(text: string): boolean {
  return MONEY_STOP.test(text);
}
const MEDIUM = /\b(create|update|write|edit|configure|set up|migrate|schema|commit|branch|pull request|pr)\b/i;

export function classifyRisk(text: string): Risk {
  if (CRITICAL.test(text)) return "critical";
  if (HIGH.test(text)) return "high";
  if (MEDIUM.test(text)) return "medium";
  return "low";
}

// External/irreversible side-effects always require sign-off, regardless of stated risk.
const EXTERNAL_EFFECT = /\b(deploy|publish|send|email|sms|text|push|merge|charge|payment|invoice|delete|go live|dns|refund)\b/i;

export function needsApproval(task: Pick<Task, "title" | "risk">): boolean {
  if (task.risk === "high" || task.risk === "critical") return true;
  // Scan the TITLE only (the actual work). Descriptions often quote a client's symptoms
  // (e.g. "the confirmation email never arrives"), which shouldn't trip the gate — only the
  // work itself (a task titled "Deploy…"/"Push…"/"Email the client…") should.
  return EXTERNAL_EFFECT.test(task.title);
}

// ── Retainer clients (owner rule 2026-09-29) ─────────────────────────────────────────────────────
// For a retainer client (retainer.ts) the title-word trigger above is too blunt: "delete calls
// feature", "email summaries to advisors" and "send PDF" are ordinary product work, and raised
// approvals on the ACME tasks. For them the gate is the task's own risk rating plus the ACTION the
// text describes — money, contracts, destroying production data, security/credentials, mass outbound
// messages — matched as phrases, never as a lone word in the title.

const DESTROY_PROD_DATA = new RegExp(
  [
    String.raw`\b(?:drop|truncate)\s+(?:the\s+)?(?:table|database|schema|column|collection)s?\b`,
    String.raw`\b(?:bulk|mass)[- ]?(?:delete|deletion|remove|removal|purge)\b`,
    String.raw`\b(?:delete|remove|purge|wipe|erase|destroy)\s+(?:all|every|each)\b`,
    String.raw`\b(?:delete|remove|purge|wipe|erase|destroy)\b[^.\n]{0,40}\b(?:production|prod|live)\s+(?:data|database|db|records?|rows?|tables?|users?|customers?|accounts?)\b`,
    String.raw`\b(?:purge|wipe|erase)\s+(?:the\s+)?(?:data|database|db|records|table|users|customers)\b`,
    String.raw`\b(?:delete|remove|archive)\s+(?:the\s+|a\s+|this\s+)?(?:(?:github|git)\s+)?(?:repo|repository|branch(?:es)?)\b`,
    String.raw`\bforce[- ]?push\b`,
    String.raw`\brm\s+-rf\b`,
    // Any SQL delete, WHERE clause or not: removing real rows is the owner's call.
    String.raw`\bdelete\s+from\s+[\w."]+`,
  ].join("|"),
  "im",
);
const SECURITY_CHANGE = /\b(?:mfa|2fa|two[- ]factor|multi[- ]factor|sso|single sign[- ]on|(?:disable|turn off|remove|bypass)\s+(?:\w+\s+){0,2}(?:auth|authentication|login|log[- ]?in|verification)|credentials?|secrets?|api[- ]keys?|passwords?|access tokens?|auth tokens?|ssh keys?|private keys?|rotate (?:the )?(?:keys?|tokens?|secrets?)|dns|rls polic(?:y|ies)|row[- ]level security|admin (?:access|role|rights|permissions?)|grant (?:\w+ ){0,3}(?:admin|access|permissions?|role))\b/i;
const MASS_OUTBOUND = new RegExp(
  [
    String.raw`\b(?:bulk|mass|blast)\b[^.\n]{0,30}\b(?:emails?|sms|texts?|messages?|send|mail)\b`,
    String.raw`\b(?:send|email|text|message|mail)\b[^.\n]{0,30}\b(?:all|every|entire)\s+(?:of\s+(?:our|their|the)\s+)?(?:customers?|clients?|users?|contacts?|subscribers?|leads?|list|mailing list|audience)\b`,
    String.raw`\b(?:newsletter|email campaign|sms campaign|drip campaign)\b`,
    // An explicit large audience ("send the update to 5,000 subscribers").
    String.raw`\b(?:send|email|text|message|mail|notify)\b[^.]{0,40}?\b(?:\d{1,3}(?:,\d{3})+|\d{3,})\s+(?:\w+\s+)?(?:customers?|clients?|users?|contacts?|subscribers?|leads?|recipients?|people|advisors?|members?)\b`,
  ].join("|"),
  "i",
);

// Money and contracts as ACTIONS (moving money, signing/changing an agreement), so product work that
// merely mentions an invoice or an agreement ("add an invoice search filter") isn't gated.
const MONEY_ACTION = /(?:\$\s?\d)|\b(?:charge|refund|payout|withdraw|purchase|buy|ad spend|budget increase|(?:wire|transfer|send|move)\s+(?:the\s+)?(?:money|funds|payment)|issue\s+(?:an?\s+)?(?:invoice|refund|credit)|send\s+(?:an?\s+|the\s+)?invoice|(?:increase|raise)\s+(?:the\s+)?(?:ad\s+)?(?:spend|budget)|upgrade\s+(?:the\s+|our\s+)?(?:plan|subscription|tier))\b/i;
const CONTRACT_ACTION = /\b(?:e-?sign(?:ed|ing)?|docusign|sign(?:s|ed|ing)?\s+(?:\w+\s+){0,3}(?:contracts?|agreements?|sow|msa|nda|proposals?|renewals?|terms)|(?:amend|change|modify|renew|terminate|cancel|accept|approve)\s+(?:\w+\s+){0,3}(?:contracts?|agreements?|sow|msa|nda|proposals?|terms))\b/i;

/** Pure: which genuinely risky action a task describes (null = ordinary product work). Line breaks
 *  are folded to spaces first, so a phrase split across title/details still matches. */
export function riskyAction(raw: string): "money" | "contract" | "destroys-production-data" | "security" | "mass-outbound" | null {
  const text = raw.replace(/\s*\n+\s*/g, " ");
  if (MONEY_ACTION.test(text)) return "money";
  if (CONTRACT_ACTION.test(text)) return "contract";
  if (DESTROY_PROD_DATA.test(text)) return "destroys-production-data";
  if (SECURITY_CHANGE.test(text)) return "security";
  if (MASS_OUTBOUND.test(text)) return "mass-outbound";
  return null;
}

/**
 * The dispatch approval gate. Non-retainer work keeps needsApproval exactly (title keywords + risk).
 * A retainer client's task needs approval only when its own risk is high/critical or its title +
 * details describe a risky action (riskyAction). Returns the reason, or null to proceed.
 */
export function approvalReason(task: Pick<Task, "title" | "risk"> & { details?: string; description?: string }, opts: { retainer?: boolean; requestText?: string } = {}): string | null {
  if (!opts.retainer) return needsApproval(task) ? "keyword/risk gate" : null;
  if (task.risk === "high" || task.risk === "critical") return `risk ${task.risk}`;
  const action = riskyAction([task.title, task.details, task.description, opts.requestText].filter(Boolean).join(" "));
  return action ? `retainer task, but ${action}` : null;
}

// Short human code for an approval id — the last 4 hex chars (dashes stripped), uppercased. Small
// enough to type in an SMS ("approve 3F2A"), unique enough across a handful of pending rows.
//
// Codes replaced ordinals deliberately. An ordinal is a function of queue state at READ time, but
// the SMS quoting it is a snapshot from SEND time: decide one approval and every later index shifts,
// so a reply to an hour-old text silently releases the wrong row. A code is immutable — it means the
// same row forever. Mirrors the sibling agents' scheme so all agents read alike.
export function shortCode(id: string): string {
  return id.replace(/-/g, "").slice(-4).toUpperCase();
}
