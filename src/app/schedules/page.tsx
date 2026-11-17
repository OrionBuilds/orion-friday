"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { CalendarClock, Plus, Loader2, Pencil, Trash2, Play, Pause } from "lucide-react";
import ScheduleModal, { type Schedule } from "@/components/ScheduleModal";

interface Project { id: string; name: string; clientId: string; status: string; }
interface Client { id: string; name: string; }

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function cadence(s: Schedule): string {
  const t = `${String(s.hour).padStart(2, "0")}:${String(s.minute ?? 0).padStart(2, "0")}`;
  if (s.freq === "daily") return `Daily Â· ${t}`;
  if (s.freq === "weekly") return `Weekly Â· ${DOW[s.dayOfWeek ?? 1]} ${t}`;
  return `Monthly Â· day ${s.dayOfMonth ?? 1} Â· ${t}`;
}
function nextRun(s: Schedule): string {
  if (!s.enabled) return "paused";
  const from = new Date();
  for (let i = 0; i < 400; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, s.hour, s.minute ?? 0, 0, 0);
    if (d <= from) continue;
    if (s.freq === "weekly" && d.getDay() !== (s.dayOfWeek ?? 1)) continue;
    if (s.freq === "monthly") { const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); if (d.getDate() !== Math.min(s.dayOfMonth ?? 1, last)) continue; }
    return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  return "â€”";
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, p, c] = await Promise.all([
      fetch("/api/friday/schedules").then((r) => r.json()),
      fetch("/api/friday/projects").then((r) => r.json()),
      fetch("/api/friday/clients").then((r) => r.json()),
    ]);
    setSchedules(s.schedules ?? []);
    setProjects(p.projects ?? []);
    setClients(c.clients ?? []);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  async function toggle(s: Schedule) {
    setBusy(s.id);
    try { await fetch("/api/friday/schedules", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: s.id, patch: { enabled: !s.enabled } }) }); load(); }
    finally { setBusy(null); }
  }
  async function del(s: Schedule) {
    if (!confirm(`Delete schedule "${s.name}"?`)) return;
    setBusy(s.id);
    try { await fetch(`/api/friday/schedules?id=${s.id}`, { method: "DELETE" }); load(); }
    finally { setBusy(null); }
  }

  const projName = (id?: string) => projects.find((p) => p.id === id)?.name ?? "â€”";
  const cliName = (id?: string) => clients.find((c) => c.id === id)?.name ?? "â€”";
  const target = (s: Schedule) => s.targetType === "project" ? projName(s.projectId) : s.targetType === "client" ? `${cliName(s.clientId)} (all projects)` : "All active projects";

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <CalendarClock size={22} style={{ color: "#06b6d4" }} />
        <h1 className="text-2xl tracking-tight" style={{ fontFamily: "'Bricolage Grotesque', sans-serif", color: "var(--cream)" }}>Schedules</h1>
        <button onClick={() => setEditing("new")} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px]" style={{ background: "rgba(212,165,116,0.16)", color: "#06b6d4" }}><Plus size={15} /> New schedule</button>
      </div>
      <p className="text-[12px] mb-6" style={{ color: "var(--cream-mute)" }}>Recurring agent work â€” each fire creates + dispatches a task. Analysis (audits, QA, digests) auto-runs; anything outward (deploy, client-send) still waits for your approval.</p>

      {editing && <ScheduleModal schedule={editing === "new" ? null : editing} projects={projects} clients={clients} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {schedules.map((s) => (
          <motion.div key={s.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border p-5" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)", opacity: s.enabled ? 1 : 0.62 }}>
            <div className="flex items-start justify-between mb-1.5">
              <h2 className="text-[15px]" style={{ color: "var(--cream)" }}>{s.name}</h2>
              <span className="text-[10px] uppercase px-2 py-0.5 rounded-full" style={{ background: s.enabled ? "rgba(52,211,153,0.16)" : "rgba(148,163,184,0.16)", color: s.enabled ? "#34d399" : "#94a3b8" }}>{s.enabled ? "on" : "paused"}</span>
            </div>
            <div className="text-[12px] mb-0.5" style={{ color: "var(--gold)" }}>{cadence(s)}</div>
            <div className="text-[12px]" style={{ color: "var(--cream-mute)" }}>{target(s)} Â· <span style={{ color: "var(--cream-dim)" }}>{s.assignee}</span></div>
            <div className="text-[11px] mt-2" style={{ color: "var(--cream-mute)" }}>
              Next: {nextRun(s)}{s.lastRunAt ? ` Â· Last: ${new Date(s.lastRunAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}${s.lastStatus ? ` (${s.lastStatus})` : ""}` : " Â· never run"}
            </div>
            <div className="mt-3 pt-3 border-t flex items-center gap-1.5" style={{ borderColor: "var(--line-soft)" }}>
              <button onClick={() => toggle(s)} disabled={busy === s.id} title={s.enabled ? "Pause" : "Resume"} className="grid place-items-center w-7 h-7 rounded-lg disabled:opacity-40" style={{ color: s.enabled ? "#fbbf24" : "#34d399", background: "rgba(255,255,255,0.05)" }}>{busy === s.id ? <Loader2 size={13} className="animate-spin" /> : s.enabled ? <Pause size={13} /> : <Play size={13} />}</button>
              <button onClick={() => setEditing(s)} title="Edit" className="grid place-items-center w-7 h-7 rounded-lg" style={{ color: "var(--cream-dim)", background: "rgba(255,255,255,0.05)" }}><Pencil size={13} /></button>
              <button onClick={() => del(s)} disabled={busy === s.id} title="Delete" className="grid place-items-center w-7 h-7 rounded-lg disabled:opacity-40" style={{ color: "#f87171", background: "rgba(248,113,113,0.14)" }}><Trash2 size={13} /></button>
              {s.lastRunId && <a href={`/live`} className="ml-auto text-[11px]" style={{ color: "#22d3ee" }}>Watch live â†’</a>}
            </div>
          </motion.div>
        ))}
        {schedules.length === 0 && <p className="text-[13px]" style={{ color: "var(--cream-mute)" }}>No schedules yet. Create one, or just tell FRIDAY &ldquo;every Monday 9am run an SEO audit on &lt;project&gt;&rdquo;.</p>}
      </div>
    </div>
  );
}
