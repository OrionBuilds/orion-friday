// Project connections ↔ the OS. The OS (projects.repo_urls / supabase_project_ref / netlify_site_url /
// files_*) is the source of truth, edited on the OS project detail card. FRIDAY keeps a local copy on
// the Project (repoUrls, supabaseRef, deployUrl, driveFolderId, files*) because the delivery engine
// reads it constantly, and FRIDAY also changes it itself (attaching a repo, resolving a Netlify URL,
// creating a Drive library). Both sides stamp their edits — the OS connections_updated_at, FRIDAY
// Project.connectionsUpdatedAt (repo.updateProject) — and each sync copies the newer side over the
// older one. Runs after the projects mirror (projectsBridge.syncProjects), so the local→OS project
// map includes projects that mirror just created. TTL-gated, single-flight, never throws.

import { store, logEvent } from "@/lib/persistence/store";
import { osClient, osEnabled } from "@/lib/friday/osClient";
import { projectRepos, type Project } from "@/lib/friday/types";

/** The connection columns of an OS projects row (projects_get returns `*`). */
export interface OsConnections {
  repo_urls?: string[] | null;
  supabase_project_ref?: string | null;
  netlify_site_url?: string | null;
  files_provider?: "google" | "microsoft" | null;
  files_drive_id?: string | null;
  files_folder_id?: string | null;
  files_folder_name?: string | null;
  files_folder_url?: string | null;
  connections_updated_at?: string | null;
}

type LocalConnections = Pick<Project,
  "repoUrl" | "repoUrls" | "supabaseRef" | "deployUrl" | "driveFolderId"
  | "filesProvider" | "filesDriveId" | "filesFolderId" | "filesFolderName" | "filesFolderUrl">;

const GITHUB = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/*$/i;

/** https://github.com/<owner>/<repo> (no .git / trailing slash), or null for anything else. */
export function canonicalRepo(url: string): string | null {
  const m = url.trim().match(GITHUB);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

function siteUrl(u: string | undefined): string | null {
  const s = u?.trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s.replace(/\/+$/, "") : `https://${s.replace(/\/+$/, "")}`;
}

/** Local project → the OS projects_update fields. Pure. */
export function localToOs(p: Project): Required<Omit<OsConnections, "connections_updated_at" | "repo_urls">> & { repo_urls: string[] } {
  const repos = [...new Set(projectRepos(p).map(canonicalRepo).filter((r): r is string => Boolean(r)))];
  const ms = p.filesProvider === "microsoft" && p.filesFolderId;
  const google = !ms && (p.driveFolderId || (p.filesProvider === "google" ? p.filesFolderId : undefined));
  return {
    repo_urls: repos,
    supabase_project_ref: p.supabaseRef && /^[a-z]{20}$/.test(p.supabaseRef) ? p.supabaseRef : null,
    netlify_site_url: siteUrl(p.deployUrl),
    files_provider: ms ? "microsoft" : google ? "google" : null,
    files_drive_id: ms || google ? p.filesDriveId ?? null : null,
    files_folder_id: ms ? p.filesFolderId! : google || null,
    files_folder_name: ms || google ? p.filesFolderName ?? null : null,
    files_folder_url: ms ? p.filesFolderUrl ?? null : google ? p.filesFolderUrl ?? `https://drive.google.com/drive/folders/${google}` : null,
  };
}

/** OS row → the local Project fields. Pure. */
export function osToLocal(row: OsConnections): LocalConnections {
  const repos = (row.repo_urls ?? []).filter(Boolean);
  const provider = row.files_provider && row.files_folder_id ? row.files_provider : undefined;
  return {
    repoUrls: repos.length ? repos : undefined,
    repoUrl: repos[0],
    supabaseRef: row.supabase_project_ref ?? undefined,
    deployUrl: row.netlify_site_url ?? undefined,
    driveFolderId: provider === "google" ? row.files_folder_id! : undefined,
    filesProvider: provider,
    filesDriveId: provider ? row.files_drive_id ?? undefined : undefined,
    filesFolderId: provider ? row.files_folder_id! : undefined,
    filesFolderName: provider ? row.files_folder_name ?? undefined : undefined,
    filesFolderUrl: provider ? row.files_folder_url ?? undefined : undefined,
  };
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/** Which way to copy: the newer stamp wins; neither stamped ⇒ seed the OS if FRIDAY has anything. Pure. */
export function syncDirection(local: Project, os: OsConnections): "pull" | "push" | "none" {
  const l = ms(local.connectionsUpdatedAt);
  const o = ms(os.connections_updated_at);
  if (o > l) return "pull";
  if (l > o) return "push";
  if (!l && !o) {
    const c = localToOs(local);
    return c.repo_urls.length || c.supabase_project_ref || c.netlify_site_url || c.files_folder_id ? "push" : "none";
  }
  return "none";
}

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object)) as { text?: unknown } | undefined;
    if (first && typeof first.text === "string") {
      try { return JSON.parse(first.text); } catch { return first.text; }
    }
  }
  return content;
}

function rows<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") for (const val of Object.values(v)) if (Array.isArray(val)) return val as T[];
  return [];
}

const TTL_MS = 5 * 60_000;
let lastAt = 0;
let inflight: Promise<void> | null = null;

export function syncConnections(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && Date.now() - lastAt < TTL_MS) return Promise.resolve();
  inflight = run().catch((e) => logEvent("connections.sync.failed", { error: String(e) }, { level: "warn" }).catch(() => {}))
    .finally(() => { lastAt = Date.now(); inflight = null; });
  return inflight;
}

async function run(): Promise<void> {
  if (!osEnabled()) return;
  const meta = rows<{ local_project_id?: string; project_id?: string }>(
    unwrap(await osClient.callTool("project_agent_meta_get", { agent: "friday" })),
  );
  const osIdByLocal = new Map(meta.filter((m) => m.local_project_id && m.project_id).map((m) => [m.local_project_id!, m.project_id!]));
  let pulled = 0, pushed = 0;
  for (const p of await store.projects.all()) {
    const osId = osIdByLocal.get(p.id);
    if (!osId) continue;
    try {
      const os = unwrap(await osClient.callTool("projects_get", { id: osId })) as OsConnections | null;
      if (!os || typeof os !== "object") continue;
      const dir = syncDirection(p, os);
      if (dir === "pull") {
        const next = osToLocal(os);
        // A different site invalidates the cached Netlify site id.
        const siteChanged = (next.deployUrl ?? "") !== (p.deployUrl ?? "");
        await store.projects.update(p.id, {
          ...next,
          ...(siteChanged ? { netlifySiteId: undefined } : {}),
          connectionsUpdatedAt: os.connections_updated_at!,
        });
        pulled++;
      } else if (dir === "push") {
        const stamp = p.connectionsUpdatedAt ?? new Date().toISOString();
        await osClient.callTool("projects_update", { id: osId, ...localToOs(p), connections_updated_at: stamp });
        if (!p.connectionsUpdatedAt) await store.projects.update(p.id, { connectionsUpdatedAt: stamp });
        pushed++;
      }
    } catch (e) {
      await logEvent("connections.sync.project_failed", { project: p.name, error: String(e) }, { level: "warn" }).catch(() => {});
    }
  }
  if (pulled || pushed) await logEvent("connections.sync", { pulled, pushed }).catch(() => {});
}
