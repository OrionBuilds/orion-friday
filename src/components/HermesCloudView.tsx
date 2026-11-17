"use client";

import { useEffect, useState } from "react";
import { Cloud, ExternalLink, Zap, Moon, CalendarClock, Radio, Brain, Boxes, Check, Copy, Terminal } from "lucide-react";

const ACCENT = "#4d7fff"; // Hermes Cloud electric blue
const PORTAL = "https://portal.nousresearch.com/cloud";
const DOCS = "https://hermes-agent.nousresearch.com/docs";

interface Profile { name: string; model: string; provider: string; active: boolean; sessions: number }

const FEATURES = [
  { n: "01", icon: Zap, title: "One-click deploy", body: "Pick a name and model — your agent is online in seconds. No servers, no DevOps, no YAML." },
  { n: "02", icon: Moon, title: "Runs while you sleep", body: "Your agent lives in the cloud 24/7 and scales to zero when idle — you only pay while it works." },
  { n: "03", icon: CalendarClock, title: "Focused automation", body: "Natural-language scheduling for reports, backups, and briefings — running unattended through the gateway." },
  { n: "04", icon: Radio, title: "Every channel", body: "Telegram, Discord, Slack, Email, CLI — one cloud agent, one memory, every surface you already use." },
  { n: "05", icon: Brain, title: "Persistent memory", body: "Memory lives with the agent, not the device — it never forgets how it solved a problem, wherever you log in." },
  { n: "06", icon: Boxes, title: "Isolated sandboxes", body: "Every agent gets its own hardened container — spin up parallel subagents without burning your context." },
];

const STEPS = [
  { n: 1, title: "Top up or subscribe", body: "Sign in to the portal and add credit — $10 minimum, or an active subscription." },
  { n: 2, title: "Name + pick a model", body: "Open Cloud, give the agent a name, and choose a model and instance size." },
  { n: 3, title: "Deploy", body: "Provisioning finishes in seconds and the agent's dashboard is live. Stop it any time to drop to the storage-only rate." },
];

const TIERS = [
  { name: "Free", price: "$0", note: "Free models only" },
  { name: "Plus", price: "$20", note: "$22 credits/mo" },
  { name: "Super", price: "$100", note: "$110 credits/mo" },
  { name: "Ultra", price: "$200", note: "$220 credits/mo" },
];

