// FRIDAY — Delegated Authority report + per-client profile control.
//
//   GET  /api/friday/authority                     → mode, profiles, shadow/auto stats, recent rows,
//                                                     format grants (Wave-2 Track B)
//   GET  /api/friday/authority?report=weekly       → Wave-6 weekly autonomy report: what ran
//                                                     autonomously, what shadow WOULD have run,
//                                                     formats granted/revoked — last 7 days.
//                                                     CLARA's Sunday brief consumes this.
//   POST /api/friday/authority { clientId, profile }                → set a client's authorityProfile
//   POST /api/friday/authority { action:"revoke_format", clientId, formatKind, reason? } → revoke a grant
//
// What the owner reviews during the shadow fortnight before promoting any client past "conservative".

import { NextResponse } from "next/server";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import { store } from "@/lib/persistence/store";
import { authorityMode } from "@/lib/friday/authority";
import { listGrants, revokeFormat } from "@/lib/friday/formatRegistry";
import type { Approval, Client, Project } from "@/lib/friday/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WEEK_MS = 7 * 24 * 3600_000;

// ── Wave 6: weekly autonomy report ──────────────────────────────────────────
// Derived from the append-only logs stream (authority.auto_approved / authority.shadow_auto are
// written at decision time by the orchestrator) + the formatGrants store — the report REPLAYS what
// was decided, it never re-evaluates. FRIDAY has no money engine and no circuit breaker, so
// `trips` is structurally empty here (the field exists so all three agents share one shape).
async function weeklyReport() {
  const now = Date.now();
  const inWindow = (iso: string | undefined): boolean =>
    typeof iso === "string" && now - Date.parse(iso) < WEEK_MS && Number.isFinite(Date.parse(iso));
  const [clients, projects, approvals, grants, logs] = await Promise.all([
    store.clients.all(),
    store.projects.all(),
    store.approvals.all(),
    listGrants(),
    store.logs.tail(2000, (l) =>
      (l.event === "authority.auto_approved" || l.event === "authority.shadow_auto") &&
      now - Date.parse(l.ts) < WEEK_MS,
    ),
  ]);
  const clientName = (id: string | undefined): string | undefined =>
    clients.find((c: Client) => c.id === id)?.name;
  const projectClient = (projectId: string | undefined): string | undefined =>
    projects.find((p: Project) => p.id === projectId)?.clientId;
  const approvalById = new Map(approvals.map((a: Approval) => [a.id, a]));

  // One human line per log row. auto_approved rows carry {id, tier, reason, via?}; the action text
  // lives on the approval row itself. shadow_auto rows carry a truncated `action` inline.
  const line = (l: { ts: string; projectId?: string; data?: Record<string, unknown> }) => {
    const approval = typeof l.data?.id === "string" ? approvalById.get(l.data.id) : undefined;
    const action = approval?.action ?? (typeof l.data?.action === "string" ? l.data.action : "");
    const reason = typeof l.data?.reason === "string" ? l.data.reason : "";
    const clientId = projectClient(l.projectId ?? approval?.projectId);
    return {
      ts: l.ts,
      kind: typeof l.data?.via === "string" ? String(l.data.via) : "authority",
      clientId,
      client: clientName(clientId),
      text: `${action || "(action unknown)"}${reason ? ` — ${reason}` : ""}`.slice(0, 220),
    };
  };
  const sorted = [...logs].sort((a, b) => (a.ts < b.ts ? 1 : -1));

  return NextResponse.json({
    app: "FRIDAY",
    generatedAt: new Date(now).toISOString(),
    windowDays: 7,
    autoExecuted: sorted.filter((l) => l.event === "authority.auto_approved").map(line),
    wouldHave: sorted.filter((l) => l.event === "authority.shadow_auto").map(line),
    formatsGranted: grants
      .filter((g) => inWindow(g.grantedAt) && g.status === "granted")
      .map((g) => ({ ts: g.grantedAt, clientId: g.clientId, client: clientName(g.clientId), formatKind: g.formatKind })),
    formatsRevoked: grants
      .filter((g) => inWindow(g.revokedAt))
      .map((g) => ({ ts: g.revokedAt!, clientId: g.clientId, client: clientName(g.clientId), formatKind: g.formatKind, reason: g.revokedReason })),
    trips: [] as Array<{ ts: string; kind: string; clientId?: string; client?: string; text: string }>,
  });
}

