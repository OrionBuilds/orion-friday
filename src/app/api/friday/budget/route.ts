// Today's ceilings — model spend AND scheduled runs: read them, or add to either.
//
// GET  -> { spentUsd, effectiveCapUsd, runsToday, effectiveRunCap, ..., blocked }
// POST -> { extraUsd?, extraRuns?, grantedBy?, reason? } adds to TODAY's ceilings only.
//
// Both live here rather than in two endpoints because they are the same decision from the owner's
// side ("this deadline needs more today") and share one dated grant record.
//
// This exists so a spend cap that fires mid-afternoon with a client deadline live is answerable
// from a phone instead of requiring an .env edit and a restart. The grant expires at midnight by
// construction (usage.ts keys it to the date), so raising it to clear one deadline cannot silently
// become the standing budget.
//
// Writes require the interagent secret — the realistic caller is CLARA relaying an SMS from the owner.
// Treat that as attribution rather than authorisation: verifyInteragentSecret returns true when
// INTERAGENT_SHARED_SECRET is unset, so with no secret configured the real perimeter is the
// 127.0.0.1 bind plus the Access-gated tunnel, same as the rest of FRIDAY's API.

import { NextResponse } from "next/server";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import {
  spendToday, dayMaxCostUsd, spendOverrideToday, effectiveDayMaxUsd, grantSpendIncrease,
  runsToday, dailyRunCap, runOverrideToday, effectiveDailyRunCap, grantRunIncrease,
  blockedWorkContext,
} from "@/lib/friday/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [spentUsd, grantedUsd, effectiveCapUsd, runs, grantedRuns, effectiveRunCap, blocked] = await Promise.all([
    spendToday(), spendOverrideToday(), effectiveDayMaxUsd(),
    runsToday(), runOverrideToday(), effectiveDailyRunCap(),
    blockedWorkContext(5),
  ]);
  return NextResponse.json({
    spentUsd,
    baseCapUsd: dayMaxCostUsd(),
    grantedUsd,
    effectiveCapUsd,
    withinBudget: spentUsd < effectiveCapUsd,
    runsToday: runs,
    baseRunCap: dailyRunCap(),
    grantedRuns,
    effectiveRunCap,
    withinRunBudget: runs < effectiveRunCap,
    blocked,
  });
}

export async function POST(req: Request) {
  if (!verifyInteragentSecret(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: { extraUsd?: number; extraRuns?: number; grantedBy?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const by = body.grantedBy?.trim() || "unknown";
  const wantUsd = body.extraUsd != null;
  const wantRuns = body.extraRuns != null;
  if (!wantUsd && !wantRuns) {
    return NextResponse.json({ ok: false, error: "pass extraUsd and/or extraRuns" }, { status: 400 });
  }

  // Bounded on both ends. Zero or negative is meaningless as a "raise", and an unbounded single
  // grant would let one fat-fingered text undo the entire point of having a breaker.
  const parts: string[] = [];
  if (wantUsd) {
    const extra = Number(body.extraUsd);
    if (!Number.isFinite(extra) || extra <= 0 || extra > 500) {
      return NextResponse.json({ ok: false, error: "extraUsd must be a number between 0 and 500" }, { status: 400 });
    }
    const { effectiveCap } = await grantSpendIncrease(extra, by, body.reason);
    parts.push(`budget +$${extra.toFixed(2)} (cap now $${effectiveCap.toFixed(2)})`);
  }
  if (wantRuns) {
    const extra = Number(body.extraRuns);
    if (!Number.isFinite(extra) || extra <= 0 || extra > 500) {
      return NextResponse.json({ ok: false, error: "extraRuns must be a number between 0 and 500" }, { status: 400 });
    }
    const { effectiveCap } = await grantRunIncrease(extra, by, body.reason);
    parts.push(`runs +${Math.floor(extra)} (cap now ${effectiveCap})`);
  }

  const [spentUsd, effectiveCapUsd, runs, effectiveRunCap] = await Promise.all([
    spendToday(), effectiveDayMaxUsd(), runsToday(), effectiveDailyRunCap(),
  ]);
  return NextResponse.json({
    ok: true,
    message: `Raised for today — ${parts.join(", ")}. Spent $${spentUsd.toFixed(2)}, ${runs} run(s) used.`,
    effectiveCapUsd, spentUsd, effectiveRunCap, runsToday: runs,
  });
}
