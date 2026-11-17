"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Bot, Cpu, Sparkles, RefreshCw, Search, Library, Blocks, Users2, Eye, Pin } from "lucide-react";

interface Agent { id: string; name: string; description?: string; role: string; engine: string; color?: string; active: boolean; source: string; sourceId?: string; type?: string; skills?: string[]; }
interface Skill { id: string; name: string; description?: string; kind: string; source: string; sourceId?: string; active: boolean; }

const engineIcon: Record<string, React.ReactNode> = { claude: <Sparkles size={12} />, lmstudio: <Cpu size={12} />, hermes: <Bot size={12} />, codex: <Bot size={12} />, antigravity: <Bot size={12} /> };
const kindColor: Record<string, string> = { skill: "#22d3ee", command: "#34d399", soul: "#f472b6" };
type Tab = "team" | "library" | "skills";

export default function AgentsPage() {
  const [tab, setTab] = useState<Tab>("team");
  const [team, setTeam] = useState<Agent[]>([]);
  const [counts, setCounts] = useState<{ agents: number; skills: number; commands: number; souls: number } | null>(null);
  const [importing, setImporting] = useState(false);

  const loadTeam = useCallback(async () => {
    const j = await fetch("/api/friday/agents").then((r) => r.json());
    setTeam((j.agents ?? []).filter((a: Agent) => a.source === "builtin"));
  }, []);
  useEffect(() => { loadTeam(); }, [loadTeam]);

  async function runImport() {
    setImporting(true);
    try {
      const r = await fetch("/api/friday/registry/scan", { method: "POST" }).then((x) => x.json());
      setCounts(r);
      loadTeam();
    } finally { setImporting(false); }
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <Bot size={22} style={{ color: "#f472b6" }} />
        <h1 className="text-2xl tracking-tight" style={{ fontFamily: "'Bricolage Grotesque', sans-serif", color: "var(--cream)" }}>Agents & Skills</h1>
        <button onClick={runImport} disabled={importing}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] disabled:opacity-50"
          style={{ background: "rgba(168,85,247,0.16)", color: "#22d3ee" }}>
          <RefreshCw size={14} className={importing ? "animate-spin" : ""} /> {importing ? "Importing…" : "Import / Refresh"}
        </button>
      </div>
      <p className="text-[13px] mb-4" style={{ color: "var(--cream-mute)" }}>
        Your Claude, Multica &amp; marketing agents/skills — importable and usable from every engine.
        {counts && <span style={{ color: "var(--cream-dim)" }}> Imported {counts.agents} agents · {counts.skills} skills · {counts.commands} commands · {counts.souls} souls.</span>}
      </p>

      {/* tabs */}
      <div className="flex gap-1 mb-5 p-1 rounded-xl w-fit" style={{ background: "rgba(255,255,255,0.03)" }}>
        <TabBtn active={tab === "team"} onClick={() => setTab("team")} icon={<Users2 size={14} />} label="Team" />
        <TabBtn active={tab === "library"} onClick={() => setTab("library")} icon={<Library size={14} />} label="Agent Library" />
        <TabBtn active={tab === "skills"} onClick={() => setTab("skills")} icon={<Blocks size={14} />} label="Skills" />
      </div>

      {tab === "team" && <TeamTab agents={team} reload={loadTeam} />}
      {tab === "library" && <LibraryTab />}
      {tab === "skills" && <SkillsTab team={team} />}
    </div>
  );
}

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] transition"
      style={{ background: active ? "rgba(168,85,247,0.18)" : "transparent", color: active ? "#22d3ee" : "var(--cream-dim)" }}>
      {icon}{label}
    </button>
  );
}

// ── Team (builtin roster) ────────────────────────────────────────────────
function TeamTab({ agents, reload }: { agents: Agent[]; reload: () => void }) {
  async function toggle(a: Agent) {
    await fetch("/api/friday/agents", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: a.id, patch: { active: !a.active } }) });
    reload();
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {agents.map((a) => (
        <motion.div key={a.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border p-5" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)", opacity: a.active ? 1 : 0.55 }}>
          <div className="flex items-start justify-between mb-3">
            <div className="grid place-items-center w-11 h-11 rounded-xl" style={{ background: `${a.color ?? "#22d3ee"}22`, color: a.color ?? "#22d3ee" }}>
              {a.role === "orchestrator" ? <Sparkles size={20} /> : <Bot size={20} />}
            </div>
            <button onClick={() => toggle(a)} className="relative w-10 h-6 rounded-full transition" style={{ background: a.active ? "rgba(52,211,153,0.4)" : "rgba(255,255,255,0.1)" }}>
              <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all" style={{ left: a.active ? "18px" : "2px" }} />
            </button>
          </div>
          <h2 className="text-[16px] mb-0.5" style={{ color: "var(--cream)" }}>{a.name}</h2>
          <p className="text-[12px] mb-2 capitalize" style={{ color: "var(--cream-mute)" }}>{a.role.replace("-", " / ")}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-lg" style={{ background: "rgba(255,255,255,0.05)", color: "var(--cream-dim)" }}>{engineIcon[a.engine]} {a.engine}</span>
            {(a.skills?.length ?? 0) > 0 && <span className="text-[11px] px-2 py-0.5 rounded-lg" style={{ background: "rgba(168,85,247,0.12)", color: "#22d3ee" }}>{a.skills!.length} skill{a.skills!.length !== 1 ? "s" : ""}</span>}
          </div>
        </motion.div>
      ))}
    </div>
  );
}

