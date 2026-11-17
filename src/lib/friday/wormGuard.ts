// Worm guard — what FRIDAY does when wormScan finds the worm (or an agent reports it).
//
// On a hit: stop, touch NOTHING in that repo (no fix, no commit, no push), delete the worktree the
// code was checked out in, block the repo for every further run and shepherd action, and tell the
// owner by timely email (critical, security — never a text; FRIDAY never texts). The block lifts only
// when the owner says "resume <repo>" or a scan of the repo's current default branch comes back
// clean (recheckBlockedRepos, scheduled).
//
// 2026-09-28: FRIDAY's agents previously "fixed" worm payloads as ordinary code changes ("drop
// attacker-planted config.bat ignore rule", "remove hidden folderOpen launcher") and never said a
// word — while her builds executed the payload on this box. Silence was the failure; this is the fix.

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { logEvent, nowISO, FRIDAY_DATA_DIR } from "@/lib/persistence/store";
import { isWorktreeDir } from "@/lib/friday/delivery";
import { describeHits, scanDir, scanGitRef, describeCheckout, type WormHit } from "@/lib/friday/wormScan";

/** The three outcomes of a guard check. Only `clean` lets work proceed. */
export type GuardOutcome =
  | { kind: "clean" }
  | { kind: "blocked"; reason: string }      // malware found now or earlier — owner already emailed
  | { kind: "unavailable"; reason: string }; // couldn't read the block list or finish the scan — retry later

export interface BlockedRepo {
  key: string;              // owner/repo (lowercase) or a local path when there's no GitHub remote
  repoUrl?: string;
  branch?: string;
  sha?: string;
  files: string[];          // what matched (first few)
  source: string;           // run | verify | agent-report | shepherd
  blockedAt: string;
}
export type BlockFile = Record<string, BlockedRepo>;

const BLOCK_FILE = () => path.join(FRIDAY_DATA_DIR, "worm-blocked.json");

export interface GuardDeps {
  load: () => Promise<BlockFile>;
  save: (s: BlockFile) => Promise<void>;
  notify: (opts: import("@/lib/friday/notify").NotifyOpts) => Promise<unknown>;
  removeDir: (dir: string) => Promise<void>;
  isWorktreeDir: (dir: string) => boolean;
  log: (event: string, data: Record<string, unknown>) => Promise<unknown>;
}

