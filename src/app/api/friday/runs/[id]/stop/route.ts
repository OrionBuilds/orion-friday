import { NextResponse } from "next/server";
import { store, nowISO, logEvent } from "@/lib/persistence/store";
import { killProc } from "@/lib/ultracodeProcs";
import { endLive } from "@/lib/fridayLive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST → stop a running agent. Kills the registered child process (registered on spawn, so this works
// from a different request than the one that started it); executeRun's catch path then marks the run
// cancelled. We also mark it here in case the process was already gone.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const killed = killProc(id);
  endLive(id, "stopped");
  const run = await store.runs.get(id);
  if (run && run.status === "running") {
    await store.runs.update(id, { status: "cancelled", endedAt: nowISO(), error: "Stopped by operator" }).catch(() => {});
  }
  await logEvent("dispatch.stop_requested", { killed }, { level: "warn", runId: id }).catch(() => {});
  return NextResponse.json({ ok: true, killed });
}
