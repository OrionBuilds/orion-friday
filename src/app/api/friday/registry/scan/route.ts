import { NextResponse } from "next/server";
import { scanSources } from "@/lib/friday/registry";
import { seedAgents } from "@/lib/friday/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Import / refresh: scan all configured sources into the registry.
export async function POST() {
  await seedAgents(); // keep builtins present alongside imports
  const result = await scanSources();
  return NextResponse.json(result);
}
