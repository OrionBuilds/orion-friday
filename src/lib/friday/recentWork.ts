// FRIDAY — recent-work awareness (owner rule 2026-07-18). The owner often answers a client ask by just
// DOING the work instead of replying. Before FRIDAY replies to a project client, she reads the last
// ~10 commits of the project's repo(s) so she never promises something that already shipped — the
// reply confirms done work as done. Zero app imports (node builtins only): callable from a bare
// harness, and a gh/network failure degrades to an empty block (reply proceeds exactly as before).
//
// Uses the gh CLI via execFile — the same ambient-auth pattern as codeSummary.ts (`gh pr view/merge`).
// Kill switch: FRIDAY_COMMIT_AWARE_REPLIES=off.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function commitAwareEnabled(): boolean {
  return (process.env.FRIDAY_COMMIT_AWARE_REPLIES ?? "on").trim().toLowerCase() !== "off";
}

/** Parse owner/repo out of a GitHub remote URL (https or ssh). Non-GitHub remotes → null. */
export function parseGithubRepo(url: string | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = url.trim().match(/^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

interface CommitLine { date: string; message: string }

// Per-repo cache — email bursts shouldn't hammer the GitHub API. 5-minute TTL is fresher than any
// realistic reply cadence under the 12h hold.
const cache = new Map<string, { at: number; lines: CommitLine[] }>();
const CACHE_TTL_MS = 5 * 60_000;

async function fetchCommits(owner: string, repo: string, count: number): Promise<CommitLine[]> {
  const key = `${owner}/${repo}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.lines;
  const { stdout } = await execFileAsync(
    "gh",
    ["api", `repos/${owner}/${repo}/commits?per_page=${count}`, "--jq", ".[] | (.commit.committer.date // .commit.author.date) + \"\\t\" + (.commit.message | split(\"\\n\")[0])"],
    { timeout: 10_000, windowsHide: true },
  );
  const lines: CommitLine[] = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [date, ...rest] = l.split("\t");
      return { date: (date ?? "").slice(0, 10), message: rest.join("\t").slice(0, 120) };
    })
    .filter((c) => c.message);
  cache.set(key, { at: Date.now(), lines });
  return lines;
}

function commitTargets(
  projects: Array<{ name: string; repoUrls?: string[]; repoUrl?: string }>,
): Array<{ project: string; owner: string; repo: string }> {
  const targets: Array<{ project: string; owner: string; repo: string }> = [];
  for (const p of projects) {
    for (const url of [...(p.repoUrls ?? []), p.repoUrl]) {
      const gh = parseGithubRepo(url ?? undefined);
      if (gh && !targets.some((t) => t.owner === gh.owner && t.repo === gh.repo)) {
        targets.push({ project: p.name, ...gh });
      }
    }
  }
  return targets.slice(0, 2);
}

/**
 * Raw recent commits across a client's repo(s) — same fetch + cache as the prompt block, but as
 * data, for the approval state check (dedup.commitMatchesTitle). [] when disabled or unreachable.
 */
export async function recentCommitLines(
  projects: Array<{ name: string; repoUrls?: string[]; repoUrl?: string }>,
  perRepo = 10,
): Promise<Array<{ repo: string; date: string; message: string }>> {
  if (!commitAwareEnabled()) return [];
  const out: Array<{ repo: string; date: string; message: string }> = [];
  for (const t of commitTargets(projects)) {
    try {
      const commits = await fetchCommits(t.owner, t.repo, perRepo);
      for (const c of commits) out.push({ repo: `${t.owner}/${t.repo}`, ...c });
    } catch { /* repo unreachable — skip it */ }
  }
  return out;
}

/**
 * Like recentCommitLines, but reports which repos could not be read so a caller can tell an empty
 * history from an unreachable GitHub (status provenance must not claim a fresh read it never got).
 */
export async function recentCommitLinesStrict(
  projects: Array<{ name: string; repoUrls?: string[]; repoUrl?: string }>,
  perRepo = 10,
): Promise<{ lines: Array<{ repo: string; date: string; message: string }>; attempted: number; failedRepos: string[] }> {
  const lines: Array<{ repo: string; date: string; message: string }> = [];
  const failedRepos: string[] = [];
  const targets = commitAwareEnabled() ? commitTargets(projects) : [];
  for (const t of targets) {
    try {
      const commits = await fetchCommits(t.owner, t.repo, perRepo);
      for (const c of commits) lines.push({ repo: `${t.owner}/${t.repo}`, ...c });
    } catch { failedRepos.push(`${t.owner}/${t.repo}`); }
  }
  return { lines, attempted: targets.length, failedRepos };
}

/**
 * The "already shipped" prompt block for a client's projects — up to 2 repos, last 10 commits each.
 * Empty string when disabled, no GitHub repos, or every fetch fails (never throws).
 */
export async function recentCommitsBlock(
  projects: Array<{ name: string; repoUrls?: string[]; repoUrl?: string }>,
  perRepo = 10,
): Promise<string> {
  if (!commitAwareEnabled()) return "";
  const sections: string[] = [];
  for (const t of commitTargets(projects)) {
    try {
      const commits = await fetchCommits(t.owner, t.repo, perRepo);
      if (commits.length) {
        sections.push(`${t.project} (${t.owner}/${t.repo}):\n${commits.map((c) => `- ${c.date} ${c.message}`).join("\n")}`);
      }
    } catch { /* repo unreachable — skip it, never block the reply */ }
  }
  if (!sections.length) return "";
  return (
    `\n\n## Already shipped — the last commits on this client's repo(s). This work is DONE. ` +
    `NEVER promise any of it as future work; if their ask matches one of these, tell them it's done.\n` +
    sections.join("\n\n")
  );
}
