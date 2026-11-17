"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Sparkles, Sunrise, FolderKanban, ShieldAlert, Activity, ArrowRight, Cpu, Radio, RefreshCw } from "lucide-react";

interface BrainUsage { engine: string; model?: string; fallback: boolean; at: string }
interface EngineHealth { claude: boolean; codex: boolean; antigravity: boolean; hermes: boolean; lmstudio: boolean }
interface DeepHealth { configured: boolean; authed: boolean | null; detail?: string }
type EngineDeep = Record<"claude" | "codex" | "antigravity" | "hermes" | "lmstudio", DeepHealth>;
interface Status { counts: { clients: number; projects: number; activeProjects: number; openTasks: number; agents: number; pendingApprovals: number }; brains: { claude: boolean; lmstudio: boolean; lmStudioModels: string[]; last?: BrainUsage | null; engines?: EngineHealth; enginesDeep?: EngineDeep }; owner: string; }
interface Prescription { title: string; why: string; action: string; agent?: string; projectId?: string; }
interface Dream { greeting: string; prescriptions: Prescription[]; }
interface Project { id: string; name: string; status: string; clientId: string; }
interface LogRow { id: string; ts: string; event: string; level: string; }

const agentColor: Record<string, string> = { architect: "#22d3ee", dev: "#d97757", devops: "#22c55e", qa: "#38bdf8", debug: "#f59e0b", automation: "#7c3aed", pm: "#34d399", support: "#60a5fa", "research-qa": "#f472b6", research: "#f472b6" };

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [dream, setDream] = useState<Dream | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [feed, setFeed] = useState<LogRow[]>([]);
  const [dreaming, setDreaming] = useState(false);

  useEffect(() => {
    const loadStatus = () => fetch("/api/friday/status").then((r) => r.json()).then(setStatus).catch(() => {});
    loadStatus();
    fetch("/api/friday/projects").then((r) => r.json()).then((j) => setProjects(j.projects ?? [])).catch(() => {});
    fetch("/api/friday/feed?limit=10").then((r) => r.json()).then((j) => setFeed(j.logs ?? [])).catch(() => {});
    fetch("/api/friday/dream").then((r) => r.json()).then((j) => setDream(j.dream)).catch(() => {});
    const t = setInterval(loadStatus, 8000); // keep the "last brain" indicator fresh
    return () => clearInterval(t);
  }, []);

  async function regenDream() {
    setDreaming(true);
    try { const j = await fetch("/api/friday/dream", { method: "POST" }).then((r) => r.json()); setDream(j.dream); } finally { setDreaming(false); }
  }

  const active = projects.filter((p) => p.status === "active");

  return (
    <div className="space-y-6">
      {/* hero */}
      <div className="flex items-center gap-4">
        <div className="relative grid place-items-center w-14 h-14 rounded-2xl" style={{ background: "radial-gradient(circle at 30% 30%, #22d3ee, #7c3aed 60%, #4c1d95)", boxShadow: "0 0 30px rgba(168,85,247,0.5)" }}>
          <Sparkles size={24} className="text-white" />
          <motion.span className="absolute inset-0 rounded-2xl" animate={{ boxShadow: ["0 0 0 0 rgba(168,85,247,0.4)", "0 0 0 14px rgba(168,85,247,0)"] }} transition={{ duration: 2, repeat: Infinity }} />
        </div>
        <div>
          <h1 className="text-2xl tracking-tight" style={{ fontFamily: "'Bricolage Grotesque', sans-serif", color: "var(--cream)" }}>Mission Control</h1>
          <p className="text-[13px]" style={{ color: "var(--cream-mute)" }}>{dream?.greeting || `Welcome back, ${status?.owner ?? "Commander"}.`}</p>
        </div>
        <Link href="/friday" className="ml-auto flex items-center gap-2 px-4 py-2 rounded-xl text-[13px]" style={{ background: "linear-gradient(135deg,#22d3ee,#7c3aed)", color: "white" }}>
          <Radio size={15} /> Talk to FRIDAY
        </Link>
      </div>

      {/* stat row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Active projects" value={status?.counts.activeProjects ?? 0} icon={<FolderKanban size={16} />} accent="#34d399" href="/projects" />
        <Stat label="Open tasks" value={status?.counts.openTasks ?? 0} icon={<Activity size={16} />} accent="#60a5fa" href="/projects" />
        <Stat label="Awaiting approval" value={status?.counts.pendingApprovals ?? 0} icon={<ShieldAlert size={16} />} accent="#fb923c" href="/friday" />
        <Stat label="Active agents" value={status?.counts.agents ?? 0} icon={<Sparkles size={16} />} accent="#22d3ee" href="/agents" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* dream brief */}
        <div className="rounded-2xl border p-5" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
          <div className="flex items-center gap-2 mb-4">
            <Sunrise size={17} style={{ color: "#fbbf24" }} />
            <h2 className="text-[15px]" style={{ color: "var(--cream)" }}>Today&apos;s brief</h2>
            <button onClick={regenDream} disabled={dreaming} className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg disabled:opacity-50" style={{ background: "rgba(255,255,255,0.05)", color: "var(--cream-dim)" }}>
              <RefreshCw size={11} className={dreaming ? "animate-spin" : ""} /> {dreaming ? "Thinking…" : "Refresh"}
            </button>
          </div>
          <div className="space-y-3">
            {(dream?.prescriptions ?? []).map((p, i) => (
              <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex gap-3">
                <div className="shrink-0 grid place-items-center w-6 h-6 rounded-lg text-[12px]" style={{ background: `${agentColor[p.agent ?? ""] ?? "#22d3ee"}22`, color: agentColor[p.agent ?? ""] ?? "#22d3ee" }}>{i + 1}</div>
                <div>
                  <p className="text-[14px]" style={{ color: "var(--cream)" }}>{p.title}{p.agent && <span className="ml-2 text-[10px] uppercase px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.05)", color: "var(--cream-mute)" }}>{p.agent}</span>}</p>
                  <p className="text-[12px] mb-0.5" style={{ color: "var(--cream-mute)" }}>{p.why}</p>
                  <p className="text-[12px]" style={{ color: "#22d3ee" }}>→ {p.action}</p>
                </div>
              </motion.div>
            ))}
            {(!dream || dream.prescriptions.length === 0) && <p className="text-[13px]" style={{ color: "var(--cream-mute)" }}>No brief yet — add a client project and FRIDAY will prescribe your day.</p>}
          </div>
        </div>

        {/* right rail: brains + activity */}
        <div className="space-y-5">
          <div className="rounded-2xl border p-4" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
            <h2 className="text-[12px] uppercase tracking-[0.18em] mb-3" style={{ color: "var(--cream-dim)" }}>Brains</h2>
            <div className="space-y-2 text-[13px]">
              <Brain label="Claude — dev, architecture, design" on={status?.brains.engines?.claude ?? status?.brains.claude} health={status?.brains.enginesDeep?.claude} />
              <Brain label="Codex — code review, QA, git/exec" on={status?.brains.engines?.codex} health={status?.brains.enginesDeep?.codex} />
              <Brain label="Antigravity — browser, host RPA" on={status?.brains.engines?.antigravity} health={status?.brains.enginesDeep?.antigravity} />
              <Brain label="Hermes — client comms, research, SEO/sales" on={status?.brains.engines?.hermes} health={status?.brains.enginesDeep?.hermes} />
              <Brain label={`LM Studio — planning, drafts${status?.brains.lmStudioModels?.length ? ` (${status.brains.lmStudioModels.length})` : ""}`} on={status?.brains.lmstudio} health={status?.brains.enginesDeep?.lmstudio} icon={<Cpu size={13} />} />
            </div>
            <LastBrain last={status?.brains.last} />
          </div>
          <div className="rounded-2xl border p-4" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
            <h2 className="text-[12px] uppercase tracking-[0.18em] mb-3" style={{ color: "var(--cream-dim)" }}>Activity</h2>
            <div className="space-y-1.5 max-h-[220px] overflow-y-auto">
              {feed.length === 0 && <p className="text-[12px]" style={{ color: "var(--cream-mute)" }}>Quiet so far.</p>}
              {feed.map((l) => (
                <div key={l.id} className="flex items-center gap-2 text-[12px]">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: l.level === "error" ? "#f87171" : "#22d3ee" }} />
                  <span style={{ color: "var(--cream-mute)" }} className="mono">{new Date(l.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
                  <span style={{ color: "var(--cream-dim)" }}>{l.event}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* active projects */}
      {active.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-[15px]" style={{ color: "var(--cream)" }}>Active projects</h2>
            <Link href="/projects" className="text-[12px] flex items-center gap-1" style={{ color: "#22d3ee" }}>All <ArrowRight size={12} /></Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {active.slice(0, 6).map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="rounded-xl border p-4" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
                <div className="flex items-center justify-between">
                  <span className="text-[14px]" style={{ color: "var(--cream)" }}>{p.name}</span>
                  <span className="text-[10px] uppercase px-2 py-0.5 rounded-full" style={{ background: "rgba(52,211,153,0.16)", color: "#34d399" }}>{p.status}</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, icon, accent, href }: { label: string; value: number; icon: React.ReactNode; accent: string; href: string }) {
  return (
    <Link href={href}>
      <motion.div whileHover={{ y: -2 }} className="rounded-2xl border p-4" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
        <div className="flex items-center gap-2 mb-1" style={{ color: accent }}>{icon}<span className="text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--cream-mute)" }}>{label}</span></div>
        <div className="text-2xl" style={{ color: "var(--cream)", fontFamily: "'Bricolage Grotesque', sans-serif" }}>{value}</div>
      </motion.div>
    </Link>
  );
}

