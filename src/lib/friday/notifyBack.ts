// Who hears about a finished run that came in over SMS/voice — pure, so the policy is testable.
//
// 2026-09-14 (mAI Dashboard): every auto-QA/self-heal round inherited the client's phone number and
// texted them its raw internal summary ("[QA] [Fix R3] failing checks — … — done. The
// test-environment repair is incomplete… Full report in the app."), and a coding run texted
// "done" before verification or QA had looked at it. Policy now:
//   - auto rounds ([QA] …, [Fix Rn] …) are silent — the owner already gets exhaustion / QA-pass pings;
//   - a client's coding task (it goes through verify + QA) texts the client once, when QA PASSES
//     (orchestrator), not when the run ends;
//   - any other client task texts the client its client-safe summary at run end;
//   - no client contact → the owner, as before.

/** Roles whose runs go through verification + auto-QA (orchestrator AUTO_QA_ROLES + designer). */
const VERIFIED_ROLES = ["dev", "architect", "devops", "debug", "designer"];

export function isAutoRoundTitle(title: string): boolean {
  return /^\s*\[(qa|(?:fix|review|rebase)(?:\s*r\d+)?)\]/i.test(title);
}

/** "[QA] [Fix R2] issues from QA — Fix the thing" → "Fix the thing" (what the client asked for). */
export function baseTitle(title: string): string {
  return title
    .replace(/^(\s*\[[^\]]*\]\s*)+/, "")
    .replace(/^(failing checks|issues from QA)\s+—\s+/i, "")
    .trim() || title.trim();
}

export type RunEndNotify = "none" | "client" | "owner";

export function runEndNotifyTarget(opts: { title: string; role: string; hasClientContact: boolean }): RunEndNotify {
  if (isAutoRoundTitle(opts.title)) return "none";
  if (opts.hasClientContact) return VERIFIED_ROLES.includes(opts.role) ? "none" : "client";
  return "owner";
}
