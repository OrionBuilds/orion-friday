// FRIDAY — meeting-prep trigger + preview.
//
//   POST /api/friday/meeting-prep { clientId, dryRun? } → build the briefing for that client NOW
//   POST /api/friday/meeting-prep { sweep: true }       → run the calendar-window sweep once
//
// dryRun (default true for clientId mode) returns the briefing markdown without notifying anyone —
// the operator preview and the live-verification path.

import { NextResponse } from "next/server";
import { store } from "@/lib/persistence/store";
import { buildBriefing, runMeetingPrepSweep } from "@/lib/friday/meetingPrep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body.sweep) {
      const note = await runMeetingPrepSweep();
      return NextResponse.json({ note });
    }
    const clientId = body.clientId ? String(body.clientId) : "";
    if (!clientId) return NextResponse.json({ error: "clientId (or sweep:true) required" }, { status: 400 });
    const client = await store.clients.get(clientId);
    if (!client) return NextResponse.json({ error: "client not found" }, { status: 404 });
    const briefing = await buildBriefing(client);
    if (body.dryRun === false) {
      const { notifyOwner } = await import("@/lib/friday/notify");
      await notifyOwner({ kind: "meeting prep", priority: "normal", text: `📋 Prep for ${client.name} — briefing in your email.`, email: true, emailText: briefing, subject: `Prep: ${client.name}`, dedupeKey: `meetprep:manual:${clientId}:${Date.now()}` });
    }
    return NextResponse.json({ briefing });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