export default function HermesCloudView() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const ping = () =>
      fetch("/api/hermes/profiles", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => setProfile((j.profiles || []).find((p: Profile) => p.name === "hermes-cloud") || null))
        .catch(() => {});
    ping();
    const id = setInterval(ping, 10000);
    return () => clearInterval(id);
  }, []);

  const copy = () => {
    navigator.clipboard.writeText("hermes-cloud chat").then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <div className="p-5 max-w-[1100px] mx-auto w-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="rounded-xl p-2.5" style={{ background: `${ACCENT}22`, border: `1px solid ${ACCENT}55` }}>
            <Cloud size={26} style={{ color: ACCENT }} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-[var(--cream)]">Hermes Cloud</h1>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: `${ACCENT}22`, color: ACCENT, border: `1px solid ${ACCENT}55` }}>Preview</span>
            </div>
            <p className="text-[13px] text-[var(--cream-mute)] mt-0.5">An always-on autonomous agent in the cloud — it remembers what it learns and gets more capable the longer it runs.</p>
          </div>
        </div>
        <a href={PORTAL} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-[13px] font-medium px-3.5 py-2 rounded-lg" style={{ background: ACCENT, color: "#fff" }}>
          Deploy on Nous Portal <ExternalLink size={14} />
        </a>
      </div>

      {/* Local mirror status */}
      <div className="mt-5 rounded-xl p-4" style={{ background: "var(--bg-card)", border: "1px solid var(--panel-border)" }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: profile ? "#34d399" : "#f59e0b" }} />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: profile ? "#34d399" : "#f59e0b" }} />
            </span>
            <div>
              <div className="text-[13px] text-[var(--cream)] font-medium">Local mirror · <span className="mono">hermes-cloud</span> profile</div>
              <div className="text-[11.5px] text-[var(--cream-mute)]">
                {profile ? <>Model <span className="mono">{profile.model}</span> · provider <span className="mono">{profile.provider}</span> · {profile.sessions} session{profile.sessions === 1 ? "" : "s"}</> : "Loading profile…"}
              </div>
            </div>
          </div>
          <button onClick={copy} className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 rounded-md mono" style={{ background: "rgba(0,0,0,0.35)", border: "1px solid var(--panel-border)", color: "var(--cream-dim)" }}>
            {copied ? <Check size={13} style={{ color: "#34d399" }} /> : <Copy size={13} />} hermes-cloud chat
          </button>
        </div>
        <p className="text-[11.5px] text-[var(--cream-mute)] mt-3 leading-relaxed">
          Runs at <b style={{ color: "var(--cream-dim)" }}>$0</b> on a free Nous model so it works with no credits. It mirrors what a real Cloud Agent runs — to match the flagship, set <span className="mono">nousresearch/hermes-4-405b</span> in the profile config (needs a top-up or subscription, same gate as deploying to the cloud).
        </p>
      </div>

      {/* Features */}
      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {FEATURES.map((f) => {
          const Icon = f.icon;
          return (
            <div key={f.n} className="rounded-xl p-4" style={{ background: "var(--bg-card)", border: "1px solid var(--panel-border)" }}>
              <div className="flex items-center gap-2">
                <Icon size={16} style={{ color: ACCENT }} />
                <span className="mono text-[10px] text-[var(--cream-mute)]">#{f.n}</span>
              </div>
              <div className="text-[14px] text-[var(--cream)] font-medium mt-2">{f.title}</div>
              <div className="text-[12px] text-[var(--cream-mute)] mt-1 leading-relaxed">{f.body}</div>
            </div>
          );
        })}
      </div>

      {/* Deploy steps */}
      <div className="mt-6">
        <div className="flex items-center gap-2 mb-3">
          <Terminal size={15} style={{ color: ACCENT }} />
          <h2 className="text-[14px] font-semibold text-[var(--cream)]">Deploy a real Cloud Agent — two clicks, ~60 seconds</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {STEPS.map((s) => (
            <div key={s.n} className="rounded-xl p-4 relative" style={{ background: "var(--bg-card)", border: "1px solid var(--panel-border)" }}>
              <div className="mono text-[11px] mb-1.5" style={{ color: ACCENT }}>STEP {s.n}</div>
              <div className="text-[13px] text-[var(--cream)] font-medium">{s.title}</div>
              <div className="text-[12px] text-[var(--cream-mute)] mt-1 leading-relaxed">{s.body}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Pricing + CTA */}
      <div className="mt-6 rounded-xl p-4" style={{ background: "var(--bg-card)", border: "1px solid var(--panel-border)" }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-[12px] text-[var(--cream-mute)]">Nous Portal plans — all paid tiers include monthly credits + 200+ models + the Tool Gateway.</div>
          <a href={DOCS} target="_blank" rel="noopener" className="text-[12px] inline-flex items-center gap-1" style={{ color: ACCENT }}>Docs <ExternalLink size={12} /></a>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-3">
          {TIERS.map((t) => (
            <div key={t.name} className="rounded-lg p-3 text-center" style={{ background: "rgba(0,0,0,0.25)", border: "1px solid var(--line-soft)" }}>
              <div className="text-[11px] uppercase tracking-wide text-[var(--cream-mute)]">{t.name}</div>
              <div className="text-lg font-semibold text-[var(--cream)] mt-0.5">{t.price}</div>
              <div className="text-[10.5px] text-[var(--cream-mute)] mt-0.5">{t.note}</div>
            </div>
          ))}
        </div>
        <div className="text-[11px] text-[var(--cream-mute)] mt-3">$10 minimum in credits, or an active subscription, to deploy a Cloud Agent. Scales to zero when idle — you only pay while it works.</div>
      </div>
    </div>
  );
}
