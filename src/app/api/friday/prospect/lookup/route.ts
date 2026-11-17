import { NextResponse } from "next/server";
import { verifyInteragentSecret, type ProspectLookupRequest, type ProspectLookupResponse } from "@autom8ionlab/agent-core";
import { logEvent } from "@/lib/persistence/store";
import { linkedinLookup, webRead } from "@/lib/friday/prospectLookups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A 2-profile LinkedIn lookup is four guarded calls with 45–120 s of pacing between each.
export const maxDuration = 300;

// Typed prospect lookups for CLARA's research engine (plan 2026-09-30, PR 4b). Interagent-gated,
// deterministic (no planner, no task, no run), read-only through reach-guard. See
// docs/prospect-lookups.md for the contract and lib/friday/prospectLookups.ts for the mechanics.
export async function POST(req: Request) {
  if (!verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Partial<ProspectLookupRequest>;
  const kind = body.kind;
  if (kind !== "prospect.linkedin_lookup" && kind !== "prospect.web_read") {
    return NextResponse.json({ ok: false, kind: "prospect.web_read", error: "kind must be prospect.linkedin_lookup or prospect.web_read", invalid_input: true } satisfies ProspectLookupResponse, { status: 400 });
  }
  const from = typeof body.from === "string" ? body.from.slice(0, 20) : "unknown";
  const ref = typeof body.ref === "string" ? body.ref.slice(0, 120) : undefined;
  const t0 = Date.now();
  const out: ProspectLookupResponse = kind === "prospect.linkedin_lookup" ? await linkedinLookup(body.input) : await webRead(body.input);
  logEvent("prospect.lookup", {
    kind, from, ref, ok: out.ok, ms: Date.now() - t0,
    ...(out.ok && out.kind === "prospect.linkedin_lookup" ? { people: out.people.length, skipped: out.skipped_reason, budget: out.budget } : {}),
    ...(!out.ok ? { error: out.error.slice(0, 200), refused: out.refused, locked: out.locked, not_logged_in: out.not_logged_in, invalid_input: out.invalid_input } : {}),
  }).catch(() => {});
  // Status codes mirror the guard's exit codes so a caller that only looks at HTTP still does the
  // right thing: 429 = refused today (don't retry), 423 = platform locked (tell the owner),
  // 409 = not logged in (only the owner can fix), 400 = bad input, 502 = backend failure.
  const status = out.ok ? 200
    : out.refused ? 429 : out.locked ? 423 : out.not_logged_in ? 409
    : out.invalid_input ? 400 : 502;
  return NextResponse.json(out, { status });
}
