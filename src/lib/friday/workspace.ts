// Project workspace provisioning — GitHub repo, Supabase project, Netlify site.
// Two modes per provider: LINK an existing one (just store the URL/ref) or CREATE a new one.
//   - GitHub  → the authenticated `gh` CLI (gh repo create). Works out of the box.
//   - Netlify → REST API with NETLIFY_AUTH_TOKEN (.env.local).
//   - Supabase→ Management API with SUPABASE_ACCESS_TOKEN (+ org/region). Creating costs $/mo.
// Results are written back onto the project (repoUrl / supabaseRef / deployUrl) by the caller.

import { spawn } from "node:child_process";

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "project";
}

// Run a CLI (gh) capturing stdout.
//
// shell:false always. This previously used shell:true on Windows, and the comment
// claimed "args here are fixed flags + a sanitised slug, so there's no arg-injection
// surface" — that was wrong: createGithubRepo slugs the repo NAME but passes `owner`
// and `description` through untouched. Under shell:true the whole command line goes
// via cmd.exe, so argument-array separation stops protecting anything and a
// description of `x & calc.exe` executes.
//
// `gh` is a real .exe on PATH, so it resolves fine without a shell. If a future
// caller needs a .cmd shim, resolve its absolute path rather than re-enabling shell.
function sh(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false });
    let out = "";
    const to = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout?.on("data", (b) => (out += b));
    child.stderr?.on("data", (b) => (out += b));
    child.on("close", (code) => { clearTimeout(to); resolve({ ok: code === 0, out: out.trim() }); });
    child.on("error", (e) => { clearTimeout(to); resolve({ ok: false, out: String(e) }); });
  });
}

// ── GitHub ────────────────────────────────────────────────────────────────
export async function createGithubRepo(name: string, opts: { private?: boolean; description?: string; owner?: string } = {}): Promise<{ ok: boolean; url?: string; error?: string }> {
  const repo = slug(name);
  const owner = opts.owner || process.env.GITHUB_OWNER;
  const target = owner ? `${owner}/${repo}` : repo;
  const args = ["repo", "create", target, opts.private === false ? "--public" : "--private"];
  if (opts.description) args.push("-d", opts.description.slice(0, 200));
  const r = await sh("gh", args);
  if (!r.ok) return { ok: false, error: `gh repo create failed: ${r.out.slice(0, 240)}` };
  _repoCache = null; // a new repo exists → let the next search re-list
  // gh prints the repo URL; fall back to constructing it.
  const m = r.out.match(/https:\/\/github\.com\/[^\s]+/);
  return { ok: true, url: m ? m[0] : (owner ? `https://github.com/${owner}/${repo}` : undefined) };
}

// ── Netlify ────────────────────────────────────────────────────────────────
function netlifyToken(): string | null { return process.env.NETLIFY_AUTH_TOKEN?.trim() || null; }

