import { NextResponse } from "next/server";
import { store } from "@/lib/persistence/store";
import { syncClientDocsFromDrive } from "@/lib/friday/docs/driveSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Pull documents the owner dropped straight into this client's Drive "Documents" folder (two-way sync).
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const client = await store.clients.get(id);
  if (!client) return NextResponse.json({ error: "client not found" }, { status: 404 });
  const result = await syncClientDocsFromDrive(client);
  return NextResponse.json(result);
}
