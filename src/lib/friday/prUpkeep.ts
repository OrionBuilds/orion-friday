// FRIDAY — "upkeep" PR detection, shared by the dependency sweep, client sign-off filing and the
// PR shepherd. Upkeep = FRIDAY's own housekeeping (weekly patch bumps and the fix rounds on them):
// never a client's build, never something a client should be asked to sign off on, safe to
// supersede when a newer sweep exists.

export interface PrLike { headRefName?: string; title?: string }

const UPKEEP_HEAD = /^(?:friday\/)?deps[-\/]weekly[-\/]?\d{4}-\d{2}-\d{2}/i;
const UPKEEP_TITLE = /weekly patch bumps|\[deps\]/i;
const FIX_OF_UPKEEP = /^\s*\[(?:fix|review|rebase)(?:\s*r\d+)?\].*(?:weekly patch bumps|\[deps\])/i;

export function isUpkeepPr(pr: PrLike): boolean {
  const head = (pr.headRefName ?? "").trim();
  const title = (pr.title ?? "").trim();
  return UPKEEP_HEAD.test(head) || UPKEEP_TITLE.test(title) || FIX_OF_UPKEEP.test(title);
}

/** A PR FRIDAY opened (head branch convention) — authorship can't be used, gh runs on the owner's auth. */
export function isFridayBranch(headRefName?: string): boolean {
  return /^(?:friday\/|friday-work\/|deps\/)/i.test((headRefName ?? "").trim());
}
