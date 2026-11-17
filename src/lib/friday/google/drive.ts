// Google Drive — per-client/project folders + file management.
// Shared-Drive aware: all mutating/list calls pass supportsAllDrives; list calls scoped to a shared
// drive add includeItemsFromAllDrives + corpora=drive + driveId so folders inside the FRIDAY shared
// drive are actually found (and not re-created) and files land in the right place.
import { gfetch } from "./auth";
import { AGENCY } from "@/lib/friday/persona";

const BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface DriveFile { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string; }

// List files matching a query. When `driveId` is set the search is scoped INTO that shared drive
// (corpora=drive), which is required to see items that live in a Shared Drive.
export async function listFiles(query: string, max = 25, driveId?: string): Promise<DriveFile[]> {
  const p = new URLSearchParams({ q: query, fields: "files(id,name,mimeType,modifiedTime,webViewLink)", pageSize: String(max), orderBy: "modifiedTime desc", supportsAllDrives: "true" });
  if (driveId) { p.set("includeItemsFromAllDrives", "true"); p.set("corpora", "drive"); p.set("driveId", driveId); }
  const r = await gfetch(`${BASE}/files?${p.toString()}`);
  if (!r.ok) return [];
  return (await r.json()).files ?? [];
}

export async function findFolder(name: string, parentId?: string, driveId?: string): Promise<DriveFile | null> {
  const q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false` + (parentId ? ` and '${parentId}' in parents` : "");
  return (await listFiles(q, 1, driveId))[0] ?? null;
}

export async function createFolder(name: string, parentId?: string): Promise<DriveFile | null> {
  const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
  if (parentId) body.parents = [parentId];
  const r = await gfetch(`${BASE}/files?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) return null;
  return r.json();
}

// Ensure a folder exists (find or create) — used for per-client / per-project folders. Pass `driveId`
// when the parent lives in a shared drive so the find step searches the right corpus.
export async function ensureFolder(name: string, parentId?: string, driveId?: string): Promise<DriveFile | null> {
  return (await findFolder(name, parentId, driveId)) ?? (await createFolder(name, parentId));
}

// List a folder's direct children (non-trashed). Shared-drive aware via `driveId`.
export async function listFolderFiles(folderId: string, driveId?: string, max = 100): Promise<DriveFile[]> {
  return listFiles(`'${folderId}' in parents and trashed = false`, max, driveId);
}

// Raw bytes of a binary file (alt=media). Null on failure.
export async function downloadFileBytes(fileId: string): Promise<Buffer | null> {
  try {
    const r = await gfetch(`${BASE}/files/${fileId}?alt=media&supportsAllDrives=true`);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

// Export a Google-native file (Doc/Sheet/Slides) to a concrete mime. Null on failure.
export async function exportFileBytes(fileId: string, mime: string): Promise<Buffer | null> {
  try {
    const r = await gfetch(`${BASE}/files/${fileId}/export?mimeType=${encodeURIComponent(mime)}`);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

// Move a file to the Drive trash (soft delete — recoverable from the Drive UI).
export async function trashFile(fileId: string): Promise<boolean> {
  try {
    const r = await gfetch(`${BASE}/files/${fileId}?supportsAllDrives=true`, { method: "PATCH", body: JSON.stringify({ trashed: true }) });
    return r.ok;
  } catch {
    return false;
  }
}

// Ensure the "FRIDAY — <client>" folder tree exists and return the client folder.
// LEGACY: builds under My Drive. New client/project libraries use google/library.ts (shared drive).
export async function ensureClientFolder(clientName: string): Promise<DriveFile | null> {
  const root = await ensureFolder(`${AGENCY} — Clients`);
  if (!root) return null;
  return ensureFolder(clientName, root.id);
}

export async function uploadTextFile(name: string, content: string, parentId?: string, mime = "text/plain"): Promise<DriveFile | null> {
  const boundary = "friday" + Date.now();
  const meta = JSON.stringify({ name, ...(parentId ? { parents: [parentId] } : {}) });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n--${boundary}--`;
  const r = await gfetch(`${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`, {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  if (!r.ok) return null;
  return r.json();
}

// Upload BINARY content (e.g. a PDF Buffer) via a multipart/related request. The binary part is
// base64-encoded with Content-Transfer-Encoding: base64 so arbitrary bytes survive the text boundary.
// Shared-drive aware. Returns the created DriveFile (with webViewLink) or null on failure.
export async function uploadBinaryFile(name: string, bytes: Buffer, parentId: string | undefined, mime: string): Promise<DriveFile | null> {
  const boundary = "fridaybin" + Date.now();
  const meta = JSON.stringify({ name, ...(parentId ? { parents: [parentId] } : {}) });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`, "utf8"),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mime}\r\nContent-Transfer-Encoding: base64\r\n\r\n`, "utf8"),
    Buffer.from(bytes.toString("base64"), "utf8"),
    Buffer.from(`\r\n--${boundary}--`, "utf8"),
  ]);
  const r = await gfetch(`${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`, {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  if (!r.ok) return null;
  return r.json();
}

// Move a file into a folder (add a parent, drop the old ones). Shared-drive aware — used to file a
// freshly-created Google Doc into its project's "Proposals & SOWs" folder.
export async function moveFile(fileId: string, newParentId: string): Promise<boolean> {
  const cur = await gfetch(`${BASE}/files/${fileId}?fields=parents&supportsAllDrives=true`);
  const prev = cur.ok ? ((await cur.json()).parents ?? []).join(",") : "";
  const p = new URLSearchParams({ addParents: newParentId, supportsAllDrives: "true", fields: "id,parents" });
  if (prev) p.set("removeParents", prev);
  const r = await gfetch(`${BASE}/files/${fileId}?${p.toString()}`, { method: "PATCH", body: JSON.stringify({}) });
  return r.ok;
}

// Read a Drive file's text (plain files or export Google Docs to text).
export async function readFileText(fileId: string, mimeType?: string): Promise<string> {
  if (mimeType && mimeType.startsWith("application/vnd.google-apps")) {
    const r = await gfetch(`${BASE}/files/${fileId}/export?mimeType=text/plain`);
    return r.ok ? r.text() : "";
  }
  const r = await gfetch(`${BASE}/files/${fileId}?alt=media&supportsAllDrives=true`);
  return r.ok ? r.text() : "";
}

// ── Native-format uploads (2026-09-24: every report is a Google Drive document) ──────────────
// Builds the multipart request with the shared agent-core helper (markdown/html → Google Doc,
// csv → Sheet, pdf/file as-is) and sends it through this app's authenticated fetch.
import { buildDriveMultipart, parseDriveFile, type DriveTarget } from "@autom8ionlab/agent-core";
import type { GoogleAccount } from "./auth";

export async function createDriveFile(input: {
  name: string;
  parents?: string[];
  target: DriveTarget;
  sourceMime: string;
  bytes: Buffer;
  account?: GoogleAccount;
}): Promise<DriveFile | null> {
  try {
    const req = buildDriveMultipart({ name: input.name, parents: input.parents, target: input.target, sourceMime: input.sourceMime, bytes: input.bytes });
    const r = await gfetch(req.url, { method: "POST", headers: req.headers, body: new Uint8Array(req.body) }, input.account ?? "owner");
    if (!r.ok) return null;
    const f = parseDriveFile(await r.json().catch(() => null));
    return f ? { id: f.id, name: f.name, mimeType: f.mimeType, webViewLink: f.webViewLink } : null;
  } catch {
    return null;
  }
}
