// FRIDAY client documents — post-upload enrichment pipeline.
//
// Order is deliberate (a proven sequence, independent code): (1) Drive mirror FIRST so the
// raw file is durable before any slow/flaky step, (2) chunk + index into institutional memory
// (local LM Studio — fast), (3) LLM brief distillation (slow), then (4) index the brief + mirror the
// brief sidecar. Every step best-effort: a Drive outage or a dead engine leaves the doc usable from
// its extracted text, and reprocess (route) re-runs everything idempotently.

import { store, logEvent } from "@/lib/persistence/store";
import { removeMemory, indexMemoryBatch, type MemoryItem } from "@/lib/friday/memory";
import { chunkText } from "@/lib/friday/docs/chunk";
import { generateDocBrief } from "@/lib/friday/docs/brief";
import type { Client, ClientDoc } from "@/lib/friday/types";

// The client-level Drive folder for uploaded docs: <client folder>/Documents.
async function ensureClientDocsFolderId(client: Client): Promise<string | null> {
  try {
    const { ensureClientLibrary, FRIDAY_DRIVE_ID } = await import("@/lib/friday/google/library");
    const clientFolderId = await ensureClientLibrary(client);
    if (!clientFolderId) return null;
    const { ensureFolder } = await import("@/lib/friday/google/drive");
    const folder = await ensureFolder("Documents", clientFolderId, FRIDAY_DRIVE_ID);
    return folder?.id ?? null;
  } catch {
    return null;
  }
}

// Mirror the raw file to Drive (idempotent — skips when driveFileId already set, e.g. drive_pull rows).
async function uploadDocFileToDrive(client: Client, doc: ClientDoc): Promise<ClientDoc> {
  if (doc.driveFileId) return doc;
  try {
    const folderId = await ensureClientDocsFolderId(client);
    if (!folderId) return doc;
    const { promises: fs } = await import("node:fs");
    const bytes = await fs.readFile(doc.path).catch(() => null);
    if (!bytes) return doc;
    const { uploadBinaryFile } = await import("@/lib/friday/google/drive");
    const file = await uploadBinaryFile(doc.filename, bytes, folderId, doc.mime);
    if (!file?.id) return doc;
    const { updateDoc } = await import("@/lib/friday/repo");
    return (await updateDoc(doc.id, { driveFileId: file.id, driveUrl: file.webViewLink })) ?? doc;
  } catch {
    return doc;
  }
}

/**
 * (Re-)index a doc into institutional memory: wipe its old chunks, then chunk + batch-embed the
 * extracted text (ids `doc:<id>#<n>`) and the brief (`doc:<id>#brief`). clientId-scoped only — the
 * reply brains recall by clientId; agent runs get the deterministic block instead (context.ts).
 */
export async function indexDocMemory(doc: ClientDoc): Promise<number> {
  // Bail if the record vanished (deleted mid-enrichment) — never index chunks for a ghost doc.
  const { getDoc } = await import("@/lib/friday/repo");
  if (!(await getDoc(doc.id))) return 0;
  await removeMemory(`doc:${doc.id}#`);
  const prefix = `[${doc.filename} · ${doc.category}] `;
  const items: MemoryItem[] = chunkText(doc.extractedText).map((chunk, n) => ({
    id: `doc:${doc.id}#${n}`,
    kind: "doc" as const,
    text: `${prefix}${chunk}`,
    clientId: doc.clientId,
    ts: doc.updatedAt,
    ref: doc.filename,
  }));
  if (doc.brief?.trim()) {
    items.push({ id: `doc:${doc.id}#brief`, kind: "doc", text: `${prefix}${doc.brief.trim()}`, clientId: doc.clientId, ts: doc.updatedAt, ref: doc.filename });
  }
  return indexMemoryBatch(items);
}

/** Full enrichment for one doc. Safe to re-run (reprocess); never throws. */
export async function enrichDoc(docId: string): Promise<void> {
  try {
    const { getDoc, updateDoc } = await import("@/lib/friday/repo");
    let doc = await getDoc(docId);
    if (!doc) return;
    const client = await store.clients.get(doc.clientId);
    if (!client) return;

    // 1 — Drive mirror first: durability before slow steps.
    doc = await uploadDocFileToDrive(client, doc);

    // 2 — memory chunks from the extracted text (brief may not exist yet).
    if (doc.status === "ready" && doc.extractedText.trim()) {
      await indexDocMemory(doc).catch(() => {});
    }

    // 3 — brief distillation (slow, best-effort).
    if (doc.status === "ready" && doc.extractedText.trim() && !doc.brief?.trim()) {
      const brief = await generateDocBrief(client, doc, doc.extractedText);
      if (brief) {
        doc = (await updateDoc(doc.id, { brief })) ?? doc;
        // 4 — re-index (now includes #brief) + mirror the brief sidecar.
        await indexDocMemory(doc).catch(() => {});
        try {
          const folderId = await ensureClientDocsFolderId(client);
          if (folderId) {
            const { uploadTextFile } = await import("@/lib/friday/google/drive");
            const base = doc.filename.replace(/\.[a-z0-9]+$/i, "");
            const sidecar = await uploadTextFile(`${base} — brief.md`, brief, folderId, "text/markdown");
            if (sidecar?.id) await updateDoc(doc.id, { driveBriefFileId: sidecar.id });
          }
        } catch { /* sidecar is a nicety */ }
      }
    }
    await logEvent("doc.enriched", { docId: doc.id, client: client.name, category: doc.category, brief: Boolean(doc.brief) });
  } catch (e) {
    await logEvent("doc.enrich_error", { docId, error: String(e).slice(0, 160) }, { level: "warn" }).catch(() => {});
  } finally {
    // Delete-vs-detached-enrich race (live proof found it): a doc deleted WHILE this pipeline runs
    // can get chunks indexed after deleteDoc's cleanup. Terminal sweep: record gone ⇒ chunks gone.
    try {
      const { getDoc } = await import("@/lib/friday/repo");
      if (!(await getDoc(docId))) await removeMemory(`doc:${docId}#`);
    } catch { /* best-effort */ }
  }
}
