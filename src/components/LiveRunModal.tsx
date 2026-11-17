"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X, Square, FilePen, Eye, Terminal, Search, Globe, Loader2, Bug, FileText } from "lucide-react";

interface LiveAction { kind: string; target: string; at: number }
interface LiveData {
  source: string; status: string; role?: string; engine?: string; headline?: string;
  liveText?: string; actions?: LiveAction[]; tokens?: number; bugCount?: number; checking?: string;
  result?: string; summary?: string; verificationFailed?: boolean; startedAt?: number;
  confidence?: number; verification?: { ran: boolean; passed: boolean; checks: { name: string; ok: boolean }[] };
}

const ICON: Record<string, typeof Terminal> = { write: FilePen, edit: FilePen, read: Eye, command: Terminal, search: Search, web: Globe, other: FileText };
const KIND_COLOR: Record<string, string> = { write: "#34d399", edit: "#06b6d4", read: "#60a5fa", command: "#22d3ee", search: "#5eead4", web: "#f472b6", other: "var(--cream-dim)" };
const QA_ROLES = new Set(["qa", "review", "research-qa", "debug"]);
const TERMINAL = new Set(["done", "error", "stopped", "cancelled"]);

export default function LiveRunModal({ runId, title, onClose }: { runId: string; title?: string; onClose: () => void }) {
  const [d, setD] = useState<LiveData | null>(null);
  const [stopping, setStopping] = useState(false);
  const [, tick] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const done = !!d && TERMINAL.has(d.status);

  // Poll the live endpoint ~2s until the run reaches a terminal state (CodexView live-tail pattern).
  useEffect(() => {
    if (done) return;
    let alive = true;
    const load = async () => {
      try { const j = await fetch(`/api/friday/runs/${runId}/live`, { cache: "no-store" }).then((r) => r.json()); if (alive) setD(j); } catch { /* keep last */ }
    };
    load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [runId, done]);

  // Tick the elapsed clock once a second while running.
  useEffect(() => { if (done) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [done]);
  // Autoscroll the live text as it streams.
  useEffect(() => { if (bodyRef.current && !done) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [d?.liveText, done]);

  async function stop() { setStopping(true); try { await fetch(`/api/friday/runs/${runId}/stop`, { method: "POST" }); } catch { /* ignore */ } }

  const isQA = !!d?.role && QA_ROLES.has(d.role);
  const elapsed = d?.startedAt ? Math.max(0, Math.round((Date.now() - d.startedAt) / 1000)) : null;
  const actions = (d?.actions ?? []).slice(-40);
  const statusColor = d?.status === "done" ? "#34d399" : d?.status === "running" ? "#22d3ee" : d?.status === "stopped" || d?.status === "cancelled" ? "#06b6d4" : "#f87171";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(3px)" }} onClick={onClose}>
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-2xl border overflow-hidden"
        style={{ background: "var(--bg-mid)", borderColor: "var(--line-soft)" }} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="shrink-0 px-5 py-3.5 border-b flex items-center gap-3" style={{ borderColor: "var(--line-soft)" }}>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] truncate" style={{ color: "var(--cream)", fontFamily: "'Bricolage Grotesque', sans-serif" }}>{title || "Agent run"}</div>
            <div className="text-[11px] mt-0.5 flex items-center gap-2" style={{ color: "var(--cream-mute)" }}>
              <span className="uppercase tracking-wide">{d?.role ?? "agent"}</span>
              {d?.engine && <span>· {d.engine}</span>}
              {elapsed != null && <span>· {elapsed}s</span>}
              <span style={{ color: statusColor }}>· {d?.status ?? "…"}</span>
            </div>
          </div>
          {!done && (
            <button onClick={stop} disabled={stopping}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px]"
              style={{ background: "rgba(248,113,113,0.14)", color: "#f87171" }}>
              <Square size={12} /> {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
          <button onClick={onClose} className="grid place-items-center w-8 h-8 rounded-lg" style={{ color: "var(--cream-dim)" }}><X size={16} /></button>
        </div>

        {/* Headline + metrics */}
        <div className="shrink-0 px-5 py-2.5 border-b flex items-center gap-3 flex-wrap" style={{ borderColor: "var(--line-soft)" }}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {!done && <Loader2 size={14} className="animate-spin shrink-0" style={{ color: "#22d3ee" }} />}
            <span className="text-[13px] truncate" style={{ color: "var(--cream)" }}>{d?.headline ?? (done ? "Finished" : "Warming up…")}</span>
          </div>
          {isQA && (d?.bugCount ?? 0) >= 0 && (
            <span className="flex items-center gap-1 text-[12px] px-2 py-0.5 rounded-md" style={{ background: (d?.bugCount ?? 0) > 0 ? "rgba(248,113,113,0.14)" : "rgba(255,255,255,0.04)", color: (d?.bugCount ?? 0) > 0 ? "#f87171" : "var(--cream-dim)" }}>
              <Bug size={12} /> {d?.bugCount ?? 0}
            </span>
          )}
          {typeof d?.tokens === "number" && d.tokens > 0 && <span className="text-[11px]" style={{ color: "var(--cream-mute)" }}>{(d.tokens / 1000).toFixed(1)}k tok</span>}
        </div>

        {/* Body */}
        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          {isQA && d?.checking && (
            <div className="text-[12px]" style={{ color: "var(--cream-dim)" }}>Checking: <span style={{ color: "var(--cream)" }}>{d.checking}</span></div>
          )}

          {/* Tool/file/command timeline */}
          {actions.length > 0 && (
            <div className="space-y-1">
              {actions.map((a, i) => {
                const Ico = ICON[a.kind] ?? FileText;
                return (
                  <div key={i} className="flex items-center gap-2 text-[12px]">
                    <Ico size={13} style={{ color: KIND_COLOR[a.kind] ?? "var(--cream-dim)" }} className="shrink-0" />
                    <span className="uppercase text-[10px] tracking-wide w-14 shrink-0" style={{ color: "var(--cream-mute)" }}>{a.kind}</span>
                    <span className="truncate mono" style={{ color: "var(--cream)" }}>{a.target || "—"}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Streamed reasoning/output */}
          {d?.liveText && (
            <pre className="text-[12px] leading-relaxed whitespace-pre-wrap mono rounded-lg p-3" style={{ background: "rgba(0,0,0,0.25)", color: "var(--cream-soft)" }}>{d.liveText}</pre>
          )}

          {/* Final result when finished */}
          {done && d?.result && (
            <div className="friday-md text-[13px]" style={{ color: "var(--cream)" }}>
              {d.verificationFailed && <div className="text-[12px] mb-2 px-2 py-1 rounded" style={{ background: "rgba(248,113,113,0.14)", color: "#f87171" }}>⚠ Unverified — no real PR/commit found.</div>}
              {d.verification?.ran && (() => {
                const passed = d.verification.passed;
                const pct = typeof d.confidence === "number" ? Math.round(d.confidence * 100) : null;
                return (
                  <div className="text-[12px] mb-2 px-2 py-1 rounded flex items-center gap-2 flex-wrap" style={{ background: passed ? "rgba(52,211,153,0.14)" : "rgba(248,113,113,0.14)", color: passed ? "#34d399" : "#f87171" }}>
                    <span>{passed ? "✅ Verified" : "❌ Checks failed"}{pct !== null ? ` · ${pct}% confidence` : ""}</span>
                    {d.verification.checks.map((c) => (
                      <span key={c.name} style={{ opacity: 0.85 }}>{c.ok ? "✓" : "✗"} {c.name}</span>
                    ))}
                  </div>
                );
              })()}
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.result}</ReactMarkdown>
            </div>
          )}

          {!actions.length && !d?.liveText && !done && (
            <div className="text-[12px] italic flex items-center gap-2" style={{ color: "var(--cream-mute)" }}>
              <Loader2 size={12} className="animate-spin" /> Waiting for the agent to start…
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
