import { NextResponse } from "next/server";
import { provisionAllLibraries, FRIDAY_DRIVE_ID } from "@/lib/friday/google/library";
import { store } from "@/lib/persistence/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET ?clientId=…  → that client's cached Drive folder link (if provisioned).
// GET (no params)  → the shared-drive id.
// POST             → backfill: provision the full library tree for every client + project.
export async function GET(req: Request) {
  const clientId = new URL(req.url).searchParams.get("clientId");
  if (clientId) {
    const c = await store.clients.get(clientId);
    const id = c?.driveFolderId;
    return NextResponse.json({ clientId, folderId: id ?? null, link: id ? `https://drive.google.com/drive/folders/${id}` : null });
  }
  return NextResponse.json({ driveId: FRIDAY_DRIVE_ID });
}

export async function POST() {
  const r = await provisionAllLibraries();
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
