import { NextResponse } from "next/server";
import { getTodayDream, generateDream } from "@/lib/friday/dream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

// GET → today's brief (cached, generates if missing).  POST → force-regenerate.
export async function GET() {
  return NextResponse.json({ dream: await getTodayDream() });
}
export async function POST() {
  return NextResponse.json({ dream: await generateDream(true) });
}
