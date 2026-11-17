// FRIDAY — per-build client release approvals (the portal's "Ready for your review" card).
//
// The owner never merges (owner rule 2026-09-24): FRIDAY lands every green PR herself (PR shepherd).
// The ONE legitimate external gate is a client's sign-off on a build, and only for projects that
// opted in (`Project.clientSignoff`). This module:
//   * collectClientOpenPrs() — the shared live view: for each mapped client project, the open PRs
//     on its repo(s) with mergeability/checks.
//   * runReleaseApprovals() — for opted-in projects, ensures the newest shippable FEATURE PR has a
//     pending `project_release_approvals` row so the client can sign off. Upkeep PRs (dependency
//     sweeps and their fix rounds) are never put in front of a client. The shepherd waits for the
//     card's decision before merging that PR.
// Kill switch: FRIDAY_RELEASE_APPROVALS=off.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { store } from "@/lib/persistence/store";
import { osClient, osEnabled } from "@/lib/friday/osClient";
import { complete } from "@/lib/friday/engines";
import { parseGithubRepo } from "@/lib/friday/recentWork";
import { projectRepos } from "@/lib/friday/types";
import type { Project } from "@/lib/friday/types";
import { isUpkeepPr } from "@/lib/friday/prUpkeep";

const execFileAsync = promisify(execFile);

// Master switch (default OFF). Per-project opt-in is `Project.clientSignoff`.
export function releaseApprovalsEnabled(): boolean {
  return (process.env.FRIDAY_RELEASE_APPROVALS ?? "off").trim().toLowerCase() === "on";
}

export interface OpenPr {
  number: number;
  url: string;
  title: string;
  body: string;
  isDraft: boolean;
  /** GitHub's mergeable state: MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable: string;
  /** Rolled-up checks: SUCCESS | PENDING | FAILURE | "" (none). */
  checks: string;
  headRefName?: string;
  createdAt?: string;
}

/** A PR fit to put in front of a client: not a draft, no conflicts, checks not failing.
 *  UNKNOWN mergeability is allowed (GitHub is still computing) — CONFLICTING is not. */
export function isShippable(pr: OpenPr): boolean {
  return !pr.isDraft && pr.mergeable !== "CONFLICTING" && pr.checks !== "FAILURE";
}

export interface ClientRepoPrs {
  localProjectId: string;
  osProjectId: string;
  projectName: string;
  clientId?: string;
  clientName?: string;
  owner: string;
  repo: string;
  prs: OpenPr[];
}

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

async function osProjectMap(): Promise<Map<string, string>> {
  const rows = unwrap(await osClient.callTool("project_agent_meta_get", { agent: "friday" })) as
    Array<{ project_id: string; local_project_id: string | null }>;
  const map = new Map<string, string>();
  if (Array.isArray(rows)) for (const r of rows) if (r.local_project_id) map.set(r.local_project_id, r.project_id);
  return map;
}

export async function listOpenPrs(owner: string, repo: string): Promise<OpenPr[]> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "list", "--repo", `${owner}/${repo}`, "--state", "open", "--limit", "50",
        "--json", "number,url,title,body,mergeable,isDraft,statusCheckRollup,headRefName,createdAt"],
      { timeout: 25_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const raw = JSON.parse(stdout || "[]") as Array<Record<string, unknown>>;
    const prs = raw.map((r) => {
      const rollup = (r.statusCheckRollup as Array<{ conclusion?: string; state?: string }> | undefined) ?? [];
      let checks = "";
      if (rollup.length) {
        const states = rollup.map((c) => (c.conclusion || c.state || "").toUpperCase());
        checks = states.some((s) => s === "FAILURE" || s === "ERROR") ? "FAILURE"
          : states.some((s) => s === "PENDING" || s === "IN_PROGRESS" || s === "QUEUED") ? "PENDING"
          : "SUCCESS";
      }
      return {
        number: Number(r.number) || 0,
        url: String(r.url ?? ""),
        title: String(r.title ?? ""),
        body: String(r.body ?? ""),
        isDraft: r.isDraft === true,
        mergeable: String(r.mergeable ?? "UNKNOWN").toUpperCase(),
        checks,
        headRefName: typeof r.headRefName === "string" ? r.headRefName : undefined,
        createdAt: typeof r.createdAt === "string" ? r.createdAt : undefined,
      };
    }).filter((p) => p.url);
    const { removedPrKeys, prKey } = await import("@/lib/friday/removedPrs");
    const removed = await removedPrKeys();
    return removed.size ? prs.filter((p) => !removed.has(prKey(p.url) ?? "")) : prs;
  } catch {
    return []; // repo unreachable / gh error — degrade to no PRs
  }
}

/** Live per-project open-PR view over all mapped, active, repo-linked client projects.
 *  The per-repo `gh` calls run in PARALLEL — sequential across ~16 repos blew past the
 *  office's fetch timeout ("FRIDAY OFFLINE"). */