export async function createNetlifySite(name: string): Promise<{ ok: boolean; url?: string; adminUrl?: string; error?: string }> {
  const token = netlifyToken();
  if (!token) return { ok: false, error: "Set NETLIFY_AUTH_TOKEN in .env.local to create Netlify sites." };
  const r = await fetch("https://api.netlify.com/api/v1/sites", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: slug(name) }),
  });
  if (!r.ok) return { ok: false, error: `Netlify ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json();
  return { ok: true, url: j.ssl_url || j.url, adminUrl: j.admin_url };
}

export function netlifyConfigured(): boolean { return Boolean(netlifyToken()); }

// ── Deploy triage (Phase 5, read-only first) + the §7.4 reverse gear ────────────────────────────

export interface NetlifyDeploy {
  id: string;
  state: string;           // "ready" | "error" | "building" | ...
  context?: string;        // "production" | "deploy-preview" | "branch-deploy"
  branch?: string;
  commitRef?: string;      // short (8) — kept for the existing readers
  commitRefFull?: string;  // full sha — the shepherd matches a merge commit against it
  createdAt?: string;
  deployTimeSec?: number;
  errorMessage?: string;
  deployUrl?: string;
}

function toDeploy(j: Record<string, unknown>): NetlifyDeploy {
  return {
    id: String(j.id ?? ""),
    state: String(j.state ?? "unknown"),
    context: typeof j.context === "string" ? j.context : undefined,
    branch: typeof j.branch === "string" ? j.branch : undefined,
    commitRef: typeof j.commit_ref === "string" ? j.commit_ref.slice(0, 8) : undefined,
    commitRefFull: typeof j.commit_ref === "string" ? j.commit_ref : undefined,
    createdAt: typeof j.created_at === "string" ? j.created_at : undefined,
    deployTimeSec: typeof j.deploy_time === "number" ? j.deploy_time : undefined,
    errorMessage: typeof j.error_message === "string" ? j.error_message : undefined,
    deployUrl: typeof j.deploy_ssl_url === "string" ? j.deploy_ssl_url : undefined,
  };
}

/** Recent deploys for a site, newest first — the read that makes 'why is prod broken' answerable. */
export async function listNetlifyDeploys(siteId: string, limit = 5): Promise<{ ok: boolean; deploys: NetlifyDeploy[]; error?: string }> {
  const token = netlifyToken();
  if (!token) return { ok: false, deploys: [], error: "Netlify isn't configured (NETLIFY_AUTH_TOKEN)." };
  const r = await fetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys?per_page=${Math.min(Math.max(limit, 1), 20)}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!r || !r.ok) return { ok: false, deploys: [], error: `Netlify ${r?.status ?? "unreachable"}` };
  const arr = (await r.json().catch(() => [])) as Array<Record<string, unknown>>;
  return { ok: true, deploys: arr.map(toDeploy) };
}

/**
 * The §7.4 reverse gear for `deploy`: publish a previous deploy again (Netlify restore). Changes
 * what production serves, so the caller MUST gate it — this function only does the work.
 */
export async function restoreNetlifyDeploy(siteId: string, deployId: string): Promise<{ ok: boolean; error?: string }> {
  const token = netlifyToken();
  if (!token) return { ok: false, error: "Netlify isn't configured (NETLIFY_AUTH_TOKEN)." };
  const r = await fetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}/restore`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!r || !r.ok) return { ok: false, error: `Netlify ${r?.status ?? "unreachable"}: ${r ? (await r.text().catch(() => "")).slice(0, 200) : "no response"}` };
  return { ok: true };
}

export interface NetlifySite { id: string; name: string; url: string; adminUrl: string; customDomain?: string }

export type ProductionDeployOutcome =
  | { status: "ready"; deployId: string; url?: string; via: "git" | "triggered" }
  | { status: "error"; deployId?: string; error: string }
  | { status: "timeout"; deployId?: string }
  | { status: "no-site" };

/**
 * After a merge lands on the default branch, wait for the PRODUCTION deploy of that commit. The
 * client sites are git-connected on Netlify, so the merge itself starts the build — triggering
 * another one would just queue a redundant build. If no production deploy for the merge sha shows
 * up within `fallbackAfterMs`, the site isn't git-linked: trigger a build and wait for that one.
 * Resolves the site once and persists `netlifySiteId` (+ `deployUrl`) on the project so the
 * post-deploy probe has something to hit. Never throws.
 */
