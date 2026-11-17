import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { streamFile } from "@/lib/streamFile";
import path from "node:path";
import { withinDocs } from "@/lib/friday/docs/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv",
};
function mimeFor(p: string): string { return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream"; }

// Stream a stored client document by absolute path, jailed to DOCS_ROOT (withinDocs — the jail is
// the whole security story here: clients.json lives one directory up). Range-aware so PDFs open
// inline. Mirrors the artifact route's shape.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get("path");
  if (!p) return new Response("missing path", { status: 400 });
  const abs = path.resolve(p);
  if (!withinDocs(abs)) return new Response("forbidden", { status: 403 });
  if (!existsSync(abs)) return new Response("not found", { status: 404 });

  const s = await stat(abs);
  const total = s.size;
  const mime = mimeFor(abs);
  return streamFile(req, abs, { mime, size: total });
}
