import { NextResponse } from "next/server";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import { store } from "@/lib/persistence/store";
import { decideApproval } from "@/lib/friday/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Both verbs guarded the same way the dials route guards its writes (verifyInteragentSecret):
// the dashboard on 127.0.0.1 and Access-authenticated tunnel requests pass without the header;
// anything else must present the interagent secret. The GET is gated too because the listing
// exposes full approval rows (draft bodies, project detail, execution metadata) — the exact
// reconnaissance a caller needs before POSTing an "approved" for a production deploy.

// GAP-C-1 (2026-07-23): dedicated /approvals page reads with ?filter=all|history|pending
// (default pending for backward compat with existing chat-embedded consumers).
export async function GET(req: Request) {
  if (!verifyInteragentSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const filter = (url.searchParams.get("filter") ?? "pending").toLowerCase();
  const all = await store.approvals.all();
  const rows = filter === "all"
    ? all
    : filter === "history"
      ? all.filter((a) => a.status !== "pending")
      : all.filter((a) => a.status === "pending");
  // Newest first — more useful than insertion order for a queue view.
  rows.sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
  return NextResponse.json({ approvals: rows });
}

export async function POST(req: Request) {
  // decideApproval executes the approved side effect (client email, agent dispatch, prod
  // deploy) — an unauthenticated POST here IS the owner's signature. Same guard as GET.
  if (!verifyInteragentSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : null;
  if (!id || !decision) return NextResponse.json({ error: "id and decision (approved|rejected) required" }, { status: 400 });
  // Who decided: CLARA relays the owner's plain-language answer with source "clara" and a
  // decidedBy such as "owner via clara/sms" (2026-09-24). Dashboard clicks stay "web".
  const source = body.source === "clara" ? "clara" : body.source === "os" ? "os" : "web";
  const decidedBy = typeof body.decidedBy === "string" ? body.decidedBy.slice(0, 80) : undefined;
  const approval = await decideApproval(id, decision, { source, decidedBy });
  if (!approval) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ approval });
}
