import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { store, newId, logEvent } from "@/lib/persistence/store";
import { createDoc, listDocsForClient } from "@/lib/friday/repo";
import { docFilePath } from "@/lib/friday/docs/storage";
import { extractText, kindFromFilename, DOC_MIME, MAX_UPLOAD_BYTES, EXTRACT_CAP } from "@/lib/friday/docs/extract";
import { normalizeCategory } from "@/lib/friday/docs/brief";
import { sanitizeFilename } from "@/lib/friday/inboundAttachments";
import { enrichDoc } from "@/lib/friday/docs/process";
import type { ClientDoc } from "@/lib/friday/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Owner-uploaded client context documents (proposals, plans, strategy docs). Works for EVERY client
// status — past clients carry the most valuable historical materials. Multipart upload; extraction
// is synchronous (fast), enrichment (Drive mirror + memory chunks + brief) runs detached.

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json({ docs: await listDocsForClient(id) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const client = await store.clients.get(id);
  if (!client) return NextResponse.json({ error: "client not found" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "multipart/form-data required" }, { status: 400 });
  const files = [...form.getAll("files"), ...form.getAll("file")].filter((f): f is File => f instanceof File);
  if (!files.length) return NextResponse.json({ error: "no files" }, { status: 400 });
  const category = normalizeCategory(form.get("category"));

  const created: ClientDoc[] = [];
  const rejected: Array<{ filename: string; reason: string }> = [];
  for (const f of files) {
    const filename = sanitizeFilename(f.name);
    const kind = kindFromFilename(filename);
    if (!kind) { rejected.push({ filename, reason: "unsupported type (pdf/docx/txt/md/csv only)" }); continue; }
    if (f.size <= 0 || f.size > MAX_UPLOAD_BYTES) { rejected.push({ filename, reason: `over the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit` }); continue; }

    const bytes = Buffer.from(await f.arrayBuffer());
    const docId = newId();
    const filePath = docFilePath(id, docId, kind);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bytes);

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
    const doc = await createDoc({
      id: docId, clientId: id, filename, kind, mime: DOC_MIME[kind], sizeBytes: bytes.length,
      path: filePath, category,
      extractedText: text.slice(0, EXTRACT_CAP), extractedChars: fullChars,
      source: "upload", status, error,
    });
    created.push(doc);
    void enrichDoc(doc.id).catch(() => {});
  }

  if (!created.length && rejected.length) {
    return NextResponse.json({ error: rejected.map((r) => `${r.filename}: ${r.reason}`).join("; ") }, { status: 400 });
  }
  await logEvent("doc.uploaded", { clientId: id, count: created.length, rejected: rejected.length });
  return NextResponse.json({ docs: created, rejected }, { status: 201 });
}
