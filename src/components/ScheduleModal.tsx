"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { CalendarClock, X, Loader2, CheckCircle2 } from "lucide-react";

export interface Schedule {
  id: string; name: string; enabled: boolean;
  targetType: "project" | "client" | "all-active"; projectId?: string; clientId?: string;
  assignee: string; title: string; description?: string; risk?: string;
  freq: "daily" | "weekly" | "monthly"; dayOfWeek?: number; dayOfMonth?: number; hour: number; minute?: number;
  lastRunAt?: string; lastRunId?: string; lastStatus?: string;
}
interface Project { id: string; name: string; clientId?: string; status?: string; }
interface Client { id: string; name: string; }

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ROLES = ["seo", "qa", "debug", "dev", "devops", "marketing", "support", "research-qa", "pm", "sales", "designer", "automation"];

// One-click templates for the built-for work types.
const TEMPLATES: { label: string; make: () => Partial<Schedule> }[] = [
  { label: "Weekly SEO audit", make: () => ({ name: "Weekly SEO audit", assignee: "seo", title: "SEO audit — {project}", description: "Run a full technical + on-page + content + GEO SEO audit and deliver a prioritized report.", freq: "weekly", dayOfWeek: 1, hour: 9 }) },
  { label: "Nightly QA review", make: () => ({ name: "Nightly QA review", assignee: "qa", title: "QA + regression review — {project}", description: "Review the repo for correctness, security, and regressions; report blocker / should-fix / nit findings with file references.", freq: "daily", hour: 2 }) },
  { label: "Weekly dependency + CVE audit", make: () => ({ name: "Weekly dependency + CVE audit", assignee: "debug", title: "Dependency + CVE audit — {project}", description: "Check for outdated dependencies and known CVEs; list recommended upgrades with risk notes.", freq: "weekly", dayOfWeek: 1, hour: 6 }) },
  { label: "Weekly client status digest", make: () => ({ name: "Weekly client status digest", assignee: "support", title: "Weekly status digest — {project}", description: "Draft a concise client-ready status update from open tasks, recent deliverables, and deadlines. DRAFT only — do not send.", freq: "weekly", dayOfWeek: 5, hour: 8, targetType: "all-active" }) },
];

