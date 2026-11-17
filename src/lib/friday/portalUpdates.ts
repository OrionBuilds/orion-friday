// FRIDAY — client-portal development updates (daily) + the shared engine behind the backfill CLI.
//
// The OS client portal's "Project Updates" feed reads project_activity_log rows with
// event_type='milestone'. This job posts one client-facing entry per unit of work that landed on a
// repo-linked project's DEFAULT branch since the last run, via the OS MCP tool
// `project_activity_create`, in the sectioned plain-English format defined in portalUpdateCopy.ts.
//
// 2026-09-23 rewrite (owner: "FRIDAY is not updating the client portal"):
//   * PRs and direct commits are BOTH posted. The old code `continue`d past the commit path whenever
//     a PR had merged, so real work pushed straight to main vanished (globex-fl, Sep 21).
//   * Housekeeping (dependency bumps, CI/config-only, lockfile-only, internal docs) is classified by
//     changed-file paths and SKIPPED, logged as portal_updates.skipped_noise. Clients see a highlight
//     reel, not "we bumped a lockfile".
//   * Only the default branch is read. Unmerged `friday` branch work is not live and must not be
//     announced as live (owner rule: merge to main == live).
//   * GitHub errors propagate to portal_updates.repo_error at level=error and leave the cursor at the
//     last successful unit — nothing is skipped silently any more.
//   * True merge commits are expanded via compare/{base}...{head} so side-branch commits authored
//     before the cursor but merged after it are still seen.
//
// Design notes kept from v1:
//   * First sighting of a repo INITIALIZES the cursor without posting — history is the backfill's job
//     (scripts/friday/portal-updates-backfill.ts). Without this, enabling the job would dump a repo's
//     whole history into a client's feed at once.
//   * Dedup is layered: local cursor + skippedRefs prevent re-reads; the MCP tool dedupes on
//     payload.source_ref; and the sha list on each posted row lets a re-grouped digest be recognised.
//
// Kill switch: FRIDAY_PORTAL_UPDATES=off. Per-project opt-out: Project.portalUpdates === false.

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { store, logEvent } from "@/lib/persistence/store";
import { osClient, osEnabled } from "@/lib/friday/osClient";
import { parseGithubRepo } from "@/lib/friday/recentWork";
import { projectRepos } from "@/lib/friday/types";
import type { Project } from "@/lib/friday/types";
import {
  classifyUnit, composeEntry,
  type ChangedFile, type UnitCommit, type WorkUnit, type UpdateEntry, type ComposeCtx,
} from "@/lib/friday/portalUpdateCopy";

const execFileAsync = promisify(execFile);

export function portalUpdatesEnabled(): boolean {
  return (process.env.FRIDAY_PORTAL_UPDATES ?? "on").trim().toLowerCase() !== "off";
}

export const STATE_FILE = path.join(os.homedir(), ".agentic-os", "friday", "portal-updates-state.json");

export interface RepoCursor {
  initializedAt: string;
  lastMergedAt?: string;   // newest PR merged_at posted/evaluated (ISO)
  lastCommitAt?: string;   // newest default-branch commit date posted/evaluated (ISO)
  defaultBranch?: string;  // cached from repos/{o}/{r}
  skippedRefs?: string[];  // noise refs already evaluated — never re-classified (FIFO, capped)
}
export type State = Record<string, RepoCursor>; // key: owner/repo

const SKIPPED_CAP = 200;

export async function loadState(): Promise<State> {
  try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); } catch { return {}; }
}
export async function saveState(s: State): Promise<void> {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true }).catch(() => {});
  await fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

// ── GitHub reads (gh CLI, ambient auth — same pattern as recentWork/codeSummary) ──

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ghSpacingMs = 0;
/** Backfill sets a small gap between calls so a long walk stays well inside the API budget. */
export function setGhSpacing(ms: number): void { ghSpacingMs = ms; }

