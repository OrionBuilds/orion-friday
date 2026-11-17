import { NextResponse } from "next/server";
import { store } from "@/lib/persistence/store";
import { getLive } from "@/lib/fridayLive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → the live picture of a run: the in-memory model (headline, streamed text, tool timeline, bug
// count) while it's running, falling back to the persisted run (compact live snapshot + final result)
// once it's finished or if this server didn't run it. Poll this ~2s from the viewer until status is
// terminal (done/error/stopped/cancelled).
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const live = getLive(id);
  if (live) {
    const terminal = live.status !== "running";
    // Once the run has finished, fold in the persisted final result/summary so the viewer can show
    // the outcome straight away (the in-memory model has no result field).
    const run = terminal ? await store.runs.get(id) : null;
    return NextResponse.json({
      source: "memory",
      runId: id,
      status: live.status,
      role: live.role,
      engine: live.engine,
      headline: live.headline,
      liveText: live.liveText,
      actions: live.actions,
      tokens: live.tokens,
      bugCount: live.bugCount,
      checking: live.checking,
      startedAt: live.startedAt,
      updatedAt: live.updatedAt,
      result: run?.result,
      summary: run?.summary,
      verificationFailed: run?.verificationFailed,
      confidence: run?.confidence,
      verification: run?.verification,
    });
  }
  const run = await store.runs.get(id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  return NextResponse.json({
    source: "disk",
    runId: id,
    status: run.status,
    role: run.agentId,
    engine: run.servedEngine ?? run.intendedEngine,
    headline: run.live?.headline,
    liveText: "",
    actions: [],
    tokens: run.live?.tokens,
    bugCount: run.live?.bugCount,
    checking: run.live?.checking,
    result: run.result,
    summary: run.summary,
    verificationFailed: run.verificationFailed,
    confidence: run.confidence,
    verification: run.verification,
  });
}
