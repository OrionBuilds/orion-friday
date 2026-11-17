import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store } from "@/lib/persistence/store";
import { engineHealthDeep } from "@/lib/friday/engines";
import { engineStates, overallHealthy } from "@/lib/friday/healthSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Health endpoint (1.2) for an EXTERNAL heartbeat monitor — detection must live outside FRIDAY, since a
// down FRIDAY can't page anyone. Returns 200 when healthy, 503 when the datastore is unreadable or the
// OS session is broken. Engine status is informational (see healthSummary.ts for the retired-component
// and LM Studio rules). The old inbound-email-loop check was removed 2026-10-29: that loop is retired.

// A genuine "store is readable" probe: read one collection file directly. store.*.all() swallows a
// corrupt/locked file to [], which would mask exactly the failure we want to catch.
async function dbOk(): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(FRIDAY_DATA_DIR, "clients.json"), "utf8");
    return Array.isArray(JSON.parse(raw));
  } catch { return false; }
}

export async function GET() {
  const [db, deep, running, pending] = await Promise.all([
    dbOk(),
    engineHealthDeep().catch(() => ({} as Record<string, { configured: boolean; authed: boolean | null }>)),
    store.runs.find((r) => r.status === "running" || r.status === "queued"),
    store.approvals.find((a) => a.status === "pending"),
  ]);

  const engines = engineStates(deep);

  // OS-session liveness (2026-10-28 audit): a broken OS session can't page anyone through the OS, so
  // it turns this endpoint 503 for the external monitor. Raised by the os-auth-liveness job.
  const { readOsAuthAlarm } = await import("@/lib/friday/osLiveness");
  const osAuthAlarm = await readOsAuthAlarm();

  const healthy = overallHealthy({ db, osAuthBroken: Boolean(osAuthAlarm), engines });
  const body = {
    status: healthy ? "ok" : "degraded",
    db: db ? "ok" : "error",
    osAuth: osAuthAlarm ? "broken" : "ok",
    ...(osAuthAlarm ? { osAuthAlarm: { since: osAuthAlarm.firstFailureAt, failures: osAuthAlarm.failures, lastError: osAuthAlarm.lastError.slice(0, 160), repair: "/os/auth" } } : {}),
    engines,
    queueDepth: { running: running.length, pendingApprovals: pending.length },
    ts: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: healthy ? 200 : 503 });
}
