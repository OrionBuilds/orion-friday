// FRIDAY code deliverables — after a coding agent runs, capture what actually changed:
// a link to the GitHub PR (parsed from the agent's output) plus a per-repo diff/commit summary
// read from the real workspace checkout. All best-effort: any git/parse failure degrades to
// "no summary" rather than throwing, so it never breaks the run's completion.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { projectRepoDirs } from "@/lib/friday/delivery";
import type { Project } from "@/lib/friday/types";

const execFileAsync = promisify(execFile);

// First GitHub PR URL in the text (agents are asked to end their output with it).
const PR_RE = /https?:\/\/github\.com\/[^\s)\]]+\/pull\/\d+/i;

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 20_000, windowsHide: true });
    return stdout.trim();
  } catch {
    return "";
  }
}

// Ask GitHub whether a PR URL is merged (uses the user's `gh` auth). Returns "MERGED" | "OPEN" |
// "CLOSED" | "" (unknown/error). Used by the scheduler's PR-merged → task-delivered watcher.
export async function prState(url: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "view", url, "--json", "state", "--jq", ".state"], { timeout: 20_000, windowsHide: true });
    return stdout.trim().toUpperCase();
  } catch {
    return "";
  }
}

// Merge a PR (squash + delete branch) using the user's gh auth. Returns {ok} or an error string.
export async function mergePr(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync("gh", ["pr", "merge", url, "--squash", "--delete-branch"], { timeout: 60_000, windowsHide: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as { stderr?: string }).stderr || e).slice(0, 200) };
  }
}

/** Close a PR with a comment (supersede/stale). Never throws. */
export async function closePr(url: string, comment: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync("gh", ["pr", "close", url, "--comment", comment], { timeout: 30_000, windowsHide: true });
    return { ok: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, error: (err.stderr || err.message || String(e)).trim().slice(0, 200) };
  }
}

export interface CodeSummary {
  prUrl?: string;
  changeSummary?: string; // human-readable markdown of what changed, per repo
}

export async function summarizeCodeRun(project: Project | null, resultText: string, opts: { dirs?: { url: string; dir: string }[] } = {}): Promise<CodeSummary> {
  const out: CodeSummary = {};
  const prMatch = resultText.match(PR_RE);
  if (prMatch) out.prUrl = prMatch[0].replace(/[.,;)]+$/, "");
  if (!project) return out;

  const dirs = (opts.dirs ?? projectRepoDirs(project)).filter((d) => existsSync(path.join(d.dir, ".git")));
  const blocks: string[] = [];
  for (const { url, dir } of dirs) {
    // Uncommitted working-tree changes first; if the agent committed instead, fall back to the
    // last commit's file stat. Plus the recent commit log for context.
    let stat = await git(["diff", "--stat", "HEAD"], dir);
    let via = "uncommitted changes";
    if (!stat) { stat = await git(["show", "--stat", "--format=%h %s", "HEAD"], dir); via = "last commit"; }
    const log = await git(["log", "--oneline", "-3"], dir);
    if (!stat && !log) continue;
    const repoName = url.replace(/\.git$/, "").split("/").slice(-2).join("/");
    let block = `**${repoName}** (${via})`;
    if (stat) block += `\n\n\`\`\`\n${stat.slice(0, 1500)}\n\`\`\``;
    if (log) block += `\n\nRecent commits:\n${log.split("\n").map((l) => `- ${l}`).join("\n")}`;
    blocks.push(block);
  }
  if (blocks.length) out.changeSummary = blocks.join("\n\n");
  return out;
}
