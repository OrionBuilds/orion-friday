import { NextResponse } from "next/server";
import { listFiles, ensureClientFolder, ensureFolder } from "@/lib/friday/google/drive";
import { googleConfigured } from "@/lib/friday/google/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notConnected = () => NextResponse.json({ error: "Google not connected" }, { status: 400 });

// GET ?q=…  → search files.  POST { action:"ensureClientFolder", clientName } | { action:"ensureFolder", name, parentId }
export async function GET(req: Request) {
  if (!googleConfigured()) return notConnected();
  const q = new URL(req.url).searchParams.get("q") ?? "trashed = false";
  return NextResponse.json({ files: await listFiles(q, 25) });
}

export async function POST(req: Request) {
  if (!googleConfigured()) return notConnected();
  const b = await req.json().catch(() => ({}));
  if (b.action === "ensureClientFolder" && b.clientName) {
    const folder = await ensureClientFolder(String(b.clientName));
    return NextResponse.json({ folder });
  }
  if (b.action === "ensureFolder" && b.name) {
    const folder = await ensureFolder(String(b.name), b.parentId);
    return NextResponse.json({ folder });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
