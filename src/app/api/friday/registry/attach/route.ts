import { NextResponse } from "next/server";
import { store } from "@/lib/persistence/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pin / unpin a skill to an agent. POST { agentId, skillId, on }
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const agentId = String(body.agentId ?? "");
  const skillId = String(body.skillId ?? "");
  const on = body.on !== false; // default pin
  if (!agentId || !skillId) return NextResponse.json({ error: "agentId and skillId required" }, { status: 400 });

  const agent = await store.agents.get(agentId);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const set = new Set(agent.skills ?? []);
  if (on) set.add(skillId); else set.delete(skillId);
  const updated = await store.agents.update(agentId, { skills: [...set] });
  return NextResponse.json({ agent: updated });
}
