import { NextResponse } from "next/server";
import { store } from "@/lib/persistence/store";
import { readBody } from "@/lib/friday/registry";
import { allowedForBench } from "@/lib/friday/bench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?id=        → a single skill + its (lazy-loaded) body
// GET ?q=&source=&kind=&limit=&offset= → searchable/paginated skill index
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const skill = await store.skills.get(id);
    if (!skill) return NextResponse.json({ error: "not found" }, { status: 404 });
    const body = await readBody(skill);
    return NextResponse.json({ skill, body });
  }

  const q = (url.searchParams.get("q") ?? "").toLowerCase().trim();
  const source = url.searchParams.get("source") ?? "";
  const kind = url.searchParams.get("kind") ?? "";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  // Bench-scoped by default (marketing skills live on the marketing bench). ?all=1 shows the unfiltered index.
  const all = url.searchParams.get("all") === "1";
  let skills = (await store.skills.all()).filter((s) => all || allowedForBench(s));
  if (source) skills = skills.filter((s) => s.sourceId === source);
  if (kind) skills = skills.filter((s) => s.kind === kind);
  if (q) skills = skills.filter((s) => (`${s.name} ${s.description ?? ""}`).toLowerCase().includes(q));

  const total = skills.length;
  const page = skills
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(offset, offset + limit)
    // strip body from list payload
    .map(({ body, frontmatter, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars

  return NextResponse.json({ total, limit, offset, skills: page });
}

// PATCH { id, patch } → toggle active, etc.
export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const skill = await store.skills.update(id, body.patch ?? {});
  if (!skill) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ skill });
}
