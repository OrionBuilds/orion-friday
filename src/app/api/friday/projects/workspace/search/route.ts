import { NextResponse } from "next/server";
import { searchGithubRepos, searchNetlifySites, searchSupabaseProjects } from "@/lib/friday/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?provider=github|netlify|supabase&q=…  → existing resources matching the query.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");
  const q = url.searchParams.get("q") ?? "";
  try {
    const hits =
      provider === "github" ? await searchGithubRepos(q)
      : provider === "netlify" ? await searchNetlifySites(q)
      : provider === "supabase" ? await searchSupabaseProjects(q)
      : [];
    return NextResponse.json({ hits });
  } catch (e) {
    return NextResponse.json({ hits: [], error: String(e) });
  }
}
