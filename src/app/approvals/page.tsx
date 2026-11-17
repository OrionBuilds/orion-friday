"use client";

// FRIDAY approvals queue — GAP-C-1 (2026-07-23).
// Dedicated owner-facing queue view. Previously approvals were only visible inside the
// /friday chat surface, which meant the owner had to open the chat to see what was pending.
// Auto-refreshes every 30s. No arming-pill equivalent (FRIDAY has no live-writes ladder)
// but shows owner-status if away so the queue explains itself when nothing's happening.

import { useCallback, useEffect, useState } from "react";
import type { Approval } from "@/lib/friday/types";

type Filter = "pending" | "history" | "all";

interface OwnerStatus {
  away?: boolean;
  reason?: string;
}

function short(id: string): string {
  return id.slice(-6).toUpperCase();
}

function tierBadge(tier: 1 | 2 | 3 | undefined, mode: "shadow" | "active" | undefined): string | null {
  if (!tier) return null;
  const modeSlug = mode === "active" ? "auto" : mode === "shadow" ? "shadow" : "off";
  return `T${tier}·${modeSlug}`;
}

function riskColor(risk: string): string {
  return risk === "critical" ? "#f87171" : risk === "high" ? "#fb923c" : risk === "medium" ? "#facc15" : "#9ca3af";
}

async function decide(id: string, decision: "approved" | "rejected"): Promise<void> {
  const res = await fetch("/api/friday/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, decision }),
  });
  if (!res.ok) throw new Error(`decide failed: ${res.status}`);
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [ownerStatus, setOwnerStatus] = useState<OwnerStatus | null>(null);
  const [filter, setFilter] = useState<Filter>("pending");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [aRes, osRes] = await Promise.all([
        fetch(`/api/friday/approve?filter=${filter}`).then((r) => r.json() as Promise<{ approvals: Approval[] }>),
        // Best-effort — owner-status endpoint is informational; never let it block the queue.
        fetch("/api/friday/owner-status").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      setApprovals(aRes.approvals);
      setOwnerStatus(osRes);
      setErr(null);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const onDecide = async (id: string, decision: "approved" | "rejected") => {
    setBusy((prev) => new Set(prev).add(id));
    try {
      await decide(id, decision);
      await load();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const pendingCount = filter === "pending" ? approvals.length : approvals.filter((a) => a.status === "pending").length;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row" style={{ gap: 8, marginBottom: 4, flexWrap: "wrap", alignItems: "center" }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Approvals</h1>
        <div className="row" style={{ gap: 8, marginLeft: 12 }}>
          {(["pending", "history", "all"] as Filter[]).map((f) => (
            <button
              key={f}
              className={`btn btn-sm${filter === f ? " btn-accent" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "pending" ? `Pending${pendingCount ? ` (${pendingCount})` : ""}` : f === "history" ? "History" : "All"}
            </button>
          ))}
        </div>
        {ownerStatus?.away && (
          <span className="pill pill-warn" style={{ marginLeft: "auto" }}>
            Owner away{ownerStatus.reason ? ` — ${ownerStatus.reason.slice(0, 30)}` : ""}
          </span>
        )}
      </div>

      {err && <div style={{ color: "#f87171", padding: "8px 12px", background: "rgba(248,113,113,0.08)", borderRadius: 6 }}>{err}</div>}
      {loading && <div className="muted">Loading…</div>}

      {!loading && approvals.length === 0 && (
        <div className="muted" style={{ padding: "32px 12px", textAlign: "center", opacity: 0.7 }}>
          {filter === "pending" ? "No approvals waiting. You're all caught up." : "Nothing here yet."}
        </div>
      )}

      <div className="stack" style={{ gap: 12 }}>
        {approvals.map((a) => {
          const isBusy = busy.has(a.id);
          const isPending = a.status === "pending";
          const badge = tierBadge(a.authorityTier, a.authorityMode);
          return (
            <div
              key={a.id}
              style={{
                border: "1px solid rgba(148,163,184,0.15)",
                borderLeft: `3px solid ${riskColor(a.risk)}`,
                borderRadius: 8,
                padding: "14px 16px",
                background: "rgba(15,23,42,0.4)",
              }}
            >
              <div className="row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="mono" style={{ opacity: 0.5, fontSize: 12 }}>#{short(a.id)}</span>
                <span style={{ fontWeight: 500 }}>{a.action}</span>
                <span className="pill" style={{ fontSize: 11, opacity: 0.7 }}>{a.risk}</span>
                {badge && <span className="pill" style={{ fontSize: 11, opacity: 0.7 }}>{badge}</span>}
                {a.deployProjectId && <span className="pill" style={{ fontSize: 11, background: "rgba(251,146,60,0.15)" }}>deploy</span>}
                {a.emailDraftId && <span className="pill" style={{ fontSize: 11, background: "rgba(96,165,250,0.15)" }}>email</span>}
                {!isPending && <span className="pill" style={{ fontSize: 11, marginLeft: "auto", opacity: 0.6 }}>{a.status}</span>}
              </div>
              {a.detail && (
                <div style={{ opacity: 0.7, fontSize: 13, marginTop: 6, whiteSpace: "pre-wrap" }}>{a.detail.slice(0, 400)}{a.detail.length > 400 ? "…" : ""}</div>
              )}
              {a.resultNote && (
                <div style={{ opacity: 0.55, fontSize: 12, marginTop: 6, fontStyle: "italic" }}>{a.resultNote}</div>
              )}
              <div className="row" style={{ gap: 8, marginTop: 10, fontSize: 12, opacity: 0.55 }}>
                <span>asked {new Date(a.requestedAt).toLocaleString()}</span>
                {a.decidedAt && <span>· decided {new Date(a.decidedAt).toLocaleString()}</span>}
                {a.executedAt && <span>· executed {new Date(a.executedAt).toLocaleString()}</span>}
              </div>
              {isPending && (
                <div className="row" style={{ gap: 8, marginTop: 12 }}>
                  <button className="btn btn-sm btn-accent" style={{ flex: 1, minWidth: 96 }} disabled={isBusy} onClick={() => onDecide(a.id, "approved")}>
                    {isBusy ? "…" : "Approve"}
                  </button>
                  <button className="btn btn-sm" style={{ flex: 1, minWidth: 96 }} disabled={isBusy} onClick={() => onDecide(a.id, "rejected")}>
                    Reject
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
