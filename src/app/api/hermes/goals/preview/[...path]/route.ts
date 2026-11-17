import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { streamFile } from "@/lib/streamFile";
import path from "node:path";
import { getGoal } from "@/lib/hermesGoals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/hermes/goals/preview/<goal-id>/<...rel>
// Securely serves a file from a goal's cwd. Resolves rel against goal.cwd,
// verifies the resolved path is still inside goal.cwd (containment check),
// streams the file with the right MIME type. Same pattern as the Hermes /
// OpenClaw Workspace preview routes.

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
function mimeFor(p: string): string { return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream"; }

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await ctx.params;
  if (!Array.isArray(segments) || segments.length < 2) {
    return new Response("path must be /<goalId>/<...rel>", { status: 400 });
  }
  const [goalId, ...restSegs] = segments;
  if (!/^[A-Za-z0-9_.-]+$/.test(goalId)) {
    return new Response("invalid goal id", { status: 400 });
  }
  const goal = await getGoal(goalId);
  if (!goal) return new Response("goal not found", { status: 404 });
  const rel = restSegs.join("/");
  if (!rel) return new Response("file path required", { status: 400 });
  if (!existsSync(goal.cwd)) return new Response("cwd missing", { status: 404 });

  // Containment check — abs must be inside goal.cwd
  const abs = path.resolve(goal.cwd, rel);
  if (abs !== goal.cwd && !abs.startsWith(goal.cwd + path.sep)) {
    return new Response("path escapes cwd", { status: 403 });
  }
  if (!existsSync(abs)) return new Response("not found", { status: 404 });

  const s = await stat(abs);
  if (!s.isFile()) return new Response("not a file", { status: 400 });
  const total = s.size;
  const mime = mimeFor(abs);
  return streamFile(req, abs, { mime, size: total });
}
