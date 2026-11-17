"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Plug, Check, X, RefreshCw, Mail, Calendar, FolderOpen, Mic, Contact, Phone, MessageSquare, Loader2 } from "lucide-react";

interface AccountStat { hasToken: boolean; connected: boolean; email: string | null; signature?: boolean; signaturePreview?: string; }
interface GStatus { clientConfigured: boolean; hasToken: boolean; connected: boolean; email: string | null; accounts?: { owner: AccountStat; friday: AccountStat }; }
interface IngestItem { client: string; project: string; tasks: number; summary: string; }
interface PhoneStatus { configured: boolean; from?: string; ownerSet?: boolean; owner?: string; voiceUrl?: string | null; smsUrl?: string | null; wired?: boolean; pathWired?: boolean; reachable?: boolean; error?: string; }

export default function SettingsPage() {
  const [g, setG] = useState<GStatus | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [ingest, setIngest] = useState<{ meetings: number; tasksCreated: number; items: IngestItem[] } | null>(null);
  const [phone, setPhone] = useState<PhoneStatus | null>(null);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [wiring, setWiring] = useState(false);

  async function load() { setG(await fetch("/api/google/status").then((r) => r.json()).catch(() => null)); }
  async function loadPhone() { setPhone(await fetch("/api/friday/phone").then((r) => r.json()).catch(() => null)); }
  useEffect(() => { load(); loadPhone(); }, []);

  async function wirePhone() {
    const base = tunnelUrl.trim();
    if (!base) return;
    setWiring(true);
    try {
      const r = await fetch("/api/friday/phone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: base }) }).then((x) => x.json());
      if (r.error) alert(r.error); else setTunnelUrl("");
      await loadPhone();
    } finally { setWiring(false); }
  }

  async function runIngest() {
    setIngesting(true);
    try { setIngest(await fetch("/api/friday/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days: 14 }) }).then((r) => r.json())); }
    finally { setIngesting(false); }
  }

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <Plug size={22} style={{ color: "#60a5fa" }} />
        <h1 className="text-2xl tracking-tight" style={{ fontFamily: "'Bricolage Grotesque', sans-serif", color: "var(--cream)" }}>Integrations</h1>
      </div>

      {/* Google Workspace */}
      <div className="rounded-2xl border p-5 mb-5" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
        <div className="flex items-center gap-3 mb-3">
          <div className="grid place-items-center w-10 h-10 rounded-xl" style={{ background: "rgba(96,165,250,0.14)" }}>
            <span style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, color: "#60a5fa" }}>G</span>
          </div>
          <div>
            <h2 className="text-[16px]" style={{ color: "var(--cream)" }}>Google Workspace</h2>
            <p className="text-[12px]" style={{ color: "var(--cream-mute)" }}>Gmail · Calendar · Drive · Meet ingestion</p>
          </div>
        </div>

        {!g?.clientConfigured ? (
          <div className="text-[13px] leading-relaxed" style={{ color: "var(--cream-dim)" }}>
            <p className="mb-2">Add your Google OAuth client to <span className="mono">.env.local</span> (the same one your Orion project uses):</p>
            <pre className="text-[12px] p-3 rounded-lg mb-2 overflow-x-auto" style={{ background: "rgba(0,0,0,0.3)", color: "var(--cream-mute)" }}>{`GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…`}</pre>
            <p>Then in Google Cloud Console, add this authorized redirect URI to that OAuth client:</p>
            <pre className="text-[12px] p-3 rounded-lg mt-2 overflow-x-auto" style={{ background: "rgba(0,0,0,0.3)", color: "var(--cream-mute)" }}>http://localhost:3737/api/google/callback</pre>
            <button onClick={load} className="mt-3 text-[12px] flex items-center gap-1" style={{ color: "#60a5fa" }}><RefreshCw size={12} /> Re-check</button>
          </div>
        ) : (
          <div>
            {/* Two connected accounts: the owner (reads client email) + FRIDAY's workspace (replies from her address). */}
            <div className="flex flex-col gap-2 mb-4">
              <AccountRow label="Your Google" sub="Reads client email · Calendar · Drive · Meet" account="owner" stat={g.accounts?.owner ?? { hasToken: g.hasToken, connected: g.connected, email: g.email }} />
              <AccountRow label="FRIDAY's Google" sub="Sends client replies from her address (you CC'd)" account="friday" stat={g.accounts?.friday ?? { hasToken: false, connected: false, email: null }} />
            </div>
            <p className="text-[11px] mb-4" style={{ color: "var(--cream-mute)" }}>
              To connect FRIDAY's account, add her email as a <span style={{ color: "var(--cream-dim)" }}>Test User</span> on the OAuth consent screen (or publish the app), then click Connect while signed in as her.
            </p>
            {g.accounts?.owner?.connected ?? g.connected ? (
              <div>
                <div className="flex flex-wrap gap-2 mb-4">
                  <Cap icon={<Mail size={13} />} label="Gmail — client email" />
                  <Cap icon={<Calendar size={13} />} label="Calendar — scheduling" />
                  <Cap icon={<FolderOpen size={13} />} label="Drive — client folders" />
                  <Cap icon={<Mic size={13} />} label="Meet — transcript ingest" />
                  <Cap icon={<Contact size={13} />} label="Contacts — client autofill" />
                </div>
                <button onClick={runIngest} disabled={ingesting} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] disabled:opacity-50" style={{ background: "rgba(168,85,247,0.16)", color: "#22d3ee" }}>
                  <RefreshCw size={14} className={ingesting ? "animate-spin" : ""} /> {ingesting ? "Ingesting meetings…" : "Ingest recent meetings → tasks"}
                </button>
              </div>
            ) : null}
            {ingest && (
              <div className="mt-4 text-[13px]" style={{ color: "var(--cream-dim)" }}>
                <p className="mb-2" style={{ color: "var(--cream)" }}>Ingested {ingest.meetings} meeting(s) → {ingest.tasksCreated} task(s).</p>
                {ingest.items.map((it, i) => (
                  <div key={i} className="rounded-xl p-3 mb-2" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--line-soft)" }}>
                    <p style={{ color: "var(--cream)" }}>{it.client} · {it.project} — {it.tasks} task(s)</p>
                    <p className="text-[12px]" style={{ color: "var(--cream-mute)" }}>{it.summary}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Phone — Twilio SMS & Calls */}
      <div className="rounded-2xl border p-5 mb-5" style={{ borderColor: "var(--line-soft)", background: "var(--bg-mid)" }}>
        <div className="flex items-center gap-3 mb-3">
          <div className="grid place-items-center w-10 h-10 rounded-xl" style={{ background: "rgba(52,211,153,0.14)" }}><Phone size={18} style={{ color: "#34d399" }} /></div>
          <div>
            <h2 className="text-[16px]" style={{ color: "var(--cream)" }}>Phone — SMS &amp; Calls</h2>
            <p className="text-[12px]" style={{ color: "var(--cream-mute)" }}>Text or call FRIDAY on your Twilio number</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={loadPhone} title="Refresh" className="grid place-items-center w-8 h-8 rounded-lg" style={{ background: "rgba(255,255,255,0.05)", color: "var(--cream-mute)" }}><RefreshCw size={13} /></button>
            {phone?.configured
              ? phone.wired
                ? <span className="inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-lg" style={{ background: "rgba(52,211,153,0.16)", color: "#34d399" }}><Check size={13} /> Live</span>
                : <span className="inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-lg" style={{ background: "rgba(251,146,60,0.16)", color: "#fb923c" }}><X size={13} /> Needs tunnel</span>
              : <span className="inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-lg" style={{ background: "rgba(255,255,255,0.05)", color: "var(--cream-mute)" }}><X size={13} /> Not configured</span>}
          </div>
        </div>

        {!phone?.configured ? (
          <div className="text-[13px] leading-relaxed" style={{ color: "var(--cream-dim)" }}>
            <p className="mb-2">Add your Twilio credentials to <span className="mono">.env.local</span>:</p>
            <pre className="text-[12px] p-3 rounded-lg overflow-x-auto" style={{ background: "rgba(0,0,0,0.3)", color: "var(--cream-mute)" }}>{`TWILIO_ACCOUNT_SID=…
TWILIO_AUTH_TOKEN=…
TWILIO_FROM_NUMBER=+1…
FRIDAY_OWNER_NUMBER=+1…   # your phone`}</pre>
          </div>
        ) : (
          <div className="text-[13px]" style={{ color: "var(--cream-dim)" }}>
            <div className="flex flex-wrap gap-2 mb-3">
              <Cap icon={<MessageSquare size={13} />} label={`Number ${phone.from ?? ""}`} />
              <Cap icon={<Phone size={13} />} label={phone.ownerSet ? `Owner ${phone.owner ?? ""}` : "Owner number not set"} />
            </div>
            {phone.wired ? (
              <p className="mb-3 flex items-center gap-1.5" style={{ color: "#34d399" }}><Check size={14} /> Live — texting/calling {phone.from} reaches FRIDAY (keep the tunnel running).</p>
            ) : phone.pathWired ? (
              <p className="mb-3" style={{ color: "#fb923c" }}>The webhook is set but its tunnel isn&apos;t answering — the quick-tunnel URL changes each restart. Start the tunnel again and re-point it below.</p>
            ) : (
              <p className="mb-3" style={{ color: "#fb923c" }}>Inbound texts/calls won&apos;t reach FRIDAY until the webhooks point at a live public tunnel to this server.</p>
            )}
            <ol className="list-decimal ml-5 space-y-1 mb-3 text-[12.5px]" style={{ color: "var(--cream-dim)" }}>
              <li>In a terminal, run: <span className="mono" style={{ color: "var(--cream)" }}>cloudflared tunnel --url http://localhost:3737</span></li>
              <li>Copy the <span className="mono">https://…trycloudflare.com</span> URL it prints.</li>
              <li>Paste it below and click <em>Point webhooks here</em>.</li>
            </ol>
            <div className="flex items-center gap-2">
              <input value={tunnelUrl} onChange={(e) => setTunnelUrl(e.target.value)} placeholder="https://your-tunnel.trycloudflare.com" className="flex-1 bg-transparent border rounded-lg px-3 py-2 text-[13px] outline-none focus:border-[rgba(52,211,153,0.5)]" style={{ borderColor: "var(--line-soft)", color: "var(--cream)" }} />
              <button onClick={wirePhone} disabled={wiring || !tunnelUrl.trim()} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] disabled:opacity-40" style={{ background: "rgba(52,211,153,0.16)", color: "#34d399" }}>{wiring ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Point webhooks here</button>
            </div>
            {phone.smsUrl && <p className="text-[11px] mt-2 truncate" style={{ color: "var(--cream-mute)" }}>Current SMS webhook: {phone.smsUrl}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function Cap({ icon, label }: { icon: React.ReactNode; label: string }) {
  return <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px]" style={{ background: "rgba(52,211,153,0.1)", color: "#34d399", border: "1px solid rgba(52,211,153,0.22)" }}>{icon}{label}</span>;
}

// One connected-account row: label + status chip + a Connect/Reconnect link for that account slot.
function AccountRow({ label, sub, account, stat }: { label: string; sub: string; account: "owner" | "friday"; stat: AccountStat }) {
  return (
    <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--line-soft)" }}>
      <div className="min-w-0">
        <p className="text-[13px]" style={{ color: "var(--cream)" }}>{label}</p>
        <p className="text-[11px] truncate" style={{ color: "var(--cream-mute)" }}>{stat.connected && stat.email ? stat.email : sub}</p>
        {stat.connected && (
          // Gmail applies signatures in the web UI only, so FRIDAY appends this one to API-sent mail.
          <p className="text-[10px] truncate" style={{ color: stat.signature ? "#34d399" : "var(--cream-mute)" }}>
            {stat.signature ? `✓ signature attached to sent mail — ${stat.signaturePreview}` : "no Gmail signature configured"}
          </p>
        )}
      </div>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {stat.connected
          ? <span className="inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-lg" style={{ background: "rgba(52,211,153,0.16)", color: "#34d399" }}><Check size={13} /> Connected</span>
          : <span className="inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-lg" style={{ background: "rgba(255,255,255,0.05)", color: "var(--cream-mute)" }}><X size={13} /> Not connected</span>}
        <a href={`/api/google/auth?account=${account}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px]" style={{ background: stat.connected ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg,#60a5fa,#3b82f6)", color: stat.connected ? "var(--cream-dim)" : "white" }}>
          <Plug size={13} /> {stat.connected ? "Reconnect" : "Connect"}
        </a>
      </div>
    </div>
  );
}
