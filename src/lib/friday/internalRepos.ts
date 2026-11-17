// FRIDAY — the agents' own repositories (FRIDAY, CLARA, agent-core).
//
// The PR shepherd drives CLIENT projects end to end. These repos are different: they are the agents'
// own code. It merges them on the same gates as everywhere else: green checks, no conflicts, no major version
// bump, no human changes-requested, and a CodeRabbit review of the exact head with nothing left open
// (the owner, 2026-10-09: FRIDAY merges her own and the other agents' changes once CodeRabbit passes).
// Anything CodeRabbit flags gets a capped review-fix round, exactly like a client PR (the owner 2026-10-10:
// FRIDAY fixes them herself; FRIDAY_INTERNAL_FIX_ROUNDS, default 3) — then it's reported once.
// Dependency sweeps and lockfile/CI-only PRs additionally get superseded/stale housekeeping.
// FRIDAY_INTERNAL_MERGE=upkeep restores the old upkeep-only rule (other PRs skip "internal-non-upkeep").
//
// Pure helpers live here so they're unit-tested; the I/O loop is runInternalRepos in prShepherd.ts.

import { isUpkeepPr } from "@/lib/friday/prUpkeep";
import { noiseBucket } from "@/lib/friday/portalUpdateCopy";
import type { PrReadiness } from "@/lib/friday/prGate";
import { coderabbitCovers, BOT_NUDGE_AFTER_MS, BOT_GIVE_UP_WAIT_MS, type ReviewFeedback } from "@/lib/friday/prReview";
import type { PrState, ShepherdAction } from "@/lib/friday/prShepherd";
import { githubOwner, legacyGithubOwners, normalizeRepoKey } from "@/lib/friday/githubOwner";

/** Repo NAMES of the agents' own code; the owner is config (GITHUB_OWNER), never hardcoded. */
export const DEFAULT_INTERNAL_REPO_NAMES = ["orion", "orion-agent-core", "orion-clara", "orion-friday", "orion-harvey"];

/** Default internal repos under the configured owner (empty when no owner is known). */
export function defaultInternalRepos(owner: string | null = githubOwner()): string[] {
  return owner ? DEFAULT_INTERNAL_REPO_NAMES.map((n) => `${owner}/${n}`) : [];
}

/** owner/name list from FRIDAY_INTERNAL_REPOS (comma/space separated), else the defaults. "off" disables.
 *  Legacy owners (example-org) are normalised to GITHUB_OWNER. */
export function internalRepos(env: string | undefined = process.env.FRIDAY_INTERNAL_REPOS, owner: string | null = githubOwner()): string[] {
  const raw = (env ?? "").trim();
  if (raw.toLowerCase() === "off") return [];
  const list = raw ? raw.split(/[\s,]+/).filter((x) => /^[\w.-]+\/[\w.-]+$/.test(x)) : defaultInternalRepos(owner);
  return [...new Set(list.map((x) => normalizeRepoKey(x, owner).toLowerCase()))];
}

/** "reviewed" (default): any PR merges once CodeRabbit passes. "upkeep": only upkeep PRs merge. */
export function internalMergePolicy(env: string | undefined = process.env.FRIDAY_INTERNAL_MERGE): "reviewed" | "upkeep" {
  return (env ?? "").trim().toLowerCase() === "upkeep" ? "upkeep" : "reviewed";
}

/** GitHub accounts whose repos FRIDAY shepherds (FRIDAY_GITHUB_OWNERS, comma/space separated), else
 *  [GITHUB_OWNER / origin owner]. Legacy owners (example-org) are normalised away — searching a moved
 *  account fails ("cannot be searched"), which is how PR discovery broke on 2026-10-28. */
export function githubOwners(env: string | undefined = process.env.FRIDAY_GITHUB_OWNERS, owner: string | null = githubOwner()): string[] {
  const raw = (env ?? "").trim();
  const list = raw ? raw.split(/[\s,]+/).filter((x) => /^[\w.-]+$/.test(x)) : owner ? [owner] : [];
  const legacy = legacyGithubOwners();
  const out = list.map((o) => (owner && legacy.includes(o.toLowerCase()) ? owner : o));
  const seen = new Set<string>();
  return out.filter((o) => (seen.has(o.toLowerCase()) ? false : (seen.add(o.toLowerCase()), true)));
}

