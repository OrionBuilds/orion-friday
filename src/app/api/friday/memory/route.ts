import { NextResponse } from "next/server";
import { recallMemory, reindexMemory, listClientMemory } from "@/lib/friday/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET ?q=…&clientId=…&projectId=…  → scoped semantic recall (debug/inspection).
// GET ?clientId=…  (no q)          → list what FRIDAY remembers about that client (recency-sorted).
// POST                              → backfill/reindex the memory index from messages + runs.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const clientId = url.searchParams.get("clientId") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 8);
  if (!q.trim()) {
    if (!clientId) return NextResponse.json({ error: "pass ?q= or ?clientId=" }, { status: 400 });
    return NextResponse.json({ clientId, hits: await listClientMemory(clientId, limit) });
  }
  const hits = await recallMemory(q, { clientId, projectId: url.searchParams.get("projectId") ?? undefined, limit });
  return NextResponse.json({ q, hits });
}

export async function POST() {
  try {
    const r = await reindexMemory();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }
}