function LastBrain({ last }: { last?: BrainUsage | null }) {
  if (!last) return null;
  const name = last.engine === "lmstudio" ? "LM Studio"
    : last.engine === "claude" ? `Claude${last.model ? ` · ${last.model}` : ""}`
    : last.engine.charAt(0).toUpperCase() + last.engine.slice(1);
  const t = new Date(last.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="mt-3 pt-3 border-t flex items-center gap-2 text-[11px]" style={{ borderColor: "var(--line-soft)" }}>
      <span style={{ color: "var(--cream-mute)" }}>Last served</span>
      <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
        title={last.fallback ? "The primary brain failed — this request was served by the fallback." : "Served by the primary brain."}
        style={{ background: last.fallback ? "rgba(245,158,11,0.16)" : "rgba(52,211,153,0.14)", color: last.fallback ? "#f59e0b" : "#34d399" }}>
        {last.fallback && "⚠ "}{name}{last.fallback ? " · fallback" : ""}
      </span>
      <span className="mono" style={{ color: "var(--cream-mute)" }}>{t}</span>
    </div>
  );
}

function Brain({ label, on, health, icon }: { label: string; on?: boolean; health?: DeepHealth; icon?: React.ReactNode }) {
  // Tri-state from the deep auth probe when present: green = verified authed, red = configured but
  // NOT authed, amber = configured but login couldn't be cheaply verified. Falls back to the old
  // configured-only boolean (green/gray) when the deep probe isn't available.
  const configured = health ? health.configured : !!on;
  let color = "#6b7280", text = "off"; // gray / not configured
  if (configured) {
    if (health && health.authed === true) { color = "#34d399"; text = "authed"; }
    else if (health && health.authed === false) { color = "#f87171"; text = "auth ✗"; }
    else if (health) { color = "#fbbf24"; text = "ready?"; }
    else { color = "#34d399"; text = "online"; }
  }
  const lit = configured;
  return (
    <div className="flex items-center gap-2" title={health?.detail ?? ""}>
      <span className="w-2 h-2 rounded-full" style={{ background: color, boxShadow: lit ? `0 0 8px ${color}` : "none" }} />
      {icon}
      <span style={{ color: lit ? "var(--cream)" : "var(--cream-mute)" }}>{label}</span>
      <span className="ml-auto text-[11px]" style={{ color }}>{text}</span>
    </div>
  );
}