export async function GET(req: Request) {
  try {
    if (new URL(req.url).searchParams.get("report") === "weekly") return await weeklyReport();
    const [clients, approvals, logs, grants] = await Promise.all([
      store.clients.all(),
      store.approvals.all(),
      store.logs.tail(100, (l) =>
        l.event === "authority.shadow_auto" || l.event === "authority.auto_approved" ||
        l.event === "format.granted" || l.event === "format.revoked",
      ),
      listGrants(),
    ]);
    const stamped = approvals.filter((a) => a.authorityTier !== undefined);
    return NextResponse.json({
      mode: authorityMode(),
      profiles: clients.map((c) => ({ clientId: c.id, name: c.name, profile: c.authorityProfile ?? "conservative" })),
      stats: {
        evaluated: stamped.length,
        wouldAutoTotal: stamped.filter((a) => (a.authorityTier ?? 3) < 3).length,
        tier1: stamped.filter((a) => a.authorityTier === 1).length,
        tier2: stamped.filter((a) => a.authorityTier === 2).length,
        tier3: stamped.filter((a) => a.authorityTier === 3).length,
        autoApproved: approvals.filter((a) => a.autoApproved).length,
      },
      // Wave-2 Track B: every (client, format) grant, active + revoked, with auto-send counts.
      formatGrants: grants.map((g) => ({
        id: g.id, clientId: g.clientId, client: clients.find((c) => c.id === g.clientId)?.name,
        formatKind: g.formatKind, status: g.status, grantedAt: g.grantedAt,
        grantedFromApprovalId: g.grantedFromApprovalId, revokedAt: g.revokedAt, revokedReason: g.revokedReason,
        autoSendCount: g.autoSendCount, lastAutoSentAt: g.lastAutoSentAt,
      })),
      recent: [...logs].sort((a, b) => (a.ts < b.ts ? 1 : -1)).map((l) => ({ ts: l.ts, event: l.event, projectId: l.projectId, ...l.data })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  // Same guard the dials route puts on its writes (verifyInteragentSecret): loopback and
  // Access-authenticated callers pass; anything else needs the interagent secret. A profile
  // flip to "aggressive" widens what auto-executes as Tier 1 under FRIDAY_AUTHORITY=active,
  // so this write must not be reachable bare from the tunnel perimeter.
  if (!verifyInteragentSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const clientId = String(body.clientId ?? "");
    const profile = String(body.profile ?? "");
    if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
    // Wave-2 Track B: revoke a format grant — the format gates again from the next instance on.
    if (String(body.action ?? "") === "revoke_format") {
      const formatKind = String(body.formatKind ?? "");
      if (!formatKind) return NextResponse.json({ error: "formatKind is required" }, { status: 400 });
      const revoked = await revokeFormat(clientId, formatKind, body.reason ? String(body.reason) : "revoked via /api/friday/authority");
      if (!revoked) return NextResponse.json({ error: "no active grant for that client + formatKind" }, { status: 404 });
      return NextResponse.json({ grant: revoked });
    }
    if (!["conservative", "standard", "aggressive"].includes(profile)) {
      return NextResponse.json({ error: "profile must be conservative | standard | aggressive" }, { status: 400 });
    }
    const client = await store.clients.update(clientId, { authorityProfile: profile as "conservative" | "standard" | "aggressive", updatedAt: new Date().toISOString() });
    if (!client) return NextResponse.json({ error: "client not found" }, { status: 404 });
    return NextResponse.json({ client: { id: client.id, name: client.name, profile: client.authorityProfile } });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