/**
 * "all" (default, the owner 2026-10-09: "FRIDAY needs to be able to merge every PR from everything inside
 * of GitHub, even her own" — part of self-healing): every repo with an open PR under githubOwners()
 * is shepherded. "listed" restores the old scope (active client projects + the agents' own repos).
 */
export function shepherdScope(env: string | undefined = process.env.FRIDAY_SHEPHERD_SCOPE): "all" | "listed" {
  return (env ?? "").trim().toLowerCase() === "listed" ? "listed" : "all";
}

/**
 * Repos that are neither an active client project (those get the full client flow) nor already in the
 * internal list: they get the internal rules — merge when green, conflict-free, no major bump, no
 * human changes-requested and CodeRabbit-clean on the head; never agent fix rounds.
 */
export function extraRepos(discovered: string[], projectKeys: Iterable<string>, internal: string[] = internalRepos()): string[] {
  const skip = new Set([...projectKeys, ...internal].map((k) => k.toLowerCase()));
  const out = new Set<string>();
  for (const k of discovered) {
    const key = k.toLowerCase();
    if (/^[\w.-]+\/[\w.-]+$/.test(key) && !skip.has(key)) out.add(key);
  }
  return [...out].sort();
}

export function isInternalRepo(ownerRepo: string, list: string[] = internalRepos()): boolean {
  return list.includes(ownerRepo.toLowerCase());
}

/** Upkeep on an internal repo: a dependency sweep, or every changed file is lockfile/package.json/CI/tooling. */
export function isInternalUpkeep(pr: Pick<PrReadiness, "headRefName" | "title">, files: string[]): boolean {
  if (isUpkeepPr(pr)) return true;
  return files.length > 0 && files.every((f) => {
    const b = noiseBucket(f);
    return b === "lockfile" || b === "deps" || b === "ci" || b === "tooling";
  });
}

function majorOf(range: string): { major: number; minor: number } | null {
  const m = range.trim().match(/(\d+)\.(\d+)|(\d+)/);
  if (!m) return null;
  return m[1] != null ? { major: Number(m[1]), minor: Number(m[2]) } : { major: Number(m[3]), minor: 0 };
}

/**
 * Dependencies whose major version changes in a package.json patch (unified diff hunk text).
 * For 0.x packages the minor is the breaking position, so 0.3 → 0.4 counts as a major change.
 */
export function majorBumps(patch: string): string[] {
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  for (const line of patch.split("\n")) {
    const m = line.match(/^([+-])\s*"([^"]+)":\s*"([^"]+)"/);
    if (!m) continue;
    (m[1] === "-" ? before : after).set(m[2], m[3]);
  }
  const out: string[] = [];
  for (const [name, next] of after) {
    const prev = before.get(name);
    if (!prev) continue;
    const a = majorOf(prev), b = majorOf(next);
    if (!a || !b) continue;
    const breaking = a.major === 0 && b.major === 0 ? a.minor !== b.minor : a.major !== b.major;
    if (breaking) out.push(`${name} ${prev} → ${next}`);
  }
  return out;
}

export interface InternalDecideInput {
  pr: PrReadiness;
  review: ReviewFeedback;
  files: string[];
  majors: string[];
  /** False when the changed-file list couldn't be read completely (fetch error, or fewer files than
   *  GitHub says changed). The major-version guard and the upkeep check depend on it, so unknown
   *  means no merge. */
  filesOk?: boolean;
  siblings: Array<Pick<PrReadiness, "number" | "headRefName" | "title" | "state">>;
  state: PrState;
  mode: "off" | "dry" | "active";
  /** False when CodeRabbit isn't installed on the repo (null/undefined = unknown). */
  repoHasCodeRabbit?: boolean | null;
  /** Defaults to internalMergePolicy(). */
  policy?: "reviewed" | "upkeep";
  /** A fix/rebase round dispatched by the shepherd is still running on this PR. */
  roundRunning?: boolean;
  /** Defaults to internalFixRounds(). */
  fixRounds?: number;
  now: number;
}