// Create or edit a recurring Schedule. `schedule` = the record to edit, or null for new; `initial`
// prefills a new schedule (e.g. { targetType:"project", projectId } from a project board).
export default function ScheduleModal({ schedule, initial, projects, clients, onClose, onSaved }: {
  schedule: Schedule | null; initial?: Partial<Schedule>; projects: Project[]; clients: Client[];
  onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState<Partial<Schedule>>(schedule ?? { name: "", enabled: true, targetType: "project", assignee: "seo", title: "", freq: "weekly", dayOfWeek: 1, hour: 9, risk: "low", ...initial });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof Schedule, v: unknown) => setF((s) => ({ ...s, [k]: v }));

  function applyTemplate(t: Partial<Schedule>) { setF((s) => ({ ...s, targetType: "project", enabled: true, risk: "low", ...initial, ...t })); }

  async function save() {
    if (!(f.name ?? "").trim() || !(f.title ?? "").trim()) { alert("Name and task title are required."); return; }
    if (f.targetType === "project" && !f.projectId) { alert("Pick a target project."); return; }
    if (f.targetType === "client" && !f.clientId) { alert("Pick a target client."); return; }
    setSaving(true);
    try {
      const method = schedule ? "PATCH" : "POST";
      const body = schedule ? JSON.stringify({ id: schedule.id, patch: f }) : JSON.stringify(f);
      const r = await fetch("/api/friday/schedules", { method, headers: { "Content-Type": "application/json" }, body }).then((x) => x.json());
      if (r.error) { alert(`Couldn't save: ${r.error}`); setSaving(false); return; }
      onSaved();
    } catch (e) { alert(`Couldn't save: ${String(e)}`); setSaving(false); }
  }

  const fld = "w-full bg-transparent border rounded-lg px-3 py-2 text-[13px] outline-none";
  const fs = { borderColor: "var(--line-soft)", color: "var(--cream)" } as const;
  const lbl = "text-[11px] uppercase tracking-wider mb-1 block";
  const ls = { color: "var(--cream-mute)" } as const;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <motion.div initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} onClick={(e) => e.stopPropagation()} className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border p-6" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
        <div className="flex items-center gap-2 mb-4">
          <div className="grid place-items-center w-9 h-9 rounded-xl" style={{ background: "rgba(212,165,116,0.16)", color: "#06b6d4" }}><CalendarClock size={17} /></div>
          <h2 className="text-[17px]" style={{ color: "var(--cream)", fontFamily: "'Bricolage Grotesque', sans-serif" }}>{schedule ? "Edit schedule" : "New schedule"}</h2>
          <button onClick={onClose} className="ml-auto grid place-items-center w-8 h-8 rounded-lg" style={{ color: "var(--cream-mute)", background: "rgba(255,255,255,0.04)" }}><X size={16} /></button>
        </div>

        {!schedule && (
          <div className="mb-4">
            <span className={lbl} style={ls}>Start from a template</span>
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATES.map((t) => <button key={t.label} onClick={() => applyTemplate(t.make())} className="text-[11px] px-2.5 py-1.5 rounded-lg" style={{ background: "rgba(168,85,247,0.14)", color: "#22d3ee" }}>{t.label}</button>)}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div><span className={lbl} style={ls}>Name</span><input value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} className={fld} style={fs} /></div>

          <div className="grid grid-cols-2 gap-3">
            <div><span className={lbl} style={ls}>Runs on</span>
              <select value={f.targetType} onChange={(e) => set("targetType", e.target.value)} className={fld} style={fs}>
                <option value="project" style={{ background: "var(--bg-mid)" }}>A project</option>
                <option value="client" style={{ background: "var(--bg-mid)" }}>A client (all their projects)</option>
                <option value="all-active" style={{ background: "var(--bg-mid)" }}>All active projects</option>
              </select>
            </div>
            <div><span className={lbl} style={ls}>Agent</span>
              <select value={f.assignee} onChange={(e) => set("assignee", e.target.value)} className={fld} style={fs}>
                {ROLES.map((r) => <option key={r} value={r} style={{ background: "var(--bg-mid)" }}>{r}</option>)}
              </select>
            </div>
          </div>

          {f.targetType === "project" && (
            <div><span className={lbl} style={ls}>Project</span>
              <select value={f.projectId ?? ""} onChange={(e) => set("projectId", e.target.value)} className={fld} style={fs}>
                <option value="" style={{ background: "var(--bg-mid)" }}>— pick —</option>
                {projects.map((p) => <option key={p.id} value={p.id} style={{ background: "var(--bg-mid)" }}>{p.name}</option>)}
              </select>
            </div>
          )}
          {f.targetType === "client" && (
            <div><span className={lbl} style={ls}>Client</span>
              <select value={f.clientId ?? ""} onChange={(e) => set("clientId", e.target.value)} className={fld} style={fs}>
                <option value="" style={{ background: "var(--bg-mid)" }}>— pick —</option>
                {clients.map((c) => <option key={c.id} value={c.id} style={{ background: "var(--bg-mid)" }}>{c.name}</option>)}
              </select>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div><span className={lbl} style={ls}>Frequency</span>
              <select value={f.freq} onChange={(e) => set("freq", e.target.value)} className={fld} style={fs}>
                {["daily", "weekly", "monthly"].map((x) => <option key={x} value={x} style={{ background: "var(--bg-mid)" }}>{x}</option>)}
              </select>
            </div>
            {f.freq === "weekly" && (
              <div><span className={lbl} style={ls}>Day</span>
                <select value={f.dayOfWeek ?? 1} onChange={(e) => set("dayOfWeek", Number(e.target.value))} className={fld} style={fs}>
                  {DOW.map((d, i) => <option key={i} value={i} style={{ background: "var(--bg-mid)" }}>{d}</option>)}
                </select>
              </div>
            )}
            {f.freq === "monthly" && (
              <div><span className={lbl} style={ls}>Day #</span><input type="number" min={1} max={31} value={f.dayOfMonth ?? 1} onChange={(e) => set("dayOfMonth", Number(e.target.value))} className={fld} style={fs} /></div>
            )}
            <div><span className={lbl} style={ls}>Hour (0-23)</span><input type="number" min={0} max={23} value={f.hour ?? 9} onChange={(e) => set("hour", Number(e.target.value))} className={fld} style={fs} /></div>
          </div>

          <div><span className={lbl} style={ls}>Task title <span style={{ textTransform: "none" }}>(use {"{project}"} to insert the project name)</span></span><input value={f.title ?? ""} onChange={(e) => set("title", e.target.value)} placeholder="SEO audit — {project}" className={fld} style={fs} /></div>
          <div><span className={lbl} style={ls}>Task description / prompt</span><textarea value={f.description ?? ""} onChange={(e) => set("description", e.target.value)} rows={3} className={fld} style={fs} /></div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-[13px]" style={{ background: "rgba(255,255,255,0.05)", color: "var(--cream-dim)" }}>Cancel</button>
          <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] disabled:opacity-40" style={{ background: "rgba(52,211,153,0.16)", color: "#34d399" }}>{saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} {schedule ? "Save" : "Create"}</button>
        </div>
      </motion.div>
    </div>
  );
}
