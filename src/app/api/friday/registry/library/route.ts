import { NextResponse } from "next/server";
import { store } from "@/lib/persistence/store";
import { readBody } from "@/lib/friday/registry";
import { allowedForBench } from "@/lib/friday/bench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Imported ("library") agents — everything not builtin.
// GET ?id= → agent + lazy body   ·   GET ?q=&source= → searchable index
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const agent = await store.agents.get(id);
    if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
    const body = agent.systemPrompt || (await readBody(agent));
    return NextResponse.json({ agent, body });
  }

  const q = (url.searchParams.get("q") ?? "").toLowerCase().trim();
  const source = url.searchParams.get("source") ?? "";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 300);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  // Bench-scoped: FRIDAY's library browse shows only this bench's + shared agents (marketing lives on
  // the marketing bench). Pass ?all=1 to see the unfiltered library.
  const all = url.searchParams.get("all") === "1";
  let agents = (await store.agents.all()).filter((a) => a.source !== "builtin" && (all || allowedForBench(a)));
  if (source) agents = agents.filter((a) => a.sourceId === source);
  if (q) agents = agents.filter((a) => (`${a.name} ${a.description ?? ""} ${a.type ?? ""}`).toLowerCase().includes(q));

  const total = agents.length;
  const page = agents.sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit);
  return NextResponse.json({ total, limit, offset, agents: page });
}
