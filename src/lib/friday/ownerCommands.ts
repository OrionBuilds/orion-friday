// Owner commands over SMS/voice that aren't planning — chiefly APPROVING or REJECTING the queued
// approval gate from anywhere. The owner names the row in words ("approve the Globex report",
// "reject all", or a bare "yes" when only one is pending) and this clears the gate via
// decideApproval — which runs the agent immediately on approval. Short codes are never shown
// (owner rule 2026-09-24) but still resolve silently if they happen to type one.
//
// Rows are addressed by SHORT CODE, never by position. Ordinals were removed because they silently
// mis-target: "approve 2" is resolved against the queue as it stands when the reply arrives, but the
// text that offered "2" was a snapshot from when it was sent. Decide one approval in between and
// every later index shifts down — so a reply to an hour-old SMS releases a different row than the
// one the owner read. On a gate whose whole job is guarding money and client-facing sends, an
// addressing scheme that can quietly resolve to the wrong row is not acceptable.

import { store } from "@/lib/persistence/store";
import { decideApproval } from "@/lib/friday/orchestrator";
import { shortCode } from "@/lib/friday/risk";
import type { Approval } from "@/lib/friday/types";

async function pendingSorted(): Promise<Approval[]> {
  const p = await store.approvals.find((a) => a.status === "pending");
  return p.sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1));
}

// Owner-facing list of pending rows: names only, never codes (owner rule 2026-09-24).
function named(list: Approval[]): string {
  return list.map((a) => `- ${a.action.slice(0, 80)}`).join("\n");
}

const STOP_WORDS = new Set(["the","a","an","and","or","to","for","of","on","in","at","with","it","this","that","one","please","go","ahead","do","yes","no","ok","okay","sure","approve","approved","reject","rejected","send","ship","run","start","hold","dont","don't","not","fine","proceed","confirm","release","all","them","him","her","my","our","your","its","is","are","be","let","put"]);

/** Significant lowercase tokens of a text (stop words and short tokens dropped). Pure. */
export function nameTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w)));
}

/** What a pending row is "called" for name matching: its action plus client/project names. Pure. */
export function rowNameText(a: Pick<Approval, "action" | "facts" | "detail">): string {
  const f = a.facts;
  const bits = [a.action];
  if (f) {
    if (f.kind === "client_request" || f.kind === "email_reply") bits.push(f.clientName);
    if ("projectName" in f && f.projectName) bits.push(f.projectName);
    if (f.kind === "client_request") bits.push(f.summary);
    if (f.kind === "internal_task") bits.push(f.taskTitle);
    if (f.kind === "email_reply") bits.push(f.subject);
  }
  return bits.filter(Boolean).join(" ");
}

/**
 * Name matching (2026-09-24): "go ahead with the Globex report" → the row whose action/client/
 * project share ≥2 significant tokens with the reply. Returns every row that clears the bar so the
 * caller can tell "unique" from "ambiguous". Pure.
 */
export function matchByName(text: string, rows: Approval[]): Approval[] {
  const t = nameTokens(text);
  if (!t.size) return [];
  const scored = rows.map((a) => {
    const r = nameTokens(rowNameText(a));
    let overlap = 0;
    for (const w of t) if (r.has(w)) overlap++;
    return { a, overlap };
  }).filter((x) => x.overlap >= 2);
  if (!scored.length) return [];
  const best = Math.max(...scored.map((x) => x.overlap));
  return scored.filter((x) => x.overlap === best).map((x) => x.a);
}

// A short "Awaiting your OK" block to append to FRIDAY's normal replies so the codes are visible.
// Code-free (owner rule 2026-09-24): names only. Codes still work silently if they type one, but
// nothing owner-facing asks for them — they reply to the approval email or tells CLARA.
export async function pendingApprovalsBlock(): Promise<string> {
  const p = await pendingSorted();
  if (!p.length) return "";
  const names = p.slice(0, 5).map((a) => a.action.slice(0, 60)).join("; ");
  return `\n\nAwaiting your OK: ${names}${p.length > 5 ? ` (+${p.length - 5} more)` : ""}. Reply to the approval email, or tell me "approve the <name>".`;
}