// A missing file means nothing is blocked. Anything else (unreadable, corrupt) THROWS: callers treat
// an unknown block state as "don't proceed", never as "nothing blocked".
async function loadBlocks(): Promise<BlockFile> {
  let raw: string;
  try { raw = await fs.readFile(BLOCK_FILE(), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  return JSON.parse(raw) as BlockFile;
}
async function saveBlocks(s: BlockFile): Promise<void> {
  const tmp = `${BLOCK_FILE()}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(BLOCK_FILE()), { recursive: true }).catch(() => {});
  await fs.writeFile(tmp, JSON.stringify(s, null, 2));
  await fs.rename(tmp, BLOCK_FILE());
}

function defaultDeps(): GuardDeps {
  return {
    load: loadBlocks,
    save: saveBlocks,
    notify: async (opts) => (await import("@/lib/friday/notify")).notifyOwner(opts),
    removeDir: async (dir) => {
      // Find the base repo first (so its worktree registration can be pruned), then delete the folder.
      const common = await new Promise<string>((resolve) => execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, timeout: 30_000 }, (err, out) => resolve(err ? "" : String(out).trim())));
      await fs.rm(dir, { recursive: true, force: true });
      if (common) await new Promise<void>((resolve) => execFile("git", ["worktree", "prune"], { cwd: path.dirname(common), timeout: 30_000 }, () => resolve()));
    },
    isWorktreeDir,
    log: (event, data) => logEvent(event, data, { level: "warn" }),
  };
}

/** owner/repo (lowercase) for a GitHub repo or PR URL / git remote; the raw string otherwise. Pure. */
export function repoKey(urlOrPath: string | undefined | null): string {
  const s = (urlOrPath ?? "").trim();
  const m = s.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/|$|#|\?)/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : s.toLowerCase();
}

/** The block entry covering a repo, if any. */
export async function blockFor(urlOrKey: string, deps: Pick<GuardDeps, "load"> = defaultDeps()): Promise<BlockedRepo | null> {
  const s = await deps.load();
  return s[repoKey(urlOrKey)] ?? null;
}

export async function blockedRepos(deps: Pick<GuardDeps, "load"> = defaultDeps()): Promise<BlockedRepo[]> {
  return Object.values(await deps.load());
}

/** Plain-English owner email for a hit. Pure. */
export function hitEmail(input: { key: string; branch?: string; sha?: string; hits: WormHit[]; source: string }): { headline: string; summary: string } {
  const where = [input.branch ? `branch ${input.branch}` : "", input.sha ? `commit ${input.sha.slice(0, 7)}` : ""].filter(Boolean).join(", ");
  const found = input.source === "agent-report"
    ? "One of my agents stopped and reported that the code looks like it carries malware"
    : "My pre-build scan found signs of the tip-rewrite worm (the malware cleaned up on Sept 28)";
  return {
    headline: `Possible malware in ${input.key} — I've stopped touching it`,
    summary:
      `${found} in ${input.key}${where ? ` (${where})` : ""}. What matched:\n${describeHits(input.hits)}\n\n`
      + "I did not build, run, fix, commit or push anything in that repo, and I deleted my working copy of it. "
      + `I won't work on ${input.key} again until you confirm it's clean — reply "resume ${input.key.split("/").pop()}" — `
      + "or until a scan of its main branch comes back clean on its own.",
  };
}

export interface HitInput {
  repoUrl?: string;         // GitHub URL or remote; falls back to the local root path
  root?: string;            // the checkout that was scanned
  branch?: string;
  sha?: string;
  hits: WormHit[];
  source: "run" | "verify" | "agent-report" | "shepherd";
  worktreeDir?: string;     // deleted when it is one of FRIDAY's worktrees
  projectId?: string;
  taskId?: string;
}

/**
 * Record a hit: block the repo, delete the worktree, email the owner (deduped per repo + commit).
 * Never throws — a failure here must not un-stop the run that called it.
 */
export async function reportWormHit(input: HitInput, deps: GuardDeps = defaultDeps()): Promise<BlockedRepo> {
  const key = repoKey(input.repoUrl ?? input.root ?? "unknown");
  const entry: BlockedRepo = {
    key, repoUrl: input.repoUrl, branch: input.branch, sha: input.sha,
    files: [...new Set(input.hits.map((h) => h.file))].slice(0, 12),
    source: input.source, blockedAt: nowISO(),
  };
  try {
    const s = await deps.load();
    // A fresh blockedAt on every hit, so a recheck that started before this hit can't lift it.
    s[key] = { ...(s[key] ?? {}), ...entry };
    await deps.save(s);
  } catch { /* the in-memory refusal still stands for this run */ }
  if (input.worktreeDir && deps.isWorktreeDir(input.worktreeDir)) {
    await deps.removeDir(input.worktreeDir).catch(() => {});
  }
  await deps.log("security.malware_suspected", { repo: key, branch: input.branch, sha: input.sha, source: input.source, files: entry.files, taskId: input.taskId, projectId: input.projectId }).catch(() => {});
  const mail = hitEmail({ key, branch: input.branch, sha: input.sha, hits: input.hits, source: input.source });
  await deps.notify({
    kind: "security.malware_suspected",
    priority: "critical",
    emergencyCategory: "security",
    email: true,
    headline: mail.headline,
    summary: mail.summary,
    text: `${mail.headline}. ${mail.summary}`.slice(0, 1500),
    dedupeKey: `worm:${key}:${input.sha ?? entry.files.join(",")}`,
  }).catch(() => {});
  return entry;
}

/**
 * Scan a run's working directory before anything executes there (and again after the agent finished,
 * before anything is finalized or built). `blocked` has already been reported (owner emailed, repo
 * blocked, worktree deleted); `unavailable` means the check itself failed — don't proceed, retry.
 */
export async function guardWorkspace(input: { cwd?: string; repoUrls: string[]; source: "run" | "verify"; projectId?: string; taskId?: string }, deps: GuardDeps = defaultDeps()): Promise<GuardOutcome> {
  let blocks: BlockFile;
  try { blocks = await deps.load(); }
  catch (e) { return { kind: "unavailable", reason: `malware block list unreadable (${String(e).slice(0, 120)}) — not running until it can be checked` }; }
  const blocked = input.repoUrls.map((u) => blocks[repoKey(u)]).find(Boolean);
  if (blocked) return { kind: "blocked", reason: `malware-suspected: ${blocked.key} is blocked since ${blocked.blockedAt.slice(0, 16)} (${blocked.files.slice(0, 3).join(", ")}) — waiting for the owner to confirm it's clean.` };
  if (!input.cwd) return { kind: "clean" };
  let scans: Awaited<ReturnType<typeof scanDir>>;
  try { scans = await scanDir(input.cwd); }
  catch (e) { return { kind: "unavailable", reason: `malware scan could not complete (${String(e).slice(0, 120)}) — not running until it can` }; }
  const dirty = scans.filter((x) => x.hits.length);
  if (!dirty.length) return { kind: "clean" };
  const reasons: string[] = [];
  for (const x of dirty) {
    const co = await describeCheckout(x.root);
    const entry = await reportWormHit({
      repoUrl: co.remote ?? (input.repoUrls.length === 1 ? input.repoUrls[0] : undefined),
      root: x.root, branch: co.branch, sha: co.sha, hits: x.hits, source: input.source,
      worktreeDir: input.cwd, projectId: input.projectId, taskId: input.taskId,
    }, deps);
    reasons.push(`${entry.key} (${entry.files.slice(0, 3).join(", ")})`);
  }
  return { kind: "blocked", reason: `malware-suspected: ${reasons.join("; ")}` };
}

/** Scan a ref already present in `repoDir`; report + block on a hit. */
export async function guardRef(input: { repoDir: string; ref: string; repoUrl: string; branch?: string; sha?: string; projectId?: string }, deps: GuardDeps = defaultDeps(), scan: typeof scanGitRef = scanGitRef): Promise<GuardOutcome> {
  let blocked: BlockedRepo | null;
  try { blocked = await blockFor(input.repoUrl, deps); }
  catch (e) { return { kind: "unavailable", reason: `malware block list unreadable (${String(e).slice(0, 120)})` }; }
  if (blocked) return { kind: "blocked", reason: `malware-suspected: ${blocked.key} is blocked` };
  let hits: WormHit[];
  try { hits = await scan(input.repoDir, input.ref); }
  catch (e) { return { kind: "unavailable", reason: `malware scan of ${input.ref} could not complete (${String(e).slice(0, 120)})` }; }
  if (!hits.length) return { kind: "clean" };
  const entry = await reportWormHit({ repoUrl: input.repoUrl, branch: input.branch, sha: input.sha, hits, source: "shepherd", projectId: input.projectId }, deps);
  return { kind: "blocked", reason: `malware-suspected: ${entry.key} (${entry.files.slice(0, 3).join(", ")})` };
}

// ── Scan cache ───────────────────────────────────────────────────────────────
// A bare repo per GitHub repo under the FRIDAY data dir, used only to fetch refs for scanning.
// Nobody works in it and nothing is ever checked out or run from it, so scanning a PR head or the
// default branch never touches the owner's checkouts or FRIDAY's worktrees.

function gitIn(cwd: string, args: string[], timeoutMs = 180_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, out) => resolve({ ok: !err, out: String(out ?? "") })));
}