export async function collectClientOpenPrs(): Promise<ClientRepoPrs[]> {
  if (!osEnabled()) return [];
  const projects = await store.projects.find((p: Project) => p.status === "active" && projectRepos(p).length > 0 && p.portalUpdates !== false);
  if (!projects.length) return [];
  const map = await osProjectMap();

  // Flatten to (project, repo) tasks, then fan the gh queries out concurrently.
  const tasks: Array<{ p: Project; osId: string; owner: string; repo: string }> = [];
  for (const p of projects) {
    const osId = map.get(p.id);
    if (!osId) continue; // not mirrored to the OS yet
    for (const repoUrl of projectRepos(p)) {
      const gh = parseGithubRepo(repoUrl);
      if (gh) tasks.push({ p, osId, owner: gh.owner, repo: gh.repo });
    }
  }

  const results = await Promise.all(tasks.map(async (t) => ({ t, prs: await listOpenPrs(t.owner, t.repo) })));

  const clientNameCache = new Map<string, string | undefined>();
  const out: ClientRepoPrs[] = [];
  for (const { t, prs } of results) {
    if (!prs.length) continue;
    let clientName = t.p.clientId ? clientNameCache.get(t.p.clientId) : undefined;
    if (t.p.clientId && !clientNameCache.has(t.p.clientId)) {
      clientName = (await store.clients.get(t.p.clientId))?.name;
      clientNameCache.set(t.p.clientId, clientName);
    }
    out.push({
      localProjectId: t.p.id,
      osProjectId: t.osId,
      projectName: t.p.name,
      clientId: t.p.clientId,
      clientName,
      owner: t.owner,
      repo: t.repo,
      prs,
    });
  }
  return out;
}

// Client-facing "what ships" copy — same sectioned, validated, plain-English pipeline as the portal
// feed (portalUpdateCopy.composeEntry) in "pending" mode, so the live_now section reads "ready and
// waiting for your go-ahead" instead of claiming the change is live. Deterministic fallback never
// blocks filing. Files come from GitHub when available so the copy can name feature areas.
async function composeReleaseCopy(projectName: string, owner: string, repo: string, pr: OpenPr): Promise<{ title: string; changelog: string }> {
  const { composeEntry, sectionsToText } = await import("@/lib/friday/portalUpdateCopy");
  const { fetchPrFiles } = await import("@/lib/friday/portalUpdates");
  const files = await fetchPrFiles(owner, repo, pr.number).catch(() => []);
  const entry = await composeEntry(
    { kind: "pr", ref: `pr#${pr.number}`, title: pr.title, body: pr.body, url: pr.url, commits: [], files, occurredAt: new Date().toISOString() },
    { projectName, mode: "pending" },
  );
  return { title: entry.title, changelog: sectionsToText(entry.sections) };
}

/** File a single client build sign-off for one PR (idempotent server-side). Used by
 *  the owner-initiated "Request client sign-off" endpoint and the auto job below. */
export async function fileReleaseApproval(input: {
  osProjectId: string; projectName: string; clientName?: string; owner: string; repo: string; pr: OpenPr;
}): Promise<{ ok: boolean; deduped?: boolean; error?: string }> {
  try {
    const copy = await composeReleaseCopy(input.projectName, input.owner, input.repo, input.pr);
    const res = unwrap(await osClient.callTool("project_release_approval_create", {
      project_id: input.osProjectId,
      pr_url: input.pr.url,
      title: copy.title,
      changelog: copy.changelog,
      pr_repo: `${input.owner}/${input.repo}`,
      pr_number: input.pr.number,
    })) as { deduped?: boolean } | null;
    return { ok: true, deduped: !!res?.deduped };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

async function hasPendingCard(osProjectId: string): Promise<boolean> {
  try {
    const rows = unwrap(await osClient.callTool("project_release_approval_list", { project_id: osProjectId, status: "pending" })) as
      Array<{ id: string }>;
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return true; // on doubt, don't file — avoids duplicating when the check is flaky
  }
}

/** Auto-file AT MOST ONE pending card per opted-in project — the newest shippable FEATURE PR —
 *  and never a second while one is still pending. Upkeep PRs never reach a client. */
export async function runReleaseApprovals(): Promise<string> {
  if (!releaseApprovalsEnabled()) return "release approvals disabled";
  if (!osEnabled()) return "OS bridge disabled";
  const optedIn = new Set((await store.projects.find((p: Project) => p.clientSignoff === true)).map((p) => p.id));
  if (!optedIn.size) return "no projects opted in to client sign-off";
  const groups = (await collectClientOpenPrs()).filter((g) => optedIn.has(g.localProjectId));
  if (!groups.length) return "no open client PRs on opted-in projects";

  // One entry per OS project (a project may map to multiple repos — dedupe the newest
  // shippable PR across them by PR number).
  const newestByProject = new Map<string, { g: ClientRepoPrs; pr: OpenPr }>();
  for (const g of groups) {
    const shippable = g.prs.filter((pr) => isShippable(pr) && !isUpkeepPr(pr));
    if (!shippable.length) continue;
    const top = shippable.reduce((a, b) => (b.number > a.number ? b : a));
    const cur = newestByProject.get(g.osProjectId);
    if (!cur || top.number > cur.pr.number) newestByProject.set(g.osProjectId, { g, pr: top });
  }

  let filed = 0, alreadyOpen = 0, failed = 0;
  for (const { g, pr } of newestByProject.values()) {
    if (await hasPendingCard(g.osProjectId)) { alreadyOpen++; continue; }
    const r = await fileReleaseApproval({ osProjectId: g.osProjectId, projectName: g.projectName, clientName: g.clientName, owner: g.owner, repo: g.repo, pr });
    if (!r.ok) { failed++; continue; }
    if (!r.deduped) filed++;
  }
  return `filed ${filed}, ${alreadyOpen} projects already have an open card, ${failed} failed`;
}
