// Autonomy dials over HTTP, so they can be read and changed from a phone via CLARA rather than by
// editing .env.local and restarting.
//
// GET  -> every dial, its current value, and where that value came from (dial / env / default).
// POST -> { name, value, setBy? } changes one, and reports the transition.
//
// Writes require the interagent secret. That is a weaker guarantee than it looks —
// verifyInteragentSecret returns true when INTERAGENT_SHARED_SECRET is unset, deliberately, for
// local dev — so with no secret configured this is protected only by the 127.0.0.1 bind and the
// Access-gated tunnel, which is the same perimeter as the rest of FRIDAY's API. Worth stating
// because this endpoint changes how much FRIDAY does without asking.

import { NextResponse } from "next/server";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import { allDials, setDial } from "@/lib/friday/dials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ dials: allDials() });
}

export async function POST(req: Request) {
  if (!verifyInteragentSecret(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: { name?: string; value?: string; setBy?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.name || !body.value) {
    return NextResponse.json({ ok: false, error: "name and value are required" }, { status: 400 });
  }
  // setBy is attribution for the audit log, not identity — the caller already proved it is a
  // sibling agent (or the perimeter did). Defaulting it keeps the log honest when it is omitted.
  const result = await setDial(body.name, body.value, body.setBy?.trim() || "unknown");
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