export function scanCacheDir(key: string): string {
  return path.join(FRIDAY_DATA_DIR, "worm-scan-cache", key.replace(/[^a-z0-9._-]+/gi, "_") + ".git");
}

/** Bare repo for owner/repo with `origin` pointing at GitHub. Returns null for non-GitHub keys. */
export async function ensureScanCache(key: string): Promise<string | null> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(key)) return null;
  const dir = scanCacheDir(key);
  if (!(await fs.stat(path.join(dir, "HEAD")).then(() => true, () => false))) {
    await fs.mkdir(dir, { recursive: true });
    if (!(await gitIn(dir, ["init", "--bare", "-q"])).ok) return null;
    await gitIn(dir, ["remote", "add", "origin", `https://github.com/${key}.git`]);
  }
  return dir;
}

/**
 * Fetch a PR's head (refs/pull/<n>/head on the base repo — works for fork PRs too) into the scan cache,
 * confirm it is exactly `headSha`, and scan it. A moved head or any failure is `unavailable`, never clean.
 */
export async function guardPrHead(input: { key: string; prNumber: number; headRef: string; headSha: string; repoUrl: string; projectId?: string }, deps: GuardDeps = defaultDeps(), scan: typeof scanGitRef = scanGitRef, cache: (key: string) => Promise<string | null> = ensureScanCache): Promise<GuardOutcome> {
  let blocked: BlockedRepo | null;
  try { blocked = await blockFor(input.key, deps); }
  catch (e) { return { kind: "unavailable", reason: `malware block list unreadable (${String(e).slice(0, 120)})` }; }
  if (blocked) return { kind: "blocked", reason: `malware-suspected: ${blocked.key} is blocked` };
  const dir = await cache(input.key).catch(() => null);
  if (!dir) return { kind: "unavailable", reason: `no scan cache for ${input.key}` };
  const ref = `refs/scan/pr-${input.prNumber}`;
  const f = await gitIn(dir, ["fetch", "-q", "--depth=1", "origin", `+refs/pull/${input.prNumber}/head:${ref}`]);
  if (!f.ok) return { kind: "unavailable", reason: `could not fetch ${input.key}#${input.prNumber} to scan it` };
  const got = (await gitIn(dir, ["rev-parse", ref])).out.trim();
  if (!input.headSha || got !== input.headSha) return { kind: "unavailable", reason: `${input.key}#${input.prNumber} head moved while scanning (${got.slice(0, 7)} ≠ ${input.headSha.slice(0, 7)})` };
  return guardRef({ repoDir: dir, ref, repoUrl: input.repoUrl, branch: input.headRef, sha: input.headSha, projectId: input.projectId }, deps, scan);
}

