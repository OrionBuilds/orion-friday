"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, ShieldAlert, Check, X, Monitor, Maximize2, Minimize2 } from "lucide-react";
import FridayReactor, { type Phase } from "@/components/FridayReactor";

interface Msg { role: "user" | "friday"; text: string; ts: number; }
interface Approval { id: string; action: string; risk: string; }
interface LogRow { id: string; ts: string; event: string; level: string; data?: Record<string, unknown>; }
interface ChatResult { reply: string; project?: { name: string }; tasks?: unknown[]; approvals?: Approval[]; }

const riskColor: Record<string, string> = { low: "#34d399", medium: "#fbbf24", high: "#fb923c", critical: "#f87171" };

export default function FridayPage() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  // Voice (mic in, spoken replies) is CLARA-only by decision — FRIDAY stays chat/email/text.
  // The reactor keeps its idle/thinking states as a status indicator; it no longer listens.
  const [phase, setPhase] = useState<Phase>("idle");
  const [wall, setWall] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [feed, setFeed] = useState<LogRow[]>([]);

  const levelRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  // config + polling
  const refresh = useCallback(async () => {
    try {
      const [a, f] = await Promise.all([
        fetch("/api/friday/approve").then((r) => r.json()),
        fetch("/api/friday/feed?limit=30").then((r) => r.json()),
      ]);
      setApprovals(a.approvals ?? []); setFeed(f.logs ?? []);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t);
  }, [refresh]);

  // Synthetic level pulse while thinking, so the reactor still reads as "working" — the mic no
  // longer drives this ref (voice input is gone), it just idles/thinks now.
  useEffect(() => {
    let raf = 0, t = 0;
    const tick = () => {
      t += 0.05;
      if (phaseRef.current === "thinking") levelRef.current = 0.18 + 0.10 * Math.abs(Math.sin(t));
      else levelRef.current *= 0.9;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  async function send(text?: string) {
    const message = (text ?? input).trim();
    if (!message) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: message, ts: Date.now() }]);
    setPhase("thinking");
    try {
      const history = msgs.slice(-10).map((m) => ({ role: m.role === "user" ? "user" : "friday", text: m.text }));
      const httpRes = await fetch("/api/friday/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, history }) });
      // Checked BEFORE .json(): a non-OK response (most often Cloudflare Access rejecting a stale
      // session cookie on this fetch while page navigation still succeeds) comes back as an HTML
      // block page. Parsing that as JSON throws "Unexpected token '<'", which used to reach the
      // catch below and get shown verbatim — true, but useless for saying what to do about it.
      if (!httpRes.ok) {
        if (httpRes.status === 401 || httpRes.status === 403) {
          throw new Error(`blocked before reaching me (HTTP ${httpRes.status}) — this usually means your Cloudflare Access session has gone stale. Reload the page.`);
        }
        // A 503 from this route is FRIDAY's own "I couldn't plan that" turn (JSON with a reply), not an
        // outage — show her words. Anything else, or a body that isn't that JSON, stays an HTTP error.
        const failedTurn = httpRes.status === 503
          ? await httpRes.json().then((j: ChatResult & { failed?: boolean }) => (j?.failed && typeof j.reply === "string" ? j.reply : null)).catch(() => null)
          : null;
        if (failedTurn) {
          setMsgs((m) => [...m, { role: "friday", text: failedTurn, ts: Date.now() }]);
          return;
        }
        throw new Error(`the server returned HTTP ${httpRes.status}`);
      }
      const res: ChatResult = await httpRes.json();
      const reply = res.reply || "(no reply)";
      setMsgs((m) => [...m, { role: "friday", text: reply, ts: Date.now() }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "friday", text: `I hit a snag: ${e instanceof Error ? e.message : String(e)}`, ts: Date.now() }]);
    } finally {
      setPhase("idle");
      refresh();
    }
  }

  async function decide(id: string, decision: "approved" | "rejected") {
    setApprovals((a) => a.filter((x) => x.id !== id));
    await fetch("/api/friday/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, decision }) });
    refresh();
  }

  const statusText = phase === "thinking" ? "Working on it…" : "Type below.";

  return (
    <>
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
      {/* ── Reactor command column ── */}
      <div className="flex flex-col items-center">
        <div className="w-full flex items-center gap-3 mb-2">
          <div>
            <h1 className="text-2xl tracking-tight" style={{ fontFamily: "'Bricolage Grotesque', sans-serif", color: "var(--cream)" }}>FRIDAY</h1>
            <p className="text-[12px] mono tracking-[0.2em]" style={{ color: "var(--cream-mute)" }}>NEURAL LINK · ONLINE</p>
          </div>
          <button onClick={() => setWall(true)} title="Wall mode — full-screen" className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px]" style={{ background: "rgba(255,255,255,0.04)", color: "var(--cream-dim)" }}>
            <Maximize2 size={14} /> Wall
          </button>
        </div>

        {/* the reactor — status indicator only now (idle/thinking); no tap-to-talk */}
        <div className="relative my-4 grid place-items-center" style={{ width: 320, height: 320 }}>
          <FridayReactor phase={phase} levelRef={levelRef} size={320} />
        </div>
        <p className="text-[13px] mb-2" style={{ color: phase === "idle" ? "var(--cream-mute)" : "#22d3ee" }}>{statusText}</p>
        <div className="mb-3" />

        {/* interaction modes (SMS + phone calls are handled by FRIDAY in the background) */}
        <div className="flex items-center gap-2 mb-5">
          <Chan icon={<Monitor size={13} />} label="Web" on={true} />
        </div>

        {/* transcript */}
        <div className="w-full max-w-2xl space-y-2 mb-4 max-h-[240px] overflow-y-auto">
          <AnimatePresence initial={false}>
            {msgs.slice(-6).map((m) => (
              <motion.div key={m.ts} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed" style={m.role === "user" ? { background: "rgba(168,85,247,0.16)", color: "var(--cream)", border: "1px solid rgba(168,85,247,0.3)" } : { background: "rgba(255,255,255,0.03)", color: "var(--cream)", border: "1px solid var(--line-soft)" }}>
                  {m.role === "friday" && <span className="text-[10px] uppercase tracking-[0.2em] mr-2" style={{ color: "#22d3ee" }}>FRIDAY</span>}{m.text}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* input */}
        <div className="w-full max-w-2xl flex items-center gap-2 rounded-2xl border p-2" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="Tell FRIDAY what you need…" className="flex-1 bg-transparent outline-none text-[14px] px-2" style={{ color: "var(--cream)" }} />
          <motion.button whileTap={{ scale: 0.92 }} onClick={() => send()} disabled={phase === "thinking" || !input.trim()} className="grid place-items-center w-10 h-10 rounded-xl disabled:opacity-40" style={{ background: "linear-gradient(135deg,#22d3ee,#7c3aed)", color: "white" }}>
            <Send size={16} />
          </motion.button>
        </div>
      </div>

      {/* ── Ops rail ── */}
      <div className="space-y-5">
        <div className="rounded-2xl border p-4" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert size={15} style={{ color: "#fb923c" }} />
            <h2 className="text-[13px] uppercase tracking-[0.18em]" style={{ color: "var(--cream-dim)" }}>Approvals</h2>
            {approvals.length > 0 && <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full" style={{ background: "rgba(251,146,60,0.16)", color: "#fb923c" }}>{approvals.length}</span>}
          </div>
          {approvals.length === 0 ? <p className="text-[12px]" style={{ color: "var(--cream-mute)" }}>Nothing waiting. FRIDAY pauses here before anything client-facing, destructive, or costly.</p> : (
            <div className="space-y-2">
              {approvals.map((a) => (
                <div key={a.id} className="rounded-xl p-3" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--line-soft)" }}>
                  <span className="text-[10px] uppercase px-1.5 py-0.5 rounded" style={{ background: `${riskColor[a.risk]}22`, color: riskColor[a.risk] }}>{a.risk}</span>
                  <p className="text-[13px] my-2" style={{ color: "var(--cream)" }}>{a.action}</p>
                  <div className="flex gap-2">
                    <button onClick={() => decide(a.id, "approved")} className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[12px]" style={{ background: "rgba(52,211,153,0.16)", color: "#34d399" }}><Check size={13} /> Approve</button>
                    <button onClick={() => decide(a.id, "rejected")} className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[12px]" style={{ background: "rgba(248,113,113,0.14)", color: "#f87171" }}><X size={13} /> Reject</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-2xl border p-4" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
          <h2 className="text-[13px] uppercase tracking-[0.18em] mb-3" style={{ color: "var(--cream-dim)" }}>Activity</h2>
          <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
            {feed.length === 0 && <p className="text-[12px]" style={{ color: "var(--cream-mute)" }}>No activity yet.</p>}
            {feed.map((l) => (
              <div key={l.id} className="flex items-start gap-2 text-[12px]">
                <span className="mt-1 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: l.level === "error" ? "#f87171" : "#22d3ee" }} />
                <span style={{ color: "var(--cream-dim)" }}><span className="mono" style={{ color: "var(--cream-mute)" }}>{new Date(l.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span> {l.event}{typeof l.data?.task === "string" ? ` — ${l.data.task}` : ""}{typeof l.data?.summary === "string" ? <span style={{ color: "var(--cream-mute)" }}> · {l.data.summary.slice(0, 80)}</span> : null}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>

    {wall && (
      <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center px-6" style={{ background: "radial-gradient(circle at 50% 38%, #0b0614, #000)" }}>
        <button onClick={() => setWall(false)} className="absolute top-5 right-5 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px]" style={{ background: "rgba(255,255,255,0.06)", color: "var(--cream-dim)" }}><Minimize2 size={14} /> Exit</button>
        <div className="mono text-[12px] tracking-[0.4em] mb-6" style={{ color: "#22d3ee" }}>FRIDAY · NEURAL LINK · ONLINE</div>
        <FridayReactor phase={phase} levelRef={levelRef} size={460} />
        <p className="text-[15px] mt-6 mb-2" style={{ color: phase === "idle" ? "var(--cream-mute)" : "#22d3ee" }}>{statusText}</p>
        <div className="mb-5" />
        <div className="w-full max-w-xl flex items-center gap-2 rounded-2xl border p-2" style={{ borderColor: "var(--line-soft)", background: "rgba(255,255,255,0.03)" }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(); } }} placeholder="Talk or type…" className="flex-1 bg-transparent outline-none text-[15px] px-2" style={{ color: "var(--cream)" }} autoFocus />
          <motion.button whileTap={{ scale: 0.92 }} onClick={() => send()} disabled={phase === "thinking" || !input.trim()} className="grid place-items-center w-10 h-10 rounded-xl disabled:opacity-40" style={{ background: "linear-gradient(135deg,#22d3ee,#7c3aed)", color: "white" }}><Send size={16} /></motion.button>
        </div>
        {msgs.length > 0 && <p className="text-[13px] mt-6 max-w-xl text-center" style={{ color: "var(--cream-dim)" }}>{msgs[msgs.length - 1].text.slice(0, 220)}</p>}
      </div>
    )}
    </>
  );
}

function Chan({ icon, label, on }: { icon: React.ReactNode; label: string; on: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px]" style={{ background: on ? "rgba(52,211,153,0.12)" : "rgba(255,255,255,0.04)", color: on ? "#34d399" : "var(--cream-mute)", border: `1px solid ${on ? "rgba(52,211,153,0.25)" : "var(--line-soft)"}` }} title={on ? `${label} channel active` : `${label} not configured`}>
      {icon}{label}
    </span>
  );
}
