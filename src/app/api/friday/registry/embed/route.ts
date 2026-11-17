import { NextResponse } from "next/server";
import { buildSkillIndex, hasIndex } from "@/lib/friday/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET → whether a semantic index exists.  POST → (re)build it via LM Studio embeddings.
export async function GET() {
  return NextResponse.json({ indexed: await hasIndex() });
}
export async function POST() {
  try {
    const r = await buildSkillIndex();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }
}