const RESUME_RX = /^\s*(?:please\s+)?(?:resume|unblock|unpause)\s+(?:work\s+on\s+)?(?:the\s+)?([\w.-]+(?:\/[\w.-]+)?)(?:\s+repo(?:sitory)?)?\s*[.!]?\s*$/i;

/** The repo named by a "resume <repo>" owner command, or null. Pure. */
export function parseResumeCommand(text: string): string | null {
  const m = text.match(RESUME_RX);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Owner command: "resume <repo>". Returns the reply, or null when the text isn't a resume command for
 * a blocked repo (so "resume meeting follow-ups" and friends fall through untouched).
 */
export async function tryResumeCommand(text: string, deps: GuardDeps = defaultDeps()): Promise<string | null> {
  const name = parseResumeCommand(text);
  if (!name) return null;
  try {
    const s = await deps.load();
    const matches = Object.keys(s).filter((k) => k === name || k.endsWith(`/${name}`));
    if (!matches.length) return null;
    if (matches.length > 1) return `More than one blocked repo matches "${name}": ${matches.join(", ")}. Say "resume owner/repo".`;
    delete s[matches[0]];
    await deps.save(s);
    await deps.log("security.malware_unblocked", { repo: matches[0], by: "owner" }).catch(() => {});
    return `OK — ${matches[0]} is unblocked. I'll scan it again before every build, and stop again if anything turns up.`;
  } catch (e) {
    // A recognized resume that couldn't be applied must say so — never fall through as if unmatched.
    return `I couldn't lift the block on "${name}" (${String(e).slice(0, 120)}). Nothing changed — it's still blocked. Try again in a minute.`;
  }
}

/**
 * Scheduled: for each blocked GitHub repo, fetch its current default branch into the scan cache and
 * scan it. Clean → lift the block and tell the owner (normal priority, batched). Nothing is checked
 * out or run; the owner's checkouts are never touched.
 */
export async function recheckBlockedRepos(deps: GuardDeps = defaultDeps(), scan: typeof scanGitRef = scanGitRef, cache: (key: string) => Promise<string | null> = ensureScanCache): Promise<string> {
  const s = await deps.load();
  const lifted: BlockedRepo[] = [];
  let still = 0;
  for (const b of Object.values(s)) {
    const dir = await cache(b.key).catch(() => null);
    if (!dir) { still++; continue; }
    const head = await gitIn(dir, ["ls-remote", "--symref", "origin", "HEAD"]);
    const branch = head.out.match(/ref: refs\/heads\/(\S+)\s+HEAD/)?.[1] ?? "main";
    if (!(await gitIn(dir, ["fetch", "-q", "--depth=1", "origin", `+refs/heads/${branch}:refs/scan/default`])).ok) { still++; continue; }
    const hits = await scan(dir, "refs/scan/default").catch(() => null);
    if (hits && hits.length === 0) {
      lifted.push({ ...b, branch });
    } else still++;
  }
  if (lifted.length) {
    // The scans take minutes; a new block may have landed meanwhile. Re-read and remove only the
    // entries lifted here, and only if they weren't re-blocked since.
    const latest = await deps.load();
    const cleared = lifted.filter((b) => latest[b.key]?.blockedAt === b.blockedAt);
    for (const b of cleared) delete latest[b.key];
    await deps.save(latest);
    for (const b of cleared) {
      await deps.log("security.malware_unblocked", { repo: b.key, by: "clean-scan", branch: b.branch }).catch(() => {});
      await deps.notify({ kind: "security.malware_cleared", priority: "normal", headline: `${b.key} scans clean again — work resumed`, summary: `The ${b.branch} branch of ${b.key} no longer shows any sign of the worm, so I've lifted the block I put on it. I scan before every build, so I'll stop again if it comes back.`, text: `${b.key} scans clean again — I've resumed work on it.`, dedupeKey: `wormclear:${b.key}:${b.blockedAt}` }).catch(() => {});
    }
    return `worm recheck: ${cleared.length} unblocked, ${still + lifted.length - cleared.length} still blocked`;
  }
  return `worm recheck: 0 unblocked, ${still} still blocked`;
}
