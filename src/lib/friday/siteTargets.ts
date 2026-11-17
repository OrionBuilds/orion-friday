// Which live sites FRIDAY monitors (2026-10-28 audit, gap 8; contract §7).
//
// The hourly uptime probe, the daily security-header sweep and the local uptime job all used to
// read `deployUrl` from the local projects.json — which no project carries — so every run reported
// "0 site(s) probed" and looked green. The OS is now the source: `projects.netlify_site_url` (via
// projects_list, active projects). The local store's deployUrl is only a fallback for projects the
// OS has no netlify_site_url for. Callers MUST treat an empty target list as a failure, never as "all up".

import { callOsTool, osRows } from "@/lib/friday/osTool";

export interface SiteTarget {
  /** Stable state key: the local project id when known (keeps uptime-state.json continuity), else `os:<id>`. */
  key: string;
  name: string;
  url: string;
  osProjectId?: string;
  localProjectId?: string;
  source: "os" | "local";
}

export interface SiteTargetsResult {
  targets: SiteTarget[];
  fromOs: number;
  fromLocal: number;
  /** Set when the OS read failed (tool missing / auth / error) — the local fallback still applies. */
  osError?: string;
}

/** Bare hostnames mean https (a stored `pest-example.com` used to be dropped silently). */
export function normaliseSiteUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try { return new URL(url).toString().replace(/\/$/, ""); } catch { return null; }
}

interface OsProjectRow { id: string; name?: string | null; status?: string | null; netlify_site_url?: string | null; site_url?: string | null }
interface LocalProjectLite { id: string; name: string; status?: string; deployUrl?: string }

/** Pure merge: OS netlify_site_url first, local deployUrl for anything the OS didn't cover. De-duplicated by URL. */
export function mergeSiteTargets(
  osProjects: OsProjectRow[],
  osToLocal: Map<string, string>,
  localProjects: LocalProjectLite[],
): { targets: SiteTarget[]; fromOs: number; fromLocal: number } {
  const targets: SiteTarget[] = [];
  const seenUrls = new Set<string>();
  const coveredLocal = new Set<string>();
  let fromOs = 0;
  let fromLocal = 0;
  for (const p of osProjects) {
    if (p.status && p.status !== "active") continue;
    const url = normaliseSiteUrl(p.netlify_site_url ?? p.site_url);
    if (!url || seenUrls.has(url)) continue;
    const localId = osToLocal.get(p.id);
    seenUrls.add(url);
    if (localId) coveredLocal.add(localId);
    targets.push({ key: localId ?? `os:${p.id}`, name: p.name || "project", url, osProjectId: p.id, localProjectId: localId, source: "os" });
    fromOs++;
  }
  for (const p of localProjects) {
    if (p.status !== "active" || coveredLocal.has(p.id)) continue;
    const url = normaliseSiteUrl(p.deployUrl);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    targets.push({ key: p.id, name: p.name, url, localProjectId: p.id, source: "local" });
    fromLocal++;
  }
  return { targets, fromOs, fromLocal };
}

type ToolClient = { callTool(name: string, args?: Record<string, unknown>): Promise<unknown> };

/** Resolve every site to probe. Never throws. */
export async function resolveSiteTargets(opts: { client?: ToolClient } = {}): Promise<SiteTargetsResult> {
  const { store } = await import("@/lib/persistence/store");
  const locals = (await store.projects.all()) as LocalProjectLite[];
  const listed = await callOsTool<unknown>("projects_list", { status: "eq.active", limit: 500 }, { client: opts.client, context: { for: "siteTargets" } });
  let osProjects: OsProjectRow[] = [];
  let osError: string | undefined;
  if (listed.ok) osProjects = osRows<OsProjectRow>(listed.data);
  else osError = listed.error;
  const osToLocal = new Map<string, string>();
  if (osProjects.length) {
    const meta = await callOsTool<unknown>("project_agent_meta_get", { agent: "friday" }, { client: opts.client, context: { for: "siteTargets" } });
    if (meta.ok) {
      const localIds = new Set(locals.map((p) => p.id));
      for (const r of osRows<{ project_id: string; local_project_id: string | null }>(meta.data)) {
        if (r.local_project_id && localIds.has(r.local_project_id)) osToLocal.set(r.project_id, r.local_project_id);
      }
    }
  }
  const merged = mergeSiteTargets(osProjects, osToLocal, locals);
  return { ...merged, ...(osError ? { osError } : {}) };
}

/** The error every monitor raises when it would otherwise "probe 0 sites" and report green. */
export function noSitesError(job: string, r: SiteTargetsResult): Error {
  return new Error(
    `${job}: 0 sites to probe — no active OS project has projects.netlify_site_url and no local project has a deployUrl` +
      (r.osError ? ` (OS read failed: ${r.osError.slice(0, 160)})` : "") +
      ". Set netlify_site_url on the OS projects; a monitor that probes nothing is a failure, not a pass.",
  );
}