async function ghJson<T>(apiPath: string, jq: string, opts: { paginate?: boolean } = {}): Promise<T> {
  if (ghSpacingMs) await sleep(ghSpacingMs);
  // --paginate runs the jq filter once per page and prints each result on its own line; `tojson`
  // makes every page a single compact line so the pages can be split and flattened. (gh refuses
  // --slurp together with --jq.)
  const args = ["api", apiPath, ...(opts.paginate ? ["--paginate", "--jq", `(${jq}) | tojson`] : ["--jq", jq])];
  try {
    const { stdout } = await execFileAsync("gh", args, { timeout: opts.paginate ? 120_000 : 30_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    const text = stdout.trim();
    if (!text) return (opts.paginate ? [] : null) as T;
    if (opts.paginate) {
      const pages = text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as unknown[]);
      return (pages.flat(1) as unknown) as T;
    }
    return JSON.parse(text) as T;
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(`gh api ${apiPath}: ${(err.stderr || err.message || String(e)).trim().slice(0, 300)}`);
  }
}

export async function fetchDefaultBranch(owner: string, repo: string): Promise<string> {
  // Wrapped in an object: gh prints a bare jq string result unquoted, which is not JSON.
  const r = await ghJson<{ b?: string } | null>(`repos/${owner}/${repo}`, "{b: .default_branch}");
  return r?.b || "main";
}

export interface MergedPr { number: number; title: string; body: string; merged_at: string; merge_commit_sha: string | null; html_url: string }

export async function fetchMergedPrs(
  owner: string, repo: string, base: string, sinceIso: string, untilIso?: string, opts: { paginate?: boolean } = {},
): Promise<MergedPr[]> {
  const q = `repos/${owner}/${repo}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=${opts.paginate ? 100 : 50}`;
  const jq = "[.[] | select(.merged_at != null) | {number, title, body: (.body // \"\"), merged_at, merge_commit_sha, html_url}]";
  const prs = await ghJson<MergedPr[]>(q, jq, opts);
  return (prs ?? [])
    .filter((p) => p.merged_at > sinceIso && (!untilIso || p.merged_at <= untilIso))
    .sort((a, b) => a.merged_at.localeCompare(b.merged_at));
}

export interface CommitInfo { sha: string; date: string; message: string; parents: string[] }

export async function fetchCommits(
  owner: string, repo: string, branch: string, sinceIso: string, untilIso?: string, opts: { paginate?: boolean } = {},
): Promise<CommitInfo[]> {
  const until = untilIso ? `&until=${encodeURIComponent(untilIso)}` : "";
  const q = `repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(sinceIso)}${until}&per_page=100`;
  const jq = "[.[] | {sha: .sha, date: (.commit.committer.date // .commit.author.date), message: .commit.message, parents: [.parents[].sha]}]";
  const rows = await ghJson<CommitInfo[]>(q, jq, opts);
  return (rows ?? []).filter((c) => c.date > sinceIso && (!untilIso || c.date <= untilIso)).sort((a, b) => a.date.localeCompare(b.date));
}

const FILES_JQ = "[.[] | {path: .filename, additions, deletions, status}]";

export async function fetchPrFiles(owner: string, repo: string, n: number): Promise<ChangedFile[]> {
  return (await ghJson<ChangedFile[]>(`repos/${owner}/${repo}/pulls/${n}/files?per_page=100`, FILES_JQ)) ?? [];
}
export async function fetchPrCommits(owner: string, repo: string, n: number): Promise<UnitCommit[]> {
  const rows = await ghJson<Array<{ sha: string; message: string }>>(
    `repos/${owner}/${repo}/pulls/${n}/commits?per_page=50`, "[.[] | {sha: .sha, message: .commit.message}]",
  );
  return (rows ?? []).map(toUnitCommit);
}
export async function fetchCommitFiles(owner: string, repo: string, sha: string): Promise<ChangedFile[]> {
  return (await ghJson<ChangedFile[]>(`repos/${owner}/${repo}/commits/${sha}`, "[.files[]? | {path: .filename, additions, deletions, status}]")) ?? [];
}
export async function fetchCompare(owner: string, repo: string, base: string, head: string): Promise<{ commits: UnitCommit[]; files: ChangedFile[] }> {
  const r = await ghJson<{ commits: Array<{ sha: string; message: string }>; files: ChangedFile[] }>(
    `repos/${owner}/${repo}/compare/${base}...${head}`,
    "{commits: [.commits[] | {sha: .sha, message: .commit.message}], files: [.files[]? | {path: .filename, additions, deletions, status}]}",
  );
  return { commits: (r?.commits ?? []).map(toUnitCommit), files: r?.files ?? [] };
}

function toUnitCommit(c: { sha: string; message: string }): UnitCommit {
  const [subject, ...rest] = (c.message ?? "").split("\n");
  return { sha: c.sha, subject: (subject ?? "").trim(), body: rest.join("\n").trim() };
}

function mergeFiles(lists: ChangedFile[][]): ChangedFile[] {
  const agg = new Map<string, ChangedFile>();
  for (const list of lists) for (const f of list) {
    const cur = agg.get(f.path);
    if (cur) { cur.additions += f.additions || 0; cur.deletions += f.deletions || 0; }
    else agg.set(f.path, { ...f });
  }
  return [...agg.values()];
}

// ── Unit collection ────────────────────────────────────────────────────────

export interface CollectOpts {
  since: string;
  until?: string;
  defaultBranch: string;
  paginate?: boolean;
}

/**
 * Everything that landed on the default branch in (since, until]: merged PRs, true merge commits
 * (expanded via compare), and direct commits grouped by UTC day. Sorted oldest → newest.
 */
export async function collectUnits(owner: string, repo: string, opts: CollectOpts): Promise<WorkUnit[]> {
  const prs = await fetchMergedPrs(owner, repo, opts.defaultBranch, opts.since, opts.until, { paginate: opts.paginate });
  const prShas = new Set(prs.map((p) => p.merge_commit_sha).filter(Boolean) as string[]);
  const prNums = new Set(prs.map((p) => p.number));

  const commits = await fetchCommits(owner, repo, opts.defaultBranch, opts.since, opts.until, { paginate: opts.paginate });
  const notPr = commits.filter((c) => {
    if (prShas.has(c.sha)) return false;
    const m = c.message.split("\n")[0].match(/\(#(\d+)\)\s*$/);
    return !(m && prNums.has(Number(m[1])));
  });
  const merges = notPr.filter((c) => c.parents.length > 1);
  let direct = notPr.filter((c) => c.parents.length <= 1);

  const units: WorkUnit[] = [];

  for (const pr of prs) {
    const [files, prCommits] = await Promise.all([fetchPrFiles(owner, repo, pr.number), fetchPrCommits(owner, repo, pr.number)]);
    // A PR merged with a merge commit (not squashed) lands its commits on the default branch too —
    // they belong to the PR unit, not to a same-day digest.
    const prCommitShas = new Set(prCommits.map((c) => c.sha));
    direct = direct.filter((c) => !prCommitShas.has(c.sha));
    units.push({
      kind: "pr", ref: `pr#${pr.number}`, title: pr.title, body: pr.body, url: pr.html_url,
      commits: prCommits.length ? prCommits : [{ sha: pr.merge_commit_sha ?? "", subject: pr.title, body: "" }],
      files, occurredAt: pr.merged_at,
    });
  }

  for (const m of merges) {
    const { commits: brought, files } = await fetchCompare(owner, repo, m.parents[0], m.sha);
    const broughtShas = new Set(brought.map((c) => c.sha));
    direct = direct.filter((c) => !broughtShas.has(c.sha));
    const subject = m.message.split("\n")[0];
    units.push({
      kind: "merge", ref: `merge-${m.sha.slice(0, 7)}`,
      title: brought.length === 1 ? brought[0].subject : subject,
      body: brought.length === 1 ? brought[0].body : "",
      commits: brought.length ? brought : [toUnitCommit({ sha: m.sha, message: m.message })],
      files, occurredAt: m.date,
    });
  }

  const byDay = new Map<string, CommitInfo[]>();
  for (const c of direct) {
    const day = c.date.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), c]);
  }
  for (const [day, list] of byDay) {
    const sorted = list.sort((a, b) => a.date.localeCompare(b.date));
    const newest = sorted[sorted.length - 1];
    const fileLists: ChangedFile[][] = [];
    for (const c of sorted) fileLists.push(await fetchCommitFiles(owner, repo, c.sha));
    const unitCommits = sorted.map((c) => toUnitCommit({ sha: c.sha, message: c.message }));
    units.push({
      kind: "commit-digest", ref: `commits-${day}-${newest.sha.slice(0, 7)}`,
      title: sorted.length === 1 ? unitCommits[0].subject : `${sorted.length} changes on ${day}`,
      body: sorted.length === 1 ? unitCommits[0].body : "",
      commits: unitCommits, files: mergeFiles(fileLists), occurredAt: newest.date,
    });
  }

  return units.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

// ── Request context (cheap, local) ─────────────────────────────────────────

const CR_MARKER = /\[os-cr:([0-9a-f-]{8,})\]/i;

/** The task / change request that asked for this work, when FRIDAY produced the PR itself. */
export async function linkRequestContext(unit: WorkUnit): Promise<WorkUnit["request"] | undefined> {
  try {
    if (unit.url) {
      const runs = await store.runs.find((r) => !!r.taskId && (r.artifacts ?? []).some((a) => a.kind === "pr" && a.url === unit.url));
      const run = runs[0];
      if (run?.taskId) {
        const task = await store.tasks.get(run.taskId);
        if (task) {
          const asked = (task.details || task.description || task.title || "").replace(/\s+/g, " ").trim().slice(0, 800);
          if (asked) return { asked, by: task.requestedBy, kind: task.requestKind };
        }
      }
    }
    const m = unit.body.match(CR_MARKER);
    if (m) {
      const tasks = await store.tasks.find((t) => (t.description ?? "").includes(m[0]) || (t.details ?? "").includes(m[0]));
      const t = tasks[0];
      if (t) {
        const asked = (t.details || t.description || t.title || "").replace(CR_MARKER, "").replace(/\s+/g, " ").trim().slice(0, 800);
        if (asked) return { asked, by: t.requestedBy, kind: t.requestKind };
      }
    }
  } catch { /* context is a nice-to-have — never block the post */ }
  return undefined;
}

// ── OS plumbing ────────────────────────────────────────────────────────────

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

export async function osProjectMap(): Promise<Map<string, string>> {
  const rows = unwrap(await osClient.callTool("project_agent_meta_get", { agent: "friday" })) as
    Array<{ project_id: string; local_project_id: string | null }>;
  const map = new Map<string, string>();
  if (Array.isArray(rows)) for (const r of rows) if (r.local_project_id) map.set(r.local_project_id, r.project_id);
  return map;
}

export interface Posted { refs: Set<string>; shas: Set<string> }

/** What's already on this project's feed — source_refs and the commit shas each row covered. */
export async function existingPosted(osProjectId: string): Promise<Posted> {
  const out: Posted = { refs: new Set(), shas: new Set() };
  const rows = unwrap(await osClient.callTool("project_activity_list", { project_id: osProjectId, limit: 200 })) as
    Array<{ event_type?: string; payload?: { source_ref?: string; shas?: string[] } }>;
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (r.event_type !== "milestone") continue;
    if (r.payload?.source_ref) out.refs.add(r.payload.source_ref);
    for (const s of r.payload?.shas ?? []) if (typeof s === "string") out.shas.add(s);
  }
  return out;
}

