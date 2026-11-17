// FRIDAY — escalation-briefing preview.
//   POST /api/friday/escalation-brief { clientId, reason?, channel? } → the briefing markdown
// Ad-hoc build against a client (no escalation row created, nothing notified) — the operator preview
// and the live-verification path for Wave-3 #10.

import { NextResponse } from "next/server";
import { store } from "@/lib/persistence/store";
import { buildEscalationBriefing } from "@/lib/friday/escalationBrief";
import type { Channel } from "@/lib/friday/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const clientId = String(body.clientId ?? "");
    if (!clientId) return NextResponse.json({ error: "clientId required" }, { status: 400 });
    const client = await store.clients.get(clientId);
    if (!client) return NextResponse.json({ error: "client not found" }, { status: 404 });
    const briefing = await buildEscalationBriefing(
      { channel: (body.channel as Channel) ?? "email", reason: body.reason ?? "(preview)", createdAt: new Date().toISOString(), threadId: undefined },
      client,
    );
    return NextResponse.json({ briefing });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
