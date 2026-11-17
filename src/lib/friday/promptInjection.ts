// FRIDAY — inbound-client prompt-injection defense.
//
// Wave B-3 (2026-07-22): borrowed pattern from garrytan/gstack. FRIDAY's client SMS/voice
// handler feeds inbound text directly into the LLM plan-generator (`clientChannel.ts:
// handleClientMessage`) — a malicious message could try to override the persona, exfiltrate
// context, escalate by impersonating the owner, or manipulate the reply generation.
//
// Two-layer detection, both pure + eval-testable:
//   1. Canary token check — if we ever start seeding canaries into system prompts (Wave B-3+),
//      an inbound message containing one is a proof of prompt exfiltration by an upstream layer.
//   2. Heuristic classifier — deterministic pattern match for the most common injection shapes
//      (role/persona override, instruction-substitution, ignore-previous, jailbreaks, agent-
//      impersonation, tool-name callouts). Not exhaustive but catches the sloppy 90%.
//
// Fail-open by DEFAULT (log-only) — the classifier is deterministic + string-matched, so a
// false positive on a legit client message must never suppress a reply. Escalate to owner
// only; the reply still goes out unless FRIDAY_INJECTION_HARD=1 flips it to hard-suppress.

import { OWNER_FIRST } from "@/lib/friday/persona";

export interface InjectionVerdict {
  triggered: boolean;
  reasons: string[];     // human-readable list of matched patterns
  canaryLeak?: string;   // set when a known canary was found in inbound content
}

// ── Canary registry ───────────────────────────────────────────────────────
// Env-configurable comma-separated list. Any canary seeded into system prompts by callers
// (future work) should also be registered here so inbound-message detection works.
function canaries(): string[] {
  const raw = (process.env.FRIDAY_PROMPT_CANARIES ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// Owner names an impersonator would use: "the owner" plus the configured owner's first name.
function ownerNamePattern(): string {
  const names = ["the\\s+owner"];
  const first = (OWNER_FIRST ?? "").trim().toLowerCase();
  if (first && first !== "there") names.push(first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `(?:${names.join("|")})`;
}
const OWNER_RE = ownerNamePattern();

// ── Heuristic patterns ────────────────────────────────────────────────────
// Ordered from most-specific to least so the first match wins the "primary reason" label.
// Each entry is a plain regex + human label. NO cross-line multiline flag — SMS is one line
// per message, and cross-line matching risks catching innocuous multi-sentence phrasing.
const PATTERNS: Array<[RegExp, string]> = [
  // Role/persona override attempts
  [/\b(ignore|disregard|forget)\s+(all\s+)?(prior|previous|earlier|above|the)\s+(instructions?|prompts?|rules?|context)/i, "ignore-previous-instructions"],
  [/\byou\s+are\s+now\s+(a|an|the)\b/i, "role-override"],
  [/\bnew\s+(system|role|persona|instructions?)[:\s]/i, "new-system-role"],
  [/\bpretend\s+(you|to\s+be)/i, "pretend-to-be"],
  [/\bact\s+as\s+(a|an|the|if)\b/i, "act-as-different-role"],
  // Instruction / prompt exfiltration
  [/\b(reveal|show|print|repeat|output|display)\s+(your|the)\s+(system\s+)?(prompt|instructions?|rules?)/i, "prompt-exfiltration"],
  [/\bwhat\s+(are|were)\s+your\s+(system\s+)?(instructions?|prompts?|rules?)/i, "prompt-exfiltration-question"],
  // Bypass / jailbreak phrases
  [/\b(DAN|jailbreak|developer\s+mode)\b/i, "jailbreak-phrase"],
  [/\bbypass\s+(your|the)\s+(safety|rules?|restrictions?|filters?)/i, "bypass-safety"],
  // Owner impersonation
  [new RegExp(`\\b(this\\s+is\\s+${OWNER_RE}|${OWNER_RE}\\s+here|from\\s+${OWNER_RE}|on\\s+behalf\\s+of\\s+${OWNER_RE}|${OWNER_RE}\\s+(said|asked|told)\\s+me)`, "i"), "owner-impersonation"],
  [/\bapprove\s+(the|all|any|my)\s+(pending|open|next)?\s*approvals?/i, "approve-approvals-command"],
  // Tool / capability callouts (client shouldn't know these names)
  [/\b(GOOGLE_WRITE_READY|FRIDAY_(?:AUTHORITY|APPROVAL_EMAIL)|dispatchApproval|queueApproval|executeChange)\b/i, "tool-name-callout"],
  // Delimiter smuggling (attempts to close a fake system prompt)
  [/(?:<\/system>|<\/instructions>|```\s*end\s+of\s+system)/i, "delimiter-smuggling"],
  // Suspicious "run this" / URL exfil
  [/\b(curl|wget|fetch)\s+http[s]?:\/\//i, "shell-command-injection"],
];

/**
 * Deterministic scan of an inbound client message. Pure — no side effects, no LLM.
 * A single message can trip multiple patterns; every match is included in `reasons`.
 */
export function detectPromptInjection(text: string | undefined): InjectionVerdict {
  const s = String(text ?? "");
  if (!s.trim()) return { triggered: false, reasons: [] };
  const reasons: string[] = [];
  let canaryLeak: string | undefined;
  for (const canary of canaries()) {
    if (canary && s.includes(canary)) {
      canaryLeak = canary;
      reasons.push(`canary-leak:${canary.slice(0, 12)}`);
      break; // one canary hit is enough — mask the rest to keep the log line short
    }
  }
  for (const [re, label] of PATTERNS) {
    if (re.test(s)) reasons.push(label);
  }
  return { triggered: reasons.length > 0, reasons, canaryLeak };
}

/** Env-controlled hard-suppress mode. Default OFF (log-only) so a false positive never blocks
 * a real client from getting a reply — the owner ping is enough for review. Flip to "1" only
 * after a soak week confirms the classifier's false-positive rate is acceptable. */
export function injectionHardSuppressEnabled(): boolean {
  return (process.env.FRIDAY_INJECTION_HARD ?? "").trim() === "1";
}
