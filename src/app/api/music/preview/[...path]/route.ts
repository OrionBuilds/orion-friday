import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { streamFile } from "@/lib/streamFile";
import path from "node:path";
import { resolveMusicFile } from "@/lib/musicStudio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serves audio + cover art from the music history dir, with HTTP range support
// so the <audio> player can seek/scrub. URL: /api/music/preview/<file>
const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
};
function mimeFor(p: string): string { return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream"; }

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await ctx.params;
  if (!Array.isArray(segments) || segments.length === 0) return new Response("file path required", { status: 400 });

  const rel = segments.map((s) => decodeURIComponent(s)).join("/");
  const abs = resolveMusicFile(rel);
  if (!abs || !existsSync(abs)) return new Response("not found", { status: 404 });

  const s = await stat(abs);
  if (!s.isFile()) return new Response("not a file", { status: 400 });
  const total = s.size;
  const mime = mimeFor(abs);
  return streamFile(req, abs, { mime, size: total });
}