export async function awaitProductionDeploy(
  project: { id: string; name: string; netlifySiteId?: string; deployUrl?: string },
  mergeSha: string,
  opts: { timeoutMs?: number; fallbackAfterMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ProductionDeployOutcome> {
  if (!netlifyConfigured()) return { status: "no-site" };
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const fallbackAfterMs = opts.fallbackAfterMs ?? 3 * 60_000;
  const pollMs = opts.pollMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let siteId = project.netlifySiteId;
  if (!siteId) {
    const site = await findNetlifySite(project.deployUrl || project.name).catch(() => null);
    if (!site) return { status: "no-site" };
    siteId = site.id;
    try {
      const { store } = await import("@/lib/persistence/store");
      const now = new Date().toISOString();
      // A newly learned deployUrl is a connection change: stamp it so it syncs to the OS.
      await store.projects.update(project.id, { netlifySiteId: siteId, ...(project.deployUrl ? {} : { deployUrl: site.url, connectionsUpdatedAt: now }), updatedAt: now });
    } catch { /* persistence is a nice-to-have */ }
  }
  const started = Date.now();
  let triggeredId: string | undefined;
  const sha = mergeSha.toLowerCase();
  while (Date.now() - started < timeoutMs) {
    const r = await listNetlifyDeploys(siteId, 15).catch(() => ({ ok: false, deploys: [] as NetlifyDeploy[] }));
    const match = r.ok
      ? r.deploys.find((d) => triggeredId ? d.id === triggeredId : (d.context === "production" && !!d.commitRefFull && (d.commitRefFull.toLowerCase().startsWith(sha) || sha.startsWith(d.commitRefFull.toLowerCase()))))
      : undefined;
    if (match) {
      if (match.state === "ready") return { status: "ready", deployId: match.id, url: match.deployUrl, via: triggeredId ? "triggered" : "git" };
      if (match.state === "error") return { status: "error", deployId: match.id, error: match.errorMessage || "Netlify reported the build failed" };
    } else if (!triggeredId && Date.now() - started >= fallbackAfterMs) {
      const t = await triggerNetlifyBuild(siteId, {}).catch(() => ({ ok: false as const, error: "trigger failed" }));
      if (!t.ok || !t.deployId) return { status: "error", error: `no production deploy appeared for ${sha.slice(0, 7)} and a manual trigger failed${"error" in t && t.error ? `: ${t.error}` : ""}` };
      triggeredId = t.deployId;
    }
    await sleep(pollMs);
  }
  return { status: "timeout", deployId: triggeredId };
}

const normHost = (s: string | undefined) =>
  (s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\/$/, "");

// Resolve a Netlify site by id, exact name, custom domain, or a deploy URL/host — so a project's
// stored deployUrl (e.g. https://example.com) maps back to its Netlify site for API operations.
export async function findNetlifySite(query: string): Promise<NetlifySite | null> {
  const token = netlifyToken();
  if (!token || !query?.trim()) return null;
  const q = query.trim();
  const host = normHost(q);
  const r = await fetch("https://api.netlify.com/api/v1/sites?filter=all&per_page=100", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const sites = (await r.json().catch(() => [])) as Array<Record<string, string>>;
  const hit =
    sites.find((s) => s.id === q) ||
    sites.find((s) => normHost(s.custom_domain) === host || normHost(s.ssl_url) === host || normHost(s.url) === host) ||
    sites.find((s) => s.name?.toLowerCase() === q.toLowerCase()) ||
    sites.find((s) => host && (normHost(s.ssl_url).includes(host) || normHost(s.custom_domain).includes(host))) ||
    sites.find((s) => host && s.name && host.includes(s.name.toLowerCase()));
  if (!hit) return null;
  return {
    id: hit.id, name: hit.name,
    url: hit.ssl_url || hit.url || `https://${hit.name}.netlify.app`,
    adminUrl: hit.admin_url, customDomain: hit.custom_domain,
  };
}

// Trigger a production build/deploy via the Netlify API. clearCache=true forces a cache-clearing
// rebuild — the reliable way to evict stale user-agent-keyed CDN entries (a plain rebuild won't).
export async function triggerNetlifyBuild(
  siteId: string, opts: { clearCache?: boolean } = {},
): Promise<{ ok: boolean; deployId?: string; error?: string }> {
  const token = netlifyToken();
  if (!token) return { ok: false, error: "Set NETLIFY_AUTH_TOKEN in .env.local (then restart FRIDAY)." };
  const r = await fetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/builds`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(opts.clearCache ? { clear_cache: true } : {}),
  });
  if (!r.ok) return { ok: false, error: `Netlify ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = (await r.json().catch(() => ({}))) as Record<string, string>;
  return { ok: true, deployId: j.deploy_id || j.id };
}

// Purge a site's CDN / Durable / Next.js-runtime cache. Unlike a clear_cache BUILD (which only
// clears the build cache), this evicts already-served cached responses — including stale
// user-agent-keyed prerender variants that a rebuild leaves untouched.
export async function purgeNetlifyCache(
  siteId: string, opts: { cacheTags?: string[] } = {},
): Promise<{ ok: boolean; error?: string }> {
  const token = netlifyToken();
  if (!token) return { ok: false, error: "Set NETLIFY_AUTH_TOKEN in .env.local (then restart FRIDAY)." };
  const body: Record<string, unknown> = { site_id: siteId };
  if (opts.cacheTags?.length) body.cache_tags = opts.cacheTags;
  const r = await fetch("https://api.netlify.com/api/v1/purge", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: `Netlify purge ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  return { ok: true };
}

// Raw site settings relevant to bot handling (prerender/processing) — for diagnosing UA-specific behavior.
export async function netlifySiteSettings(siteId: string): Promise<Record<string, unknown> | null> {
  const token = netlifyToken();
  if (!token) return null;
  const r = await fetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const s = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    name: s.name, prerender: s.prerender, processing_settings: s.processing_settings,
    build_settings: (s.build_settings as Record<string, unknown>)?.["stop_builds"],
    plugins: s.plugins, id: s.id,
  };
}

// Latest deploys for a site (state: building | ready | error | enqueued …) — for verifying a deploy landed.
export async function latestNetlifyDeploys(siteId: string, n = 3): Promise<Array<Record<string, unknown>> | null> {
  const token = netlifyToken();
  if (!token) return null;
  const r = await fetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys?per_page=${n}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const rows = (await r.json().catch(() => [])) as Array<Record<string, unknown>>;
  return rows.map((d) => ({
    id: d.id, state: d.state, context: d.context, branch: d.branch,
    created_at: d.created_at, published_at: d.published_at,
    error_message: d.error_message, title: d.title,
    deploy_ssl_url: d.deploy_ssl_url, deploy_url: d.deploy_url,
  }));
}

// Capture a project's latest branch/deploy-preview URL into `project.stagingUrl`, so client review
// can hand over a preview link instead of production. Best-effort: needs a resolved netlifySiteId and
// deploy previews enabled on the site; a no-op (returns null) otherwise. Callers ignore failures.
export async function captureStagingUrl(projectId: string): Promise<string | null> {
  const { store } = await import("@/lib/persistence/store");
  const project = await store.projects.get(projectId);
  if (!project?.netlifySiteId) return null;
  const deploys = await latestNetlifyDeploys(project.netlifySiteId, 10);
  if (!deploys) return null;
  // Newest READY non-production deploy (deploy-preview or branch-deploy) with a usable URL.
  const preview = deploys.find(
    (d) => d.state === "ready" && d.context !== "production" && (d.deploy_ssl_url || d.deploy_url),
  );
  const url = (preview?.deploy_ssl_url || preview?.deploy_url) as string | undefined;
  if (!url || url === project.stagingUrl) return url ?? null;
  await store.projects.update(projectId, { stagingUrl: url, updatedAt: new Date().toISOString() });
  return url;
}

// ── Supabase ───────────────────────────────────────────────────────────────
function supabaseToken(): string | null { return process.env.SUPABASE_ACCESS_TOKEN?.trim() || null; }

function genPassword(): string {
  // Deterministic-enough strong password (no Math.random needed here — server-side).
  return `Fr1day-${Buffer.from(`${process.hrtime.bigint()}`).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}!`;
}

export async function createSupabaseProject(name: string): Promise<{ ok: boolean; ref?: string; url?: string; error?: string }> {
  const token = supabaseToken();
  if (!token) return { ok: false, error: "Set SUPABASE_ACCESS_TOKEN in .env.local to create Supabase projects." };
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let orgId = process.env.SUPABASE_ORG_ID?.trim();
  if (!orgId) {
    const or = await fetch("https://api.supabase.com/v1/organizations", { headers: auth });
    if (!or.ok) return { ok: false, error: `Supabase orgs ${or.status}` };
    orgId = (await or.json())[0]?.id;
    if (!orgId) return { ok: false, error: "No Supabase organization found" };
  }
  const r = await fetch("https://api.supabase.com/v1/projects", {
    method: "POST", headers: auth,
    body: JSON.stringify({
      organization_id: orgId, name: name.slice(0, 60),
      region: process.env.SUPABASE_REGION?.trim() || "us-east-1",
      db_pass: genPassword(),
    }),
  });
  if (!r.ok) return { ok: false, error: `Supabase ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json();
  return { ok: true, ref: j.id, url: `https://supabase.com/dashboard/project/${j.id}` };
}

export function workspaceTokens(): { github: boolean; netlify: boolean; supabase: boolean } {
  return { github: true /* via gh CLI */, netlify: Boolean(netlifyToken()), supabase: Boolean(supabaseToken()) };
}

// ── Search existing resources (for the link-as-you-type dropdown) ───────────
export interface WsHit { name: string; value: string; description?: string }

function safeJson<T>(s: string): T | null { try { return JSON.parse(s) as T; } catch { return null; } }

function dedupeCI(xs: string[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const x of xs) { const k = x.toLowerCase(); if (k && !seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

// ── GitHub owners: the authed user + every org they belong to ────────────────
// So repo search covers personal AND organization repos ("any repo I have access to").
let _ownerCache: { owners: string[]; at: number } | null = null;
const OWNERS_TTL = 10 * 60_000;

export async function githubOwners(): Promise<string[]> {
  if (_ownerCache && Date.now() - _ownerCache.at < OWNERS_TTL) return _ownerCache.owners;
  // Auto-discover the authed login + orgs. NOTE: `user/orgs` with NO leading slash — under
  // Git Bash (shell:true) a leading slash gets rewritten to a filesystem path.
  const [login, orgs] = await Promise.all([
    sh("gh", ["api", "user", "-q", ".login"], 15_000),
    sh("gh", ["api", "user/orgs", "-q", ".[].login"], 15_000),
  ]);
  const discovered = [
    ...(login.ok ? [login.out.trim()] : []),
    ...(orgs.ok ? orgs.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : []),
  ];
  // Env pins/extends discovery (union), so newly-joined orgs are still picked up automatically.
  const env = [...(process.env.GITHUB_OWNERS ?? "").split(","), process.env.GITHUB_OWNER ?? ""].map((s) => s.trim()).filter(Boolean);
  const owners = dedupeCI([...discovered, ...env]);
  _ownerCache = { owners, at: Date.now() };
  return owners;
}

// ── Merged repo list across all owners (cached so type-ahead doesn't re-shell per keystroke) ─
interface RepoRow { nameWithOwner: string; url: string; description?: string }
let _repoCache: { rows: RepoRow[]; at: number } | null = null;
const REPOS_TTL = 60_000;

async function allRepos(): Promise<RepoRow[]> {
  if (_repoCache && Date.now() - _repoCache.at < REPOS_TTL) return _repoCache.rows;
  const owners = await githubOwners();
  const [lists, accessible] = await Promise.all([
    // `gh repo list <owner>` per owner (scoped — never `gh search` which goes global). Fall back
    // to an unscoped list (authed user's repos) if discovery produced nothing.
    Promise.all(
      (owners.length ? owners : [undefined]).map((o) =>
        sh("gh", ["repo", "list", ...(o ? [o] : []), "--limit", "200", "--json", "nameWithOwner,url,description"], 20_000),
      ),
    ),
    // Plus EVERY repo the token can reach — including collaborator + org-member repos on OTHER
    // people's accounts (e.g. caseyclient1/…), which owner-scoped `gh repo list` never surfaces. Still
    // scoped to the authed user (not the global `gh search`). Uses `-X GET -f` query params (gh with
    // `-f` alone defaults to POST) and a SIMPLE jq (`.[].full_name`) — a jq with pipes/parens/quotes
    // gets mangled by cmd.exe under spawn's shell:true (same reason githubOwners sticks to `.[].login`).
    sh("gh", ["api", "--paginate", "user/repos", "-X", "GET",
      "-f", "affiliation=owner,collaborator,organization_member", "-f", "per_page=100", "-f", "sort=pushed",
      "-q", ".[].full_name"], 30_000),
  ]);
  const rows: RepoRow[] = [];
  const seen = new Set<string>();
  const add = (x: RepoRow) => {
    const k = x.nameWithOwner.toLowerCase();
    if (x.nameWithOwner && !seen.has(k)) { seen.add(k); rows.push(x); }
  };
  for (const r of lists) for (const x of safeJson<RepoRow[]>(r.out) ?? []) add(x);
  // Merge /user/repos (one full_name per line) — build the URL from the name (no description here).
  if (accessible.ok) {
    for (const line of accessible.out.split(/\r?\n/)) {
      const nameWithOwner = line.trim();
      if (nameWithOwner && nameWithOwner.includes("/")) add({ nameWithOwner, url: `https://github.com/${nameWithOwner}` });
    }
  }
  _repoCache = { rows, at: Date.now() };
  return rows;
}

export async function searchGithubRepos(q: string): Promise<WsHit[]> {
  const rows = await allRepos();
  const query = q.trim().toLowerCase();
  return rows
    .filter((x) => !query || `${x.nameWithOwner} ${x.description ?? ""}`.toLowerCase().includes(query))
    .slice(0, 25)
    .map((x) => ({ name: x.nameWithOwner, value: x.url, description: x.description }));
}

export async function searchNetlifySites(q: string): Promise<WsHit[]> {
  const token = netlifyToken();
  if (!token) return [];
  const r = await fetch("https://api.netlify.com/api/v1/sites?filter=all&per_page=50", { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const sites = (await r.json()) as { name: string; ssl_url?: string; url?: string; custom_domain?: string }[];
  const query = q.trim().toLowerCase();
  return sites
    .filter((s) => !query || `${s.name} ${s.custom_domain ?? ""}`.toLowerCase().includes(query))
    .slice(0, 12)
    .map((s) => ({ name: s.name, value: s.ssl_url || s.url || `https://${s.name}.netlify.app`, description: s.custom_domain }));
}

export async function searchSupabaseProjects(q: string): Promise<WsHit[]> {
  const token = supabaseToken();
  if (!token) return [];
  const r = await fetch("https://api.supabase.com/v1/projects", { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const projects = (await r.json()) as { id: string; name: string; region?: string }[];
  const query = q.trim().toLowerCase();
  return projects
    .filter((p) => !query || p.name.toLowerCase().includes(query))
    .slice(0, 12)
    .map((p) => ({ name: p.name, value: p.id, description: p.region }));
}
