import { NextResponse } from "next/server";
import { ingestMeetings } from "@/lib/friday/ingest";
import { googleConfigured } from "@/lib/friday/google/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Pull recent client meetings (transcripts/notes from Drive) → summaries + extracted tasks.
export async function POST(req: Request) {
  if (!googleConfigured()) return NextResponse.json({ error: "Google not connected" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const days = Math.min(Number(body.days ?? 7), 60);
  const result = await ingestMeetings(days);
  return NextResponse.json(result);
}
