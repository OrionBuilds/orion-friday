import { NextResponse } from "next/server";
import { googleConfigured } from "@/lib/friday/google/auth";
import { searchContacts } from "@/lib/friday/google/people";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?q=…  → { hits } from Google Contacts + Other Contacts, for new-client autofill.
// Returns 200 with an empty list + reason when Google isn't connected, so the form
// degrades to plain typing instead of erroring.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (!googleConfigured()) {
    return NextResponse.json({ hits: [], connected: false });
  }
  try {
    const hits = await searchContacts(q);
    return NextResponse.json({ hits, connected: true });
  } catch (e) {
    // Most likely: People API not enabled, or the saved token predates the new scopes.
    return NextResponse.json({ hits: [], connected: true, error: String(e) });
  }
}
