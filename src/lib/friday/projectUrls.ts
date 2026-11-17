// OS project URLs for FRIDAY's local projects (2026-10-28 audit gaps 5 + 8; contract §7).
//
// Local project id → OS project id (project_agent_meta, agent "friday"), plus the OS project's URLs:
// `repo_urls` (array), `netlify_site_url` and `staging_url`. Repos and the site URL reach the local
// store through the two-way connections sync (connectionsSync.ts), so nothing here overrides them;
// these values are for callers that need the OS id or the OS-side URLs. The mapping comes from
// project_agent_meta (agent "friday"). One projects_list + one project_agent_meta_get per TTL; any
// OS failure (tool down, column not deployed yet, auth) degrades to "no OS value" — the local value.

import { callOsTool, osRows } from "@/lib/friday/osTool";

export interface OsProjectUrls {
  osProjectId: string;
  repoUrls: string[];
  siteUrl: string | null;
  stagingUrl: string | null;
}

const TTL_MS = 10 * 60_000;
let cache: { at: number; byLocalId: Map<string, OsProjectUrls> } | null = null;
let inflight: Promise<Map<string, OsProjectUrls>> | null = null;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Pure: join meta rows (local→OS id) with project rows (OS id → urls). Exported for tests. */
export function joinProjectUrls(metaRows: unknown[], projectRows: unknown[]): Map<string, OsProjectUrls> {
  const byOsId = new Map<string, Record<string, unknown>>();
  for (const r of projectRows) {
    const o = r as Record<string, unknown>;
    if (typeof o?.id === "string") byOsId.set(o.id, o);
  }
  const out = new Map<string, OsProjectUrls>();
  for (const m of metaRows) {
    const o = m as { local_project_id?: unknown; project_id?: unknown };
    if (typeof o?.local_project_id !== "string" || typeof o?.project_id !== "string") continue;
    const p = byOsId.get(o.project_id);
    out.set(o.local_project_id, {
      osProjectId: o.project_id,
      repoUrls: Array.isArray(p?.repo_urls) ? (p.repo_urls as unknown[]).map(str).filter((x): x is string => Boolean(x)) : [],
      siteUrl: str(p?.netlify_site_url) ?? str(p?.site_url),
      stagingUrl: str(p?.staging_url),
    });
  }
  return out;
}

/** Refresh (TTL-gated, single-flight, never throws). Returns the current map (possibly empty). */
export async function refreshOsProjectUrls(force = false): Promise<Map<string, OsProjectUrls>> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.byLocalId;
  if (inflight) return inflight;
  inflight = (async () => {
    const [meta, projects] = await Promise.all([
      callOsTool("project_agent_meta_get", { agent: "friday" }, { context: { via: "projectUrls" } }),
      callOsTool("projects_list", { limit: 500 }, { context: { via: "projectUrls" } }),
    ]);
    if (!meta.ok || !projects.ok) {
      // Keep the last good map; stamp the time so a down OS isn't hammered every call.
      cache = { at: Date.now(), byLocalId: cache?.byLocalId ?? new Map() };
      return cache.byLocalId;
    }
    cache = { at: Date.now(), byLocalId: joinProjectUrls(osRows(meta.data), osRows(projects.data)) };
    return cache.byLocalId;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Cached OS urls for a local project (sync; kicks a background refresh when stale). */
export function osProjectUrlsFor(localProjectId: string): OsProjectUrls | null {
  if ((!cache || Date.now() - cache.at >= TTL_MS) && !process.env.NODE_TEST_CONTEXT) void refreshOsProjectUrls();
  return cache?.byLocalId.get(localProjectId) ?? null;
}

/** Test hook: pin the cache. */
export function _setOsProjectUrls(map: Map<string, OsProjectUrls> | null): void {
  cache = map ? { at: Date.now() + 365 * 86_400_000, byLocalId: map } : null;
}

