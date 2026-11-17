// FRIDAY client documents — Drive pull sync (owner decision 2026-07-19: full two-way).
//
// The owner can drop files straight into a client's Drive "Documents" folder; this pulls them in exactly
// as if uploaded on the card. Google-native files export to a concrete kind first (Doc→txt,
// Sheet→csv, Slides→pdf — FRIDAY has no xlsx parser by design). Dedupe: a Drive file already pulled
// (matching driveFileId) is skipped unless its modifiedTime advanced, in which case it re-extracts
// and re-enriches in place. Files FRIDAY herself mirrored up (driveFileId on an "upload" row) are
// naturally skipped by the same match. Best-effort throughout; a sync never throws.

import { promises as fs } from "node:fs";
import path from "node:path";
import { store, newId, logEvent } from "@/lib/persistence/store";
import { docFilePath } from "@/lib/friday/docs/storage";
import { extractText, kindFromFilename, EXTRACT_CAP, MAX_UPLOAD_BYTES, DOC_MIME } from "@/lib/friday/docs/extract";
import type { Client, ClientDoc, DocKind } from "@/lib/friday/types";

// Google-native exports: mime → [export mime, resulting kind]. Everything else downloads as-is.
const NATIVE: Record<string, [string, DocKind]> = {
  "application/vnd.google-apps.document": ["text/plain", "txt"],
  "application/vnd.google-apps.spreadsheet": ["text/csv", "csv"],
  "application/vnd.google-apps.presentation": ["application/pdf", "pdf"],
};

export interface DocSyncResult { pulled: number; updated: number; skipped: number; note?: string }

export async function syncClientDocsFromDrive(client: Client): Promise<DocSyncResult> {
  const out: DocSyncResult = { pulled: 0, updated: 0, skipped: 0 };
  try {
    const { googleConfigured } = await import("@/lib/friday/google/auth");
    if (!googleConfigured()) return { ...out, note: "google not connected" };
    const { ensureClientLibrary, FRIDAY_DRIVE_ID } = await import("@/lib/friday/google/library");
    const clientFolderId = await ensureClientLibrary(client);
    if (!clientFolderId) return { ...out, note: "no client Drive folder" };
    const { ensureFolder, listFolderFiles, downloadFileBytes, exportFileBytes } = await import("@/lib/friday/google/drive");
    const folder = await ensureFolder("Documents", clientFolderId, FRIDAY_DRIVE_ID);
    if (!folder?.id) return { ...out, note: "no Documents folder" };

    const files = await listFolderFiles(folder.id, FRIDAY_DRIVE_ID);
    const existing = await store.docs.find((d) => d.clientId === client.id);
    const byDriveId = new Map(existing.map((d) => [d.driveFileId, d] as const));

    for (const f of files) {
      if (f.mimeType === "application/vnd.google-apps.folder") { out.skipped++; continue; }
      if (/ — brief\.md$/i.test(f.name)) { out.skipped++; continue; } // our own sidecars
      const known = byDriveId.get(f.id);
      if (known && (!f.modifiedTime || known.driveModifiedTime === f.modifiedTime || known.source === "upload")) {
        out.skipped++;
        continue;
      }

      const native = NATIVE[f.mimeType];
      const kind = native ? native[1] : kindFromFilename(f.name);
      if (!kind) { out.skipped++; continue; }
      const bytes = native ? await exportFileBytes(f.id, native[0]) : await downloadFileBytes(f.id);
      if (!bytes || bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) { out.skipped++; continue; }

      let text = "";
      let status: ClientDoc["status"] = "ready";
      let error: string | undefined;
      try {
        text = (await extractText(bytes, kind)).slice(0, EXTRACT_CAP + 1);
      } catch (e) {
        status = "failed";
        error = String(e).slice(0, 200);
      }
      const fullChars = text.length;
      text = text.slice(0, EXTRACT_CAP);

      const { createDoc, updateDoc } = await import("@/lib/friday/repo");
      const { enrichDoc } = await import("@/lib/friday/docs/process");
      if (known) {
        // Changed in Drive → refresh bytes + extraction in place, clear the stale brief, re-enrich.
        await fs.writeFile(known.path, bytes);
        await updateDoc(known.id, {
          filename: f.name, extractedText: text, extractedChars: fullChars,
          status, error, brief: undefined, driveModifiedTime: f.modifiedTime, sizeBytes: bytes.length,
        });
        out.updated++;
        void enrichDoc(known.id).catch(() => {});
        continue;
      }
      const docId = newId();
      const filePath = docFilePath(client.id, docId, kind);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, bytes);
      await createDoc({
        id: docId, clientId: client.id,
        filename: f.name, kind, mime: native ? DOC_MIME[kind] : f.mimeType, sizeBytes: bytes.length,
        path: filePath, category: "other",
        extractedText: text, extractedChars: fullChars,
        driveFileId: f.id, driveUrl: f.webViewLink, driveModifiedTime: f.modifiedTime,
        source: "drive_pull", status, error,
      });
      out.pulled++;
      void enrichDoc(docId).catch(() => {});
    }
    if (out.pulled || out.updated) {
      await logEvent("doc.drive_pull", { client: client.name, pulled: out.pulled, updated: out.updated });
    }
    return out;
  } catch (e) {
    return { ...out, note: `sync error: ${String(e).slice(0, 160)}` };
  }
}

/** Scheduler sweep: pull every client that has a Drive folder. Sequential — kind to rate limits. */
export async function syncAllClientDocs(): Promise<string> {
  const clients = await store.clients.all();
  let pulled = 0, updated = 0;
  for (const c of clients) {
    if (!c.driveFolderId) continue;
    const r = await syncClientDocsFromDrive(c);
    pulled += r.pulled;
    updated += r.updated;
  }
  return `${pulled} pulled, ${updated} updated`;
}
