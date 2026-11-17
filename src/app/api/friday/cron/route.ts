import { NextResponse } from "next/server";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import { runDueJobs } from "@/lib/friday/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Backstop for the in-process scheduler: runs any DUE jobs on demand. An external trigger (Windows
// Task Scheduler / cron / uptime pinger) can hit this so periodic work still fires if the process
// was cold. POST { force?: true } runs every job regardless of schedule (manual test).
//
// Both verbs are guarded like the dials route's writes (verifyInteragentSecret): a local cron
// trigger and Access-authenticated callers pass; a bare tunnel caller cannot force-fire every
// registered job (weekly client updates, approval processing) on demand.
export async function POST(req: Request) {
  if (!verifyInteragentSecret(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const result = await runDueJobs(body.force === true);
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(req: Request) {
  if (!verifyInteragentSecret(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await runDueJobs(false);
  return NextResponse.json({ ok: true, ...result });
}