export async function postEntry(osProjectId: string, entry: UpdateEntry, unit: WorkUnit): Promise<{ deduped: boolean }> {
  const res = unwrap(await osClient.callTool("project_activity_create", {
    project_id: osProjectId,
    title: entry.title,
    detail: entry.detail,
    occurred_at: unit.occurredAt,
    source_ref: unit.ref,
    sections: entry.sections,
    is_live: entry.is_live,
    kind: entry.kind === "maintenance" ? "fix" : entry.kind,
    shas: unit.commits.map((c) => c.sha).filter(Boolean).slice(0, 100),
  })) as { deduped?: boolean; error?: string } | null;
  if (res && typeof res === "object" && "error" in res && res.error) throw new Error(`project_activity_create: ${res.error}`);
  return { deduped: Boolean(res && typeof res === "object" && res.deduped) };
}

// ── Shared per-unit decision (job + backfill) ───────────────────────────────

export type UnitDecision =
  | { action: "post"; entry: UpdateEntry & { issues?: string[] } }
  | { action: "skip"; reason: string }
  | { action: "dedup" };

export async function decideUnit(
  unit: WorkUnit, posted: Posted, cursor: RepoCursor | undefined, ctx: ComposeCtx, opts: { noLlm?: boolean } = {},
): Promise<UnitDecision> {
  if (posted.refs.has(unit.ref) || cursor?.skippedRefs?.includes(unit.ref)) return { action: "dedup" };
  const shas = unit.commits.map((c) => c.sha).filter(Boolean);
  if (shas.length && shas.every((s) => posted.shas.has(s))) return { action: "skip", reason: "already-posted" };
  const cls = classifyUnit(unit);
  if (cls.noise) return { action: "skip", reason: cls.reason ?? "noise" };
  unit.request = unit.request ?? (await linkRequestContext(unit));
  const entry = await composeEntry(unit, ctx, opts);
  return { action: "post", entry };
}

