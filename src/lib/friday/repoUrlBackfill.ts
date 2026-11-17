// FRIDAY — repoUrl backfill (2026-09-18, mAI Dashboard portal-updates incident).
//
// portal-updates, release-approvals, and commit-aware replies all resolve a project's GitHub
// repo through repoUrl/repoUrls (projectRepos()) — but no project has ever had it populated,
// only workspaceDir (a local checkout). That silently no-ops all three, forever, for every
// project ("no active repo-linked projects" / "no open client PRs" every single run, with no
// error — nothing looked broken, there was just never any data to work from). Backfill repoUrl
// once per project by reading its workspaceDir's own git remote; idempotent — skips anything
// that already has repoUrl/repoUrls set, so this never fights a project that later gets a
// second repo added by hand.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { store } from "@/lib/persistence/store";
import { updateProject } from "@/lib/friday/repo";
import { parseGithubRepo } from "@/lib/friday/recentWork";
import { projectRepos } from "@/lib/friday/types";
import type { Project } from "@/lib/friday/types";

const execFileAsync = promisify(execFile);

async function originUrl(workspaceDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspaceDir, "remote", "get-url", "origin"], {
      timeout: 5_000,
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch {
    return null; // not a git checkout, no "origin" remote, or git unavailable — leave for a human
  }
}

export async function runRepoUrlBackfill(): Promise<string> {
  const projects = await store.projects.find((p: Project) => !projectRepos(p).length && !!p.workspaceDir);
  if (!projects.length) return "nothing to backfill";

  let backfilled = 0;
  let skipped = 0;
  for (const p of projects) {
    const url = await originUrl(p.workspaceDir!);
    if (!url || !parseGithubRepo(url)) {
      skipped++;
      continue;
    }
    await updateProject(p.id, { repoUrl: url, repoUrls: [url] }).catch(() => {});
    backfilled++;
  }
  return `backfilled ${backfilled}, skipped ${skipped} (no git remote / not GitHub)`;
}
