// Protected paths (2.1). FRIDAY's safety-critical source — the approval/gate logic, the client-facing
// prompts, and anything touching tokens/secrets. Agents may PROPOSE diffs to these, but the self-deploy
// pipeline must never APPLY them without an explicit owner sign-off carrying `protected_change=true`.
//
// TODAY the exposure is already closed at the source: the 0.1 self-edit guard blocks dispatched agents
// from editing FRIDAY's running directory at all (SELF_EDIT_ENABLED=false). This list is the second
// layer for when an approval-gated self-deploy pipeline is turned on later. Mirror it in CODEOWNERS if
// FRIDAY's repo gets a GitHub remote.

// Repo-relative globs (matched by suffix/segment — see matchesProtected). Keep in sync with the plan.
export const PROTECTED_PATHS: readonly string[] = [
  "src/lib/friday/approvalCopy.ts",
  "src/lib/friday/approvalEmail.ts",
  "src/lib/friday/taskIntake.ts",
  "src/lib/friday/emailAgent.ts",
  "src/lib/friday/clientChannel.ts",
  "src/lib/friday/clientReview.ts",
  "src/lib/friday/persona.ts",
  "src/lib/friday/orchestrator.ts",     // dispatch + the approval gate itself
  "src/lib/friday/escalations.ts",
  "src/lib/friday/outbound.ts",
  "src/lib/friday/protectedPaths.ts",   // the guard can't be edited to weaken itself
  "src/lib/runner.ts",                   // spawn + the secret denylist
  ".env",                                // any env/secret file
  ".env.local",
];

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
}

/** Is a single changed file protected? Matches on exact repo-relative path or `.env*` basename. */
export function isProtectedPath(file: string): boolean {
  const f = normalize(file);
  return PROTECTED_PATHS.some((p) => {
    const n = normalize(p);
    if (n.startsWith(".env")) return f === n || f.endsWith(`/${n}`) || /(^|\/)\.env(\.|$)/.test(f);
    return f === n || f.endsWith(`/${n}`);
  });
}

/** The subset of a changeset that touches protected files (empty = safe to apply without the flag). */
export function protectedChanges(files: string[]): string[] {
  return files.filter(isProtectedPath);
}

/**
 * Gate a self-deploy changeset. Returns ok=false with the offending files unless the owner's approval
 * explicitly authorized protected changes. The pipeline calls this before applying/merging anything.
 */
export function guardSelfDeploy(files: string[], approvalHasProtectedFlag: boolean): { ok: boolean; blocked: string[] } {
  const blocked = protectedChanges(files);
  if (blocked.length && !approvalHasProtectedFlag) return { ok: false, blocked };
  return { ok: true, blocked: [] };
}
