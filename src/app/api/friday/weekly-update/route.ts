// FRIDAY — weekly client update trigger + preview.
//
//   POST /api/friday/weekly-update { clientId?, dryRun? } → run for one client (or all active)
//
// dryRun returns the generated draft(s) + QA state without drafting/queueing/sending — the operator
// preview. Without dryRun, delivery follows Delegated Authority (Gmail draft + approval by default).

import { NextResponse } from "next/server";
import { store } from "@/lib/persistence/store";
import { runWeeklyUpdateForClient, runWeeklyUpdates, summarizeResults } from "@/lib/friday/weeklyUpdate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const clientId = body.clientId ? String(body.clientId) : undefined;
    const dryRun = !!body.dryRun;
    if (clientId) {
      const client = await store.clients.get(clientId);
      if (!client) return NextResponse.json({ error: "client not found" }, { status: 404 });
      const result = await runWeeklyUpdateForClient(client, { dryRun });
      return NextResponse.json({ result });
    }
    const results = await runWeeklyUpdates({ dryRun });
    return NextResponse.json({ summary: summarizeResults(results), results });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
