// FRIDAY — brief-section endpoint for CLARA's 8am executive brief (Wave 4).
//
//   GET  /api/friday/brief-section        → { pendingApprovals, autonomousActions, anomalies, queued }
//                                           pending approvals + last-24h autonomous activity (authority
//                                           auto-approvals real AND shadow, delivery/deploy log trail,
//                                           completed runs) + anomalies (confirmed-down uptime projects,
//                                           lapsed engine auth) + the notify-policy queue (peek only —
//                                           a GET never drains anything; the /brief page re-composes
//                                           on every view).
//   POST /api/friday/brief-section {ids}  → ackQueue(ids). CLARA calls this ONLY after her brief email
//                                           actually delivered (two-phase drain) — failed delivery
//                                           means no POST, and the items reappear in the next brief.
//
// No auth: localhost trust boundary, same as the rest of FRIDAY's API surface.

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { store, FRIDAY_DATA_DIR } from "@/lib/persistence/store";
import type { OrchestrationLog } from "@/lib/friday/types";
import { peekQueuedNotifications, ackQueuedNotifications, stripEmoji } from "@/lib/friday/notify";
import { approvalHeadline, approvalSummary, approvalQuestion } from "@/lib/friday/approvalCopy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 3600_000;

// Log events that count as "FRIDAY acted on its own": authority auto-approvals (real and shadow)
// plus the delivery/deploy trail the orchestrator leaves behind when a run actually shipped.
const AUTO_EVENTS = new Set([
  "authority.auto_approved",
  "authority.shadow_auto",
  "deliver.email",
  "deliver.doc",
  "email.reply.sent",
  "client.notify",
  "deploy.approved_run",
  "netlify.deploy",
]);

// Render a log row into one human line without hand-writing a case per event: the interesting
// scalar fields (id/tier/reason/to/subject/…) are appended compactly, objects are skipped.
function compactData(d: Record<string, unknown> | undefined): string {
  if (!d) return "";
  const bits = Object.entries(d)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, 4)
    .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`);
  return bits.length ? ` (${bits.join(", ")})` : "";
}

function logLine(l: OrchestrationLog): { ts: string; kind: string; text: string } {
  const prefix = l.event === "authority.shadow_auto" ? "[shadow] " : "";
  return { ts: l.ts, kind: l.event, text: `${prefix}${l.event}${compactData(l.data)}` };
}

interface UptimeState { status?: "up" | "down"; consecutiveFails?: number; lastDownAlertAt?: string }

export async function GET() {
  try {
    const now = Date.now();
    const [approvals, logs, runs, projects, queued] = await Promise.all([
      store.approvals.all(),
      store.logs.tail(500, (l) => AUTO_EVENTS.has(l.event) && now - Date.parse(l.ts) < DAY_MS),
      store.runs.all(),
      store.projects.all(),
      peekQueuedNotifications(),
    ]);

    // Plain-English, code-free (2026-09-24): CLARA renders `needsDecision.question` and the owner
    // answers in words. `action`/`risk` stay for consumers that already read them.
    const dashboard = `${process.env.FRIDAY_PUBLIC_URL?.replace(/\/$/, "") || "http://127.0.0.1:3737"}/approvals`;
    const pendingApprovals = approvals
      .filter((a) => a.status === "pending")
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)) // oldest first — brief renders in age order
      .map((a) => {
        const headline = stripEmoji(a.facts ? approvalHeadline(a.facts) : a.action.slice(0, 120));
        const summary = stripEmoji(a.facts ? approvalSummary(a.facts) : (a.detail ?? "").slice(0, 400));
        const question = stripEmoji(a.facts ? approvalQuestion(a.facts) : `Go ahead with "${a.action.slice(0, 80)}"?`);
        const links: Array<{ label: string; url: string }> = [{ label: "Approvals", url: dashboard }];
        return { id: a.id, action: a.action, risk: a.risk, requestedAt: a.requestedAt, at: a.requestedAt, headline, summary, needsDecision: { question, options: ["approve", "reject"], approvalId: a.id }, links };
      });

    // Completed runs land beside the log trail: a run that finished cleanly in the last 24h is
    // autonomous work done, whether or not any single log event captured its outcome.
    const doneRuns = runs
      .filter((r) => r.status === "done" && r.endedAt && now - Date.parse(r.endedAt) < DAY_MS)
      .map((r) => ({
        ts: r.endedAt!,
        kind: "run.done",
        text: `run completed: ${(r.summary ?? r.input).slice(0, 160)}`,
      }));

    const autonomousActions = [...logs.map(logLine), ...doneRuns]
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, 30);

    // Anomalies — read the scheduler's own state files rather than re-probing (a GET for the brief
    // must stay cheap; the probes themselves run on the scheduler's cadence).
    const anomalies: Array<{ kind: string; text: string }> = [];
    try {
      const raw = JSON.parse(await fs.readFile(path.join(FRIDAY_DATA_DIR, "uptime-state.json"), "utf8")) as Record<string, UptimeState | string>;
      for (const [projectId, v] of Object.entries(raw)) {
        const down = typeof v === "string" ? v === "down" : v.status === "down";
        if (!down) continue;
        const name = projects.find((p) => p.id === projectId)?.name ?? projectId;
        const detail = typeof v === "string" ? "" : ` (${v.consecutiveFails ?? "?"} consecutive fails${v.lastDownAlertAt ? `, last alerted ${v.lastDownAlertAt}` : ""})`;
        anomalies.push({ kind: "uptime", text: `${name} is DOWN${detail}` });
      }
    } catch { /* no uptime state yet */ }
    try {
      const auth = JSON.parse(await fs.readFile(path.join(FRIDAY_DATA_DIR, "engine-auth-state.json"), "utf8")) as Record<string, boolean>;
      for (const [engine, authed] of Object.entries(auth)) {
        if (authed === false) anomalies.push({ kind: "engine-auth", text: `engine "${engine}" is un-authed — tasks routed to it will degrade` });
      }
    } catch { /* no engine-auth state yet */ }

    return NextResponse.json({
      app: "FRIDAY",
      generatedAt: new Date(now).toISOString(),
      pendingApprovals,
      autonomousActions,
      anomalies,
      // Structured items (2026-09-24): headline/summary/links/needsDecision when the caller set
      // them, `text` always as the plain fallback line. No emoji anywhere.
      queued: queued.map((q) => {
        const m = ((q as { meta?: Record<string, unknown> }).meta ?? {}) as { headline?: string; summary?: string; links?: unknown; needsDecision?: unknown };
        return {
          id: q.id, kind: q.kind, at: q.at, priority: q.priority,
          text: stripEmoji(q.text),
          headline: m.headline ? stripEmoji(m.headline) : stripEmoji(q.text.split("\n")[0]).slice(0, 120),
          summary: m.summary ? stripEmoji(m.summary) : null,
          links: Array.isArray(m.links) ? m.links : [],
          needsDecision: m.needsDecision ?? null,
        };
      }),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string") : [];
    if (!ids.length) return NextResponse.json({ removed: 0 });
    const removed = await ackQueuedNotifications(ids);
    return NextResponse.json({ removed });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