/**
 * Review-fix rounds FRIDAY runs herself on internal/extra repos (the owner 2026-10-10: "fix them herself").
 * Same round as client PRs — the agent fixes or declines each finding in a worktree on the PR
 * branch, pushes, and the threads are answered and resolved; CodeRabbit must then cover the NEW head
 * before anything merges. FRIDAY_INTERNAL_FIX_ROUNDS caps rounds per PR (default 3); 0 restores the
 * old "findings give up" behaviour.
 */
export function internalFixRounds(env: string | undefined = process.env.FRIDAY_INTERNAL_FIX_ROUNDS): number {
  // The whole string must be a non-negative integer: "0oops" is a typo, not "disable rounds".
  const raw = (env ?? "").trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  // A digit string long enough to become Infinity (or lose precision) would never hit the cap.
  return Number.isSafeInteger(n) ? n : 3;
}

/**
 * Supabase project ref for a repo FRIDAY merges outside the client flow (no OS project to carry
 * project_agent_meta.supabaseRef). FRIDAY_SUPABASE_REFS = "owner/repo=ref, …" overrides; the OS repo
 * (<GITHUB_OWNER>/Orion) maps to the OS's own Supabase project by default, taken from
 * ORION_SUPABASE_REF or the ref in ORION_SUPABASE_URL — never a hardcoded ref.
 */
