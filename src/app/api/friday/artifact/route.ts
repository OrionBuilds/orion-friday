import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { streamFile } from "@/lib/streamFile";
import path from "node:path";
import { withinArtifacts } from "@/lib/friday/artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".json": "application/json", ".csv": "text/csv",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".html": "text/html", ".htm": "text/html",
};
function mimeFor(p: string): string { return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream"; }

// Stream a stored artifact by absolute path, jailed to the FRIDAY artifacts dir. Range-aware
// (so PDFs open inline in the browser).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get("path");
  if (!p) return new Response("missing path", { status: 400 });
  const abs = path.resolve(p);
  if (!withinArtifacts(abs)) return new Response("forbidden", { status: 403 });
  if (!existsSync(abs)) return new Response("not found", { status: 404 });

  const s = await stat(abs);
  const total = s.size;
  const mime = mimeFor(abs);
  return streamFile(req, abs, { mime, size: total });
}
