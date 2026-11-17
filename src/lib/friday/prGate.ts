// FRIDAY — the pre-merge gate (PR shepherd, 2026-09-24).
//
// There is no branch protection on the client repos (private, free plan), so FRIDAY's own check is
// the ONLY thing standing between a green-looking PR and production. `prReadiness` reads what GitHub
// knows (mergeability, the check rollup, draft state, head sha) and `rollupChecks` turns the rollup
// into one verdict: SUCCESS only when every check passed (NEUTRAL/SKIPPED count as passed). The
// CodeRabbit context is reported separately (`coderabbitCheck`): it is the REVIEW gate, not a CI
// check — the shepherd requires it to have passed on the exact head before merging, with its own
// wait/nudge/give-up timers. A failing CodeRabbit context still counts as a failure. `mergePr` is pinned to the head sha the gate saw
// (`--match-head-commit`), so anything pushed between gate and merge fails closed instead of landing
// unreviewed.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
export { closePr } from "@/lib/friday/codeSummary";

const execFileAsync = promisify(execFile);

export type ChecksVerdict = "SUCCESS" | "PENDING" | "FAILURE" | "NONE";
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
export type CodeRabbitCheck = "pass" | "fail" | "pending" | "absent";

export interface PrReadiness {
  url: string;
  number: number;
  owner: string;
  repo: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  title: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  /** Tip of the base branch as GitHub sees it; lets the shepherd tell "main moved" from "this PR is stuck". */
  baseSha?: string;
  headSha: string;
  mergeable: Mergeable;
  mergeState: string;
  checks: ChecksVerdict;
  /** The CodeRabbit status context on the HEAD commit (GitHub scopes the rollup to the head). */
  coderabbitCheck: CodeRabbitCheck;
  failingChecks: string[];
  pendingChecks: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RollupEntry { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string | null; state?: string }

const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);

/** One verdict from GitHub's mixed CheckRun/StatusContext rollup. Pure. */
export function rollupChecks(rollup: RollupEntry[] | null | undefined): { checks: ChecksVerdict; failing: string[]; pending: string[]; coderabbit: CodeRabbitCheck } {
  if (!rollup || !rollup.length) return { checks: "NONE", failing: [], pending: [], coderabbit: "absent" };
  const failing: string[] = [];
  const pending: string[] = [];
  let coderabbit: CodeRabbitCheck = "absent";
  let ci = 0;
  for (const e of rollup) {
    const name = (e.name || e.context || "check").trim();
    const conclusion = (e.conclusion || "").toUpperCase();
    const state = (e.state || "").toUpperCase();
    const status = (e.status || "").toUpperCase();
    let verdict: "pass" | "fail" | "pending";
    if (conclusion) verdict = FAIL.has(conclusion) ? "fail" : PASS.has(conclusion) ? "pass" : "pending";
    else if (state) verdict = FAIL.has(state) ? "fail" : PASS.has(state) ? "pass" : "pending";
    else if (status) verdict = status === "COMPLETED" ? "pass" : PENDING.has(status) ? "pending" : "pending";
    else verdict = "pending";
    if (/coderabbit/i.test(name)) {
      coderabbit = verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "pending";
      if (verdict === "fail") failing.push(name);
      continue; // a pending review is the shepherd's review-coverage wait, not a CI wait
    }
    ci++;
    if (verdict === "fail") failing.push(name);
    else if (verdict === "pending") pending.push(name);
  }
  if (failing.length) return { checks: "FAILURE", failing, pending, coderabbit };
  if (!ci) return { checks: "NONE", failing, pending, coderabbit };
  if (pending.length) return { checks: "PENDING", failing, pending, coderabbit };
  return { checks: "SUCCESS", failing, pending, coderabbit };
}

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/\s]+)\/([^/\s]+?)\/pull\/(\d+)/i);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, ""), number: Number(m[3]) } : null;
}

export async function prReadiness(url: string): Promise<PrReadiness | null> {
  const id = parsePrUrl(url);
  if (!id) return null;
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", url, "--json", "number,state,isDraft,headRefName,baseRefName,baseRefOid,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,title,author,createdAt,updatedAt"],
      { timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const r = JSON.parse(stdout) as Record<string, unknown>;
    const roll = rollupChecks(r.statusCheckRollup as RollupEntry[] | undefined);
    const mergeableRaw = String(r.mergeable ?? "UNKNOWN").toUpperCase();
    return {
      url, number: Number(r.number) || id.number, owner: id.owner, repo: id.repo,
      state: (String(r.state ?? "OPEN").toUpperCase() as PrReadiness["state"]),
      isDraft: r.isDraft === true,
      title: String(r.title ?? ""),
      author: String((r.author as { login?: string } | undefined)?.login ?? ""),
      headRefName: String(r.headRefName ?? ""),
      baseRefName: String(r.baseRefName ?? "main"),
      baseSha: typeof r.baseRefOid === "string" ? r.baseRefOid : undefined,
      headSha: String(r.headRefOid ?? ""),
      mergeable: mergeableRaw === "MERGEABLE" || mergeableRaw === "CONFLICTING" ? (mergeableRaw as Mergeable) : "UNKNOWN",
      mergeState: String(r.mergeStateStatus ?? ""),
      checks: roll.checks, coderabbitCheck: roll.coderabbit, failingChecks: roll.failing, pendingChecks: roll.pending,
      createdAt: String(r.createdAt ?? ""), updatedAt: String(r.updatedAt ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * Squash-merge, pinned to the head sha the gate evaluated. GitHub refuses the merge if the branch
 * moved — the shepherd re-evaluates on the next tick instead of landing something it never saw.
 */
export async function mergePr(url: string, opts: { expectHeadSha: string }): Promise<{ ok: boolean; mergeSha?: string; error?: string }> {
  try {
    await execFileAsync("gh", ["pr", "merge", url, "--squash", "--delete-branch", "--match-head-commit", opts.expectHeadSha], { timeout: 90_000, windowsHide: true });
  } catch (e) {
    return { ok: false, error: String((e as { stderr?: string }).stderr || e).trim().slice(0, 300) };
  }
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "view", url, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"], { timeout: 20_000, windowsHide: true });
    return { ok: true, mergeSha: stdout.trim() || undefined };
  } catch {
    return { ok: true };
  }
}

/** Merge the base branch into the PR head (GitHub's "Update branch"). Fails when conflicts need a human/agent. */
export async function updateBranch(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync("gh", ["pr", "update-branch", url], { timeout: 60_000, windowsHide: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as { stderr?: string }).stderr || e).trim().slice(0, 300) };
  }
}