export function osSupabaseRef(env: Record<string, string | undefined> = process.env): string | null {
  const ref = (env.ORION_SUPABASE_REF ?? "").trim().toLowerCase();
  if (/^[a-z0-9]{20}$/.test(ref)) return ref;
  const m = (env.ORION_SUPABASE_URL ?? "").trim().match(/^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

export function internalSupabaseRef(
  key: string,
  env: string | undefined = process.env.FRIDAY_SUPABASE_REFS,
  osRef: string | null = osSupabaseRef(),
  owner: string | null = githubOwner(),
): string | null {
  const map = new Map<string, string>();
  if (osRef && owner) map.set(`${owner}/orion`.toLowerCase(), osRef);
  for (const pair of (env ?? "").split(/[\s,]+/).filter(Boolean)) {
    const m = pair.match(/^([\w.-]+\/[\w.-]+)=([a-z0-9]{20})$/i);
    if (m) map.set(normalizeRepoKey(m[1], owner).toLowerCase(), m[2].toLowerCase());
  }
  return map.get(normalizeRepoKey(key, owner).toLowerCase()) ?? null;
}

/** Conflict-resolution rounds per PR after GitHub's update-branch couldn't merge the base in. */
const INTERNAL_REBASE_ROUNDS = 2;

const DAY = 24 * 60 * 60_000;
const WAIT_MS = 45 * 60_000;
const age = (iso: string | undefined, now: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
};

/** The shepherd's restricted rules for the agents' own repos (pure). No agent rounds, ever. */
export function decideInternal(input: InternalDecideInput): ShepherdAction {
  const { pr, review, state, now } = input;
  if (input.mode === "off") return { kind: "skip", reason: "off" };
  if (pr.state !== "OPEN") return { kind: "skip", reason: "closed" };
  if (pr.isDraft) return { kind: "skip", reason: "draft" };
  const upkeep = isInternalUpkeep(pr, input.files);
  if (!upkeep && (input.policy ?? internalMergePolicy()) === "upkeep") return { kind: "skip", reason: "internal-non-upkeep" };
  if (state.parked && state.parkedSha === pr.headSha) return { kind: "skip", reason: "parked" };
  if (state.nextAllowedAt && Date.parse(state.nextAllowedAt) > now) return { kind: "skip", reason: "backoff" };
  const fixRounds = input.fixRounds ?? internalFixRounds();
  // A round FRIDAY dispatched is still working the branch → let it finish. A finished round (the head
  // moved) gets its threads answered and resolved before feedback is read again.
  if (input.roundRunning) return { kind: "wait", reason: "round-running" };
  if (state.round && state.round.startedSha !== pr.headSha) return { kind: "resolve-round" };

  const newer = input.siblings
    .filter((s) => s.state === "OPEN" && s.number > pr.number && isUpkeepPr(s))
    .sort((a, b) => b.number - a.number)[0];
  if (newer && isUpkeepPr(pr)) return { kind: "close-superseded", by: newer.number };

  if (pr.mergeable === "CONFLICTING") {
    // Only housekeeping is ever closed for being stale; a code change is reported and left open.
    if (upkeep && age(pr.createdAt, now) > 14 * DAY) return { kind: "close-stale" };
    // update-branch already failed for this head — either just now, or before a conflict round that
    // finished without pushing (lastAction "rebase:round", round still on this head). Don't retry the
    // GitHub update in that case; go straight to the next bounded round.
    const updateTried = state.lastAction === "rebase:update-branch"
      || (state.lastAction === "rebase:round" && state.round?.kind === "rebase" && state.round.startedSha === pr.headSha);
    if (updateTried) {
      // A code change gets a bounded conflict-resolution round (same round as client PRs); housekeeping
      // is redone by the next weekly sweep instead.
      if (!upkeep && fixRounds > 0 && state.rebaseRounds < INTERNAL_REBASE_ROUNDS) return { kind: "rebase", via: "round" };
      return { kind: "give-up", why: `merge conflicts with ${pr.baseRefName} that ${upkeep ? "GitHub couldn't update automatically; the next weekly sweep will redo it" : `I couldn't resolve${fixRounds > 0 ? ` in ${state.rebaseRounds} round${state.rebaseRounds === 1 ? "" : "s"}` : ""}`}` };
    }
    return { kind: "rebase", via: "update-branch" };
  }
  if (input.filesOk === false) return { kind: "wait", reason: "fetch-failed" };
  if (input.majors.length) return { kind: "give-up", why: `it changes a major version (${input.majors.slice(0, 3).join("; ")}), which needs a person's review` };
  if (pr.checks === "FAILURE") return { kind: "give-up", why: `checks are failing (${pr.failingChecks.join(", ") || "unknown"})` };
  if (pr.checks === "PENDING" || pr.mergeable === "UNKNOWN") {
    // From when the wait began (prShepherd.trackPending), not the last push.
    if (age(state.pendingSince ?? state.lastPushSeenAt ?? pr.updatedAt, now) > WAIT_MS) return { kind: "give-up", why: `checks have been pending for over 45 minutes (${pr.pendingChecks.join(", ") || "mergeability unknown"})` };
    return { kind: "wait", reason: "checks-pending" };
  }
  if (pr.checks === "NONE") return { kind: "give-up", why: "no checks ran on it, so I won't merge it blind" };
  if (!review.fetchOk) return { kind: "wait", reason: "fetch-failed" };
  if (review.humanChangesRequested) return { kind: "give-up", why: `${review.humanChangesRequestedBy ?? "a reviewer"} requested changes on GitHub` };
  // No merge without a CodeRabbit review of this exact head (same rule as client PRs).
  if (!coderabbitCovers(pr, review)) {
    if (input.repoHasCodeRabbit === false && pr.coderabbitCheck === "absent" && !review.coderabbitPresent) return { kind: "give-up", why: `CodeRabbit isn't installed on ${pr.owner}/${pr.repo}, so this can't be reviewed — install it on the repo` };
    const since = age(state.lastPushSeenAt ?? pr.updatedAt, now);
    if (since > BOT_GIVE_UP_WAIT_MS) return { kind: "give-up", why: "CodeRabbit hasn't reviewed the latest changes; I won't merge unreviewed code" };
    if (since > BOT_NUDGE_AFTER_MS && state.botReviewRequestedForSha !== pr.headSha) return { kind: "request-review" };
    return { kind: "wait", reason: "review-pending" };
  }
  if (review.actionable.length) {
    const n = review.actionable.length;
    if (state.reviewRounds < fixRounds) return { kind: "review-round", count: n };
    return { kind: "give-up", why: fixRounds > 0
      ? `${n} review comment${n === 1 ? "" : "s"} still open after ${fixRounds} fix round${fixRounds === 1 ? "" : "s"}`
      : `${n} review comment${n === 1 ? "" : "s"} still open; fix rounds on these repos are turned off` };
  }
  return { kind: "merge" };
}