function rememberSkipped(cursor: RepoCursor, ref: string): void {
  const list = cursor.skippedRefs ?? [];
  if (!list.includes(ref)) list.push(ref);
  cursor.skippedRefs = list.slice(-SKIPPED_CAP);
}

/** Projects the job may post for: active, repo-linked, not opted out. */
export async function portalProjects(): Promise<Project[]> {
  return store.projects.find((p: Project) => p.status === "active" && projectRepos(p).length > 0 && p.portalUpdates !== false);
}

// ── The job ────────────────────────────────────────────────────────────────

export async function runPortalUpdates(): Promise<string> {
  if (!portalUpdatesEnabled()) return "portal updates disabled";
  if (!osEnabled()) return "OS bridge disabled";

  const projects = await portalProjects();
  if (!projects.length) return "no active repo-linked projects";

  const map = await osProjectMap();
  const state = await loadState();
  const now = new Date().toISOString();
  let posted = 0, initialized = 0, skippedUnmapped = 0, noise = 0, deduped = 0, errors = 0, fallbacks = 0;

  for (const p of projects) {
    const osId = map.get(p.id);
    if (!osId) { skippedUnmapped++; continue; } // not mirrored to the OS yet — bridge will create it
    let already: Posted | undefined;

    for (const repoUrl of projectRepos(p)) {
      const gh = parseGithubRepo(repoUrl);
      if (!gh) continue;
      const key = `${gh.owner}/${gh.repo}`;
      const cursor = state[key];

      // First sighting: set the cursor to now, post nothing (history is backfill territory).
      if (!cursor) {
        state[key] = { initializedAt: now, lastMergedAt: now, lastCommitAt: now };
        initialized++;
        await saveState(state);
        continue;
      }

      try {
        if (!cursor.defaultBranch) { cursor.defaultBranch = await fetchDefaultBranch(gh.owner, gh.repo); await saveState(state); }
        const since = [cursor.lastMergedAt, cursor.lastCommitAt].filter(Boolean).sort()[0] ?? cursor.initializedAt;
        const units = await collectUnits(gh.owner, gh.repo, { since, defaultBranch: cursor.defaultBranch });
        if (!units.length) { cursor.lastMergedAt = now; cursor.lastCommitAt = now; await saveState(state); continue; }
        already = already ?? (await existingPosted(osId));
        const ctx: ComposeCtx = { projectName: p.name, mode: "live" };

        for (const unit of units) {
          const decision = await decideUnit(unit, already, cursor, ctx);
          if (decision.action === "dedup") { deduped++; }
          else if (decision.action === "skip") {
            noise++;
            rememberSkipped(cursor, unit.ref);
            await logEvent("portal_updates.skipped_noise", { repo: key, ref: unit.ref, reason: decision.reason, title: unit.title.slice(0, 120) });
          } else {
            const r = await postEntry(osId, decision.entry, unit);
            if (r.deduped) deduped++;
            else {
              posted++;
              already.refs.add(unit.ref);
              for (const c of unit.commits) if (c.sha) already.shas.add(c.sha);
              if (decision.entry.via === "fallback") {
                fallbacks++;
                await logEvent("portal_updates.copy_fallback", { repo: key, ref: unit.ref, issues: decision.entry.issues ?? [] }, { level: "warn" });
              }
            }
          }
          // Advance the matching cursor to this unit — a crash mid-loop resumes here, and the
          // server-side source_ref dedup covers the one unit that may have posted before the save.
          if (unit.kind === "pr") cursor.lastMergedAt = maxIso(cursor.lastMergedAt, unit.occurredAt);
          else cursor.lastCommitAt = maxIso(cursor.lastCommitAt, unit.occurredAt);
          await saveState(state);
        }
        // Clean pass → both cursors to now so the next tick doesn't re-walk the window.
        cursor.lastMergedAt = now; cursor.lastCommitAt = now;
        await saveState(state);
      } catch (e) {
        errors++;
        await logEvent("portal_updates.repo_error", { repo: key, project: p.name, error: String((e as Error).message ?? e).slice(0, 400) }, { level: "error" });
      }
    }
  }

  await saveState(state);
  if (posted || noise || errors) await logEvent("portal_updates.posted", { posted, noise, deduped, errors, fallbacks, initialized });
  return `posted ${posted}, skipped ${noise} noise, ${deduped} deduped, ${errors} repo error(s), ${fallbacks} fallback copy, initialized ${initialized} repo cursor(s), ${skippedUnmapped} unmapped`;
}

function maxIso(a: string | undefined, b: string): string {
  return a && a > b ? a : b;
}