// Exported: the approval-email reply classifier (approvalEmail.ts) reuses these so email and SMS
// can never drift on what counts as a decision.
export const STRONG_APPROVE = /\b(approve[d]?|ship it|go ahead|do it|send it|release|confirm|proceed|green ?light)\b/i;
export const STRONG_REJECT = /\b(reject|decline|deny|cancel|hold off|do not|don'?t)\b/i;
export const SOFT_YES = /^(yes|yep|yeah|yup|ok|okay|sure|approved?)\b/i;
export const SOFT_NO = /^(no|nope|nah)\b/i;

// Pull short-code tokens out of an owner reply.
//
// A token only counts as a code when it's '#'-prefixed (stripped) OR carries at least one digit.
// Without that rule, hex-shaped English would target live rows: "go ahead" contains AHEAD → ...
// "DEAD", "CAFE", "FADE", "BEEF", "ACE", "BAD", "FED" are all valid hex. Mirrors the sibling agents'
// resolvePendingApproval() rule.
function matchShortCodes(text: string, pending: Approval[]): Approval[] {
  const raw = text.toUpperCase().split(/[^#0-9A-Z]+/).filter(Boolean);
  const tokens: string[] = [];
  for (const r of raw) {
    const hashed = r.startsWith("#");
    const word = hashed ? r.replace(/^#+/, "") : r;
    if (!/^[0-9A-F]{3,6}$/.test(word)) continue;
    if (hashed || /\d/.test(word)) tokens.push(word);
  }
  const byId = new Map<string, Approval>();
  for (const token of tokens) {
    for (const a of pending) {
      // Match the 4-char code, or any longer id suffix, so a colliding pair can still be split.
      if (shortCode(a.id) === token || a.id.replace(/-/g, "").toUpperCase().endsWith(token)) byId.set(a.id, a);
    }
  }
  return [...byId.values()];
}

// Match short-code tokens against ANY list of approvals — same rule as matchShortCodes (a token
// only counts when '#'-prefixed or digit-bearing, so "go ahead" can't accidentally hit a hex-shaped
// row), but not restricted to pending. Factored out so the lookup below and matchShortCodes can't
// silently drift on what counts as a code.
function matchShortCodesIn(text: string, rows: Approval[]): Approval[] {
  const raw = text.toUpperCase().split(/[^#0-9A-Z]+/).filter(Boolean);
  const tokens: string[] = [];
  for (const r of raw) {
    const hashed = r.startsWith("#");
    const word = hashed ? r.replace(/^#+/, "") : r;
    if (!/^[0-9A-F]{3,6}$/.test(word)) continue;
    if (hashed || /\d/.test(word)) tokens.push(word);
  }
  const byId = new Map<string, Approval>();
  for (const token of tokens) {
    for (const a of rows) {
      if (shortCode(a.id) === token || a.id.replace(/-/g, "").toUpperCase().endsWith(token)) byId.set(a.id, a);
    }
  }
  return [...byId.values()];
}

function approvalSummary(a: Approval): string {
  // ApprovalFacts is a discriminated union — clientName/subject/draftExcerpt only exist on some
  // kinds, so narrow by `kind` rather than accessing them on the union directly.
  const f = a.facts;
  const clientName = f && (f.kind === "client_request" || f.kind === "email_reply") ? f.clientName : undefined;
  const subject = f?.kind === "email_reply" ? (f.draftExcerpt ?? f.subject) : undefined;
  const who = clientName ? ` (${clientName})` : "";
  const detail = a.detail || subject;
  const status = a.status !== "pending" ? ` [${a.status}]` : "";
  return `#${shortCode(a.id)}${status}: ${a.action}${who}${detail ? ` — ${detail}` : ""}`;
}

// 2026-08-20 incident: "what is #D297 about" is a lookup FRIDAY already had every fact for locally
// (store.approvals), yet it was routed through the full LLM planner like anything else — and when
// claude AND the LM Studio failover both failed, the owner got a canned apology instead of an
// answer. Checked before runIntent()/handleOwnerApproval's decision verbs — this never decides
// anything, it just reads. Unlike handleOwnerApproval, this searches ALL approvals (not just
// pending): the owner may reasonably ask about one that's already been approved or rejected.
const APPROVAL_ABOUT_RX = /^\s*what(?:'s|s|\s+is|\s+was)\s+#?([0-9A-F]{3,6})\s+(?:about|for|regarding)\b/i;
const APPROVAL_BARE_RX = /\bwhat\s+(?:approval|email|draft|reply)\s+(?:were|was)\s+(?:you|that)\s+(?:referring|talking)\s+(?:about|to)\b/i;

export async function tryResolveApprovalLookup(text: string): Promise<string | null> {
  const t = text.trim();
  const withCode = APPROVAL_ABOUT_RX.exec(t);
  if (withCode) {
    const all = await store.approvals.find(() => true);
    const hits = matchShortCodesIn(`#${withCode[1]}`, all);
    if (!hits.length) return `I don't have anything matching #${withCode[1]}.`;
    if (hits.length > 1) return `That matches more than one:\n${hits.map(approvalSummary).join("\n")}`;
    return approvalSummary(hits[0]);
  }
  if (APPROVAL_BARE_RX.test(t)) {
    const pending = await pendingSorted();
    if (pending.length) return approvalSummary(pending[pending.length - 1]);
    const all = (await store.approvals.find(() => true)).sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1));
    if (!all.length) return "I don't have any approvals on record right now.";
    return approvalSummary(all[all.length - 1]);
  }
  return null;
}

// Returns a reply string if this was an owner approval command, else null (let the planner handle it).
export async function handleOwnerApproval(text: string): Promise<string | null> {
  // "revoke <format> for <client>" (Wave-2 Track B) — checked BEFORE the approval verbs and before
  // the pending-queue guard: revoking a format grant works whether or not anything is pending.
  // Restrictive action (takes autonomy away), so it's safe over SMS and voice alike.
  {
    const { tryResolveRevokeCommand } = await import("@/lib/friday/formatRegistry");
    const revoked = await tryResolveRevokeCommand(text);
    if (revoked !== null) return revoked;
  }

  // "resume <repo>" (worm guard, 2026-09-28) — lifts a malware-suspected block once the owner has
  // confirmed the repo is clean. Checked before the pending-queue guard: it works with nothing pending,
  // and only claims the text when it names a repo that is actually blocked.
  {
    const { tryResumeCommand } = await import("@/lib/friday/wormGuard");
    const resumed = await tryResumeCommand(text); // never throws; a failed resume returns its own reply
    if (resumed !== null) return resumed;
  }

  const pending = await pendingSorted();
  if (!pending.length) return null; // nothing to approve → not an approval command
  const t = text.trim();

  const strongApprove = STRONG_APPROVE.test(t);
  const strongReject = STRONG_REJECT.test(t);
  const softYes = SOFT_YES.test(t);
  const softNo = SOFT_NO.test(t);
  if (!strongApprove && !strongReject && !softYes && !softNo) return null;

  const decision: "approved" | "rejected" = (strongReject || (softNo && !strongApprove)) ? "rejected" : "approved";
  const verbNow = decision === "approved" ? "approve" : "reject";

  // A question is never a decision ("can you do it tomorrow?" contains "do it"). Approvals also
  // need a short, unhedged reply; rejecting is the safe direction so it has no length guard.
  if (t.includes("?")) return null;
  if (decision === "approved" && t.length > 160) return null;

  // Which item(s)? Codes still work silently if they type one; otherwise the row is named in words
  // ("approve the Globex report"); a single pending row makes a bare yes/no unambiguous.
  let targets: Approval[] = [];
  if (/\ball\b/i.test(t)) targets = pending;
  else {
    const codeHits = matchShortCodes(t, pending);
    const nameHits = codeHits.length ? [] : matchByName(t, pending);
    const hits = codeHits.length ? codeHits : nameHits;
    if (hits.length === 1) targets = hits;
    else if (hits.length > 1) {
      return `That could be more than one:\n${named(hits)}\nWhich one — say a bit more of its name.`;
    } else if (pending.length === 1) {
      targets = [pending[0]]; // unambiguous single — a bare "yes" is safe
    }
  }

  if (!targets.length) {
    // Ambiguous: several pending, nothing named.
    return `You have ${pending.length} awaiting your OK:\n${named(pending)}\nWhich one? Say "${verbNow} the <name>" (or "${verbNow} all").`;
  }

  const done: string[] = [];
  for (const a of targets) { await decideApproval(a.id, decision, { source: "sms", decidedBy: "owner via sms" }); done.push(a.action); }
  const verb = decision === "approved" ? "Approved" : "Rejected";
  const tail = decision === "approved" ? (targets.length === 1 ? " — running it now." : " — running them now.") : ".";
  // Name a code that still exists. (This used to suggest `approve ${targets.length + 1}` — arithmetic
  // on a list that had just shrunk, so it pointed the owner at the wrong row.)
  const left = pending.filter((p) => !targets.some((x) => x.id === p.id));
  const tailLine = left.length ? `\n${left.length} still awaiting your OK — reply to the approval email, or say "approve the ${left[0].action.slice(0, 40)}".` : "";
  return `${verb}: ${done.map((d) => `"${d}"`).join(", ")}${tail}${tailLine}`;
}
