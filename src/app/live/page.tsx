"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, Bug, Activity } from "lucide-react";
import LiveRunModal from "@/components/LiveRunModal";

interface RunningRun {
  id: string; agentName: string; role: string; engine?: string;
  taskTitle?: string; projectName?: string; status: string; startedAt: string;
  headline?: string; bugCount?: number; checking?: string; actionsCount?: number; tokens?: number;
}

const QA_ROLES = new Set(["qa", "review", "research-qa", "debug"]);
const ENGINE_COLOR: Record<string, string> = { claude: "#d97757", codex: "#22c55e", antigravity: "#7c3aed", hermes: "#60a5fa", lmstudio: "#5eead4" };

export default function ControlRoom() {
  const [runs, setRuns] = useState<RunningRun[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const j = await fetch("/api/friday/runs?status=running", { cache: "no-store" }).then((r) => r.json());
      setRuns(Array.isArray(j.runs) ? j.runs : []);
    } catch { /* keep last */ } finally { setLoaded(true); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 2500); return () => clearInterval(t); }, [load]);

  const openTitle = runs.find((r) => r.id === openId)?.taskTitle;

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <h1 className="page-title">Control Room</h1>
        {runs.length > 0 && <span className="flex items-center gap-1.5 text-[13px] px-2.5 py-1 rounded-full" style={{ background: "rgba(192,132,252,0.14)", color: "#22d3ee" }}><Loader2 size={13} className="animate-spin" /> {runs.length} live</span>}
      </div>
      <p className="text-[14px] mb-6" style={{ color: "var(--cream-dim)" }}>What every agent is doing right now — click a card to watch it live.</p>

      {loaded && runs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center" style={{ color: "var(--cream-mute)" }}>
          <Activity size={28} className="mb-3 opacity-50" />
          <div className="text-[15px]" style={{ color: "var(--cream-dim)" }}>No agents running right now.</div>
          <div className="text-[13px] mt-1">Dispatch a task from a project board and it&apos;ll appear here.</div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {runs.map((r) => {
          const isQA = QA_ROLES.has(r.role);
          const elapsed = Math.max(0, Math.round((Date.now() - new Date(r.startedAt).getTime()) / 1000));
          return (
            <motion.button key={r.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              onClick={() => setOpenId(r.id)}
              className="text-left rounded-2xl border p-4 hover:brightness-110 transition"
              style={{ background: "var(--bg-mid)", borderColor: "var(--line-soft)" }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: ENGINE_COLOR[r.engine ?? ""] ?? "#22d3ee" }} />
                <span className="text-[13px]" style={{ color: "var(--cream)" }}>{r.agentName}</span>
                {r.engine && <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.05)", color: "var(--cream-mute)" }}>{r.engine}</span>}
                <span className="ml-auto text-[11px]" style={{ color: "var(--cream-mute)" }}>{elapsed}s</span>
              </div>
              <div className="text-[13px] truncate mb-0.5" style={{ color: "var(--cream-soft)" }}>{r.taskTitle ?? "task"}</div>
              {r.projectName && <div className="text-[11px] truncate mb-2" style={{ color: "var(--cream-mute)" }}>{r.projectName}</div>}
              <div className="flex items-center gap-2 mt-2">
                <Loader2 size={12} className="animate-spin shrink-0" style={{ color: "#22d3ee" }} />
                <span className="text-[12px] truncate" style={{ color: "var(--cream)" }}>{r.headline ?? "working…"}</span>
              </div>
              <div className="flex items-center gap-3 mt-2 text-[11px]" style={{ color: "var(--cream-mute)" }}>
                {typeof r.actionsCount === "number" && r.actionsCount > 0 && <span>{r.actionsCount} actions</span>}
                {isQA && typeof r.bugCount === "number" && <span className="flex items-center gap-1" style={{ color: r.bugCount > 0 ? "#f87171" : undefined }}><Bug size={11} /> {r.bugCount}</span>}
                {typeof r.tokens === "number" && r.tokens > 0 && <span>{(r.tokens / 1000).toFixed(1)}k tok</span>}
              </div>
            </motion.button>
          );
        })}
      </div>

      {openId && <LiveRunModal runId={openId} title={openTitle} onClose={() => setOpenId(null)} />}
    </div>
  );
}
