// FRIDAY → a project's SharePoint/OneDrive folder. When a project's files folder is Microsoft (picked
// in the OS: Project.filesProvider/filesDriveId/filesFolderId, synced by connectionsSync), run reports
// can't go through FRIDAY's own Google Drive library. They go through the OS `project-files` edge
// function instead, which uploads with Clara's Microsoft account and only into a folder
// that is some project's chosen Microsoft folder.

import { osAuth, osEnabled } from "@/lib/friday/osClient";
import type { Project } from "@/lib/friday/types";

// Characters SharePoint/OneDrive refuse in a name; leading/trailing dots and spaces are refused too.
const INVALID = /["*:<>?/\\|]+/g;

/** A name SharePoint accepts: invalid characters → "-", whitespace collapsed, ≤ 200 chars. Pure. */
export function officeSafeName(name: string): string {
  const s = name.replace(INVALID, "-").replace(/\s+/g, " ").trim().slice(0, 200).replace(/^[.\s]+|[.\s]+$/g, "");
  return s || "file";
}

export function msFolderConfigured(p: Project | null | undefined): p is Project {
  return Boolean(p && p.filesProvider === "microsoft" && p.filesFolderId);
}

/** Upload into the project's Microsoft folder (optionally a `category` sub-folder). Throws on failure. */
export async function uploadToProjectFolder(
  project: Project,
  input: { category?: string; fileName: string; bytes: Buffer },
): Promise<{ id: string; url: string | null }> {
  if (!msFolderConfigured(project)) throw new Error("project has no Microsoft files folder");
  if (!osEnabled()) throw new Error("FRIDAY is not signed in to the OS");
  const jwt = await osAuth.getFreshOsJwt();
  const url = process.env.ORION_SUPABASE_URL?.trim();
  if (!url) throw new Error("ORION_SUPABASE_URL is not set");
  const base = url.replace(/\/+$/, "");
  const r = await fetch(`${base}/functions/v1/project-files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "upload",
      drive_id: project.filesDriveId ?? null,
      folder_id: project.filesFolderId,
      category: input.category,
      file_name: officeSafeName(input.fileName),
      content_base64: input.bytes.toString("base64"),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const j = (await r.json().catch(() => ({}))) as { id?: string; url?: string | null; error?: string };
  if (!r.ok || !j.id) throw new Error(j.error || `project-files returned ${r.status}`);
  return { id: j.id, url: j.url ?? null };
}