// ── Agent Library (imported) ─────────────────────────────────────────────
function LibraryTab() {
  const [q, setQ] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<{ agent: Agent; body: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      const j = await fetch(`/api/friday/registry/library?q=${encodeURIComponent(q)}&limit=60`).then((r) => r.json());
      setAgents(j.agents ?? []); setTotal(j.total ?? 0);
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  async function view(a: Agent) {
    const j = await fetch(`/api/friday/registry/library?id=${encodeURIComponent(a.id)}`).then((r) => r.json());
    setOpen({ agent: a, body: j.body ?? "" });
  }
  async function activate(a: Agent) {
    await fetch("/api/friday/agents", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: a.id, patch: { active: !a.active } }) });
    setAgents((xs) => xs.map((x) => (x.id === a.id ? { ...x, active: !x.active } : x)));
  }

  return (
    <div>
      <SearchBar q={q} setQ={setQ} placeholder={`Search ${total} imported agents…`} />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mt-4">
        {agents.map((a) => (
          <div key={a.id} className="rounded-xl border p-4" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.05)", color: "var(--cream-mute)" }}>{a.sourceId}</span>
              <button onClick={() => activate(a)} className="text-[11px] px-2 py-0.5 rounded" style={{ background: a.active ? "rgba(52,211,153,0.18)" : "rgba(255,255,255,0.06)", color: a.active ? "#34d399" : "var(--cream-dim)" }}>{a.active ? "On team" : "Activate"}</button>
            </div>
            <h3 className="text-[14px] mb-1" style={{ color: "var(--cream)" }}>{a.name}</h3>
            <p className="text-[12px] line-clamp-2 mb-2" style={{ color: "var(--cream-mute)" }}>{a.description}</p>
            <button onClick={() => view(a)} className="flex items-center gap-1 text-[11px]" style={{ color: "#22d3ee" }}><Eye size={12} /> View prompt</button>
          </div>
        ))}
      </div>
      {open && <Viewer title={open.agent.name} body={open.body} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ── Skills ───────────────────────────────────────────────────────────────
function SkillsTab({ team }: { team: Agent[] }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<{ skill: Skill; body: string } | null>(null);
  const [pinFor, setPinFor] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      const j = await fetch(`/api/friday/registry/skills?q=${encodeURIComponent(q)}&kind=${kind}&limit=80`).then((r) => r.json());
      setSkills(j.skills ?? []); setTotal(j.total ?? 0);
    }, 180);
    return () => clearTimeout(t);
  }, [q, kind]);

  async function view(s: Skill) {
    const j = await fetch(`/api/friday/registry/skills?id=${encodeURIComponent(s.id)}`).then((r) => r.json());
    setOpen({ skill: s, body: j.body ?? "" });
  }
  async function pin(skillId: string, agentId: string) {
    await fetch("/api/friday/registry/attach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId, skillId, on: true }) });
    setPinFor(null);
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <SearchBar q={q} setQ={setQ} placeholder={`Search ${total} skills…`} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="bg-transparent text-[13px] rounded-lg px-3 py-2 outline-none" style={{ border: "1px solid var(--line-soft)", color: "var(--cream-dim)" }}>
          <option value="">All</option><option value="skill">Skills</option><option value="command">Commands</option><option value="soul">Souls</option>
        </select>
      </div>
      <div className="mt-4 rounded-2xl border divide-y" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
        {skills.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-4 py-2.5" style={{ borderColor: "var(--line-soft)" }}>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: kindColor[s.kind] ?? "#94a3b8" }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] truncate" style={{ color: "var(--cream)" }}>{s.name}</span>
                <span className="text-[10px] px-1.5 rounded shrink-0" style={{ background: "rgba(255,255,255,0.05)", color: "var(--cream-mute)" }}>{s.sourceId}</span>
              </div>
              <p className="text-[11px] truncate" style={{ color: "var(--cream-mute)" }}>{s.description}</p>
            </div>
            <button onClick={() => view(s)} className="text-[11px] shrink-0" style={{ color: "#22d3ee" }}><Eye size={13} /></button>
            <div className="relative shrink-0">
              <button onClick={() => setPinFor(pinFor === s.id ? null : s.id)} className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg" style={{ background: "rgba(255,255,255,0.05)", color: "var(--cream-dim)" }}><Pin size={11} /> Pin</button>
              {pinFor === s.id && (
                <div className="absolute right-0 mt-1 z-20 rounded-lg border p-1 min-w-[160px]" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
                  {team.map((a) => (
                    <button key={a.id} onClick={() => pin(s.id, a.id)} className="block w-full text-left px-2 py-1.5 text-[12px] rounded hover:bg-[rgba(255,255,255,0.05)]" style={{ color: "var(--cream-dim)" }}>{a.name}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {open && <Viewer title={open.skill.name} body={open.body} onClose={() => setOpen(null)} />}
    </div>
  );
}

function SearchBar({ q, setQ, placeholder }: { q: string; setQ: (v: string) => void; placeholder: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border px-3 py-2 flex-1" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
      <Search size={15} style={{ color: "var(--cream-mute)" }} />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="bg-transparent outline-none text-[14px] flex-1" style={{ color: "var(--cream)" }} />
    </div>
  );
}

function Viewer({ title, body, onClose }: { title: string; body: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-6" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="rounded-2xl border max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }} onClick={(e) => e.stopPropagation()}>
        <h3 className="text-[17px] mb-3" style={{ color: "var(--cream)" }}>{title}</h3>
        <pre className="text-[12px] whitespace-pre-wrap leading-relaxed" style={{ color: "var(--cream-dim)", fontFamily: "'JetBrains Mono', monospace" }}>{body || "(empty)"}</pre>
      </div>
    </div>
  );
}
