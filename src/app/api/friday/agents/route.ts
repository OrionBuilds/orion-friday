import { NextResponse } from "next/server";
import { store } from "@/lib/persistence/store";
import { seedAgents } from "@/lib/friday/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await seedAgents(); // ensure builtin team exists
  return NextResponse.json({ agents: await store.agents.all() });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const agent = await store.agents.update(id, body.patch ?? {});
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ agent });
}
