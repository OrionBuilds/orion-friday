import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { streamFile } from "@/lib/streamFile";
import { isAllowedMediaPath, mimeForFile } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serves generated media files (images / videos / audio) so the browser can preview them.
// Supports HTTP Range requests so the <video> element can seek without re-downloading.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get("path");
  if (!p) return new Response("missing path", { status: 400 });
  if (!isAllowedMediaPath(p)) return new Response("forbidden", { status: 403 });
  if (!existsSync(p)) return new Response("not found", { status: 404 });

  const s = await stat(p);
  const total = s.size;
  const mime = mimeForFile(p);
  return streamFile(req, p, { mime, size: total });
}

// HEAD lets the frontend check "does this stored history file still exist?" without downloading it.
export async function HEAD(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get("path");
  if (!p) return new Response(null, { status: 400 });
  if (!isAllowedMediaPath(p)) return new Response(null, { status: 403 });
  if (!existsSync(p)) return new Response(null, { status: 404 });
  try {
    const s = await stat(p);
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": mimeForFile(p),
        "Content-Length": String(s.size),
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
