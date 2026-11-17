"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { LayoutGrid, Brain, Columns3, NotebookText, MessagesSquare, Network, Cpu, GripVertical, Eye, EyeOff, SlidersHorizontal, Check, Users, FolderKanban, Bot, Radio, Target, Plug, Menu, X, MonitorPlay, CalendarClock, CheckCircle2 } from "lucide-react";
import { useState, useEffect, type ReactNode } from "react";
import { useSidebarNav } from "@autom8ionlab/agent-core";
import AgentAvatar from "./AgentAvatar";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  accent: string;
  dim: string;
}

// FRIDAY — delivery-focused nav. The base pack's studios (video, music,
// games, seo, thumbnails, notebook, and the extra model tabs) still exist as routes but are
// intentionally left out of the sidebar for v1; they can be surfaced later via the registry.
//
// Design 2026-07-23: per-item accents desaturated to a single cyan brand color
// (Orion spec §2). Previously used a 12-hex rainbow for at-a-glance nav scanning;
// brand purity beats color legibility for this iteration.
const ACCENT = "#06b6d4";                  // cyan-500 — Orion brand primary
const DIM = "rgba(6,182,212,0.16)";        // cyan-500 @ 16%
const NAV: NavItem[] = [
  { href: "/",         label: "Mission Control", icon: <LayoutGrid size={16} />, accent: ACCENT, dim: DIM },
  { href: "/friday",   label: "FRIDAY",          icon: <Radio size={16} />,      accent: ACCENT, dim: DIM },
  { href: "/live",     label: "Control Room",    icon: <MonitorPlay size={16} />, accent: ACCENT, dim: DIM },
  { href: "/approvals", label: "Approvals",      icon: <CheckCircle2 size={16} />, accent: ACCENT, dim: DIM },
  // Delivery
  { href: "/clients",  label: "Clients",   icon: <Users size={16} />,        accent: ACCENT, dim: DIM },
  { href: "/projects", label: "Projects",  icon: <FolderKanban size={16} />, accent: ACCENT, dim: DIM },
  { href: "/schedules", label: "Schedules", icon: <CalendarClock size={16} />, accent: ACCENT, dim: DIM },
  { href: "/room",     label: "Agent Mastermind", icon: <MessagesSquare size={16} />, accent: ACCENT, dim: DIM },
  // Agents — AgentAvatar per-agent brand hue preserved via its own component
  { href: "/agents",   label: "The Team",  icon: <Bot size={16} />,          accent: ACCENT, dim: DIM },
  { href: "/claude",   label: "Claude",    icon: <AgentAvatar agent="claude" size={22} />, accent: ACCENT, dim: DIM },
  { href: "/hermes",   label: "Hermes",    icon: <AgentAvatar agent="hermes" size={22} />, accent: ACCENT, dim: DIM },
  { href: "/codex",    label: "Codex",     icon: <AgentAvatar agent="codex" size={22} />,  accent: ACCENT, dim: DIM },
  { href: "/antigravity", label: "Antigravity", icon: <AgentAvatar agent="antigravity" size={22} />, accent: ACCENT, dim: DIM },
  { href: "/local",    label: "LM Studio", icon: <Cpu size={18} />,          accent: ACCENT, dim: DIM },
  { href: "/fusion",   label: "Fusion",    icon: <Network size={18} />,      accent: ACCENT, dim: DIM },
  // Workspace
  { href: "/kanban",   label: "Kanban",    icon: <Columns3 size={16} />,     accent: ACCENT, dim: DIM },
  { href: "/goals",    label: "Goals",     icon: <Target size={16} />,       accent: ACCENT, dim: DIM },
  { href: "/journal",  label: "Journal",   icon: <NotebookText size={16} />, accent: ACCENT, dim: DIM },
  { href: "/memory",   label: "Memory",    icon: <Brain size={16} />,        accent: ACCENT, dim: DIM },
  { href: "/settings", label: "Integrations", icon: <Plug size={16} />,      accent: ACCENT, dim: DIM },
];

const BY_HREF: Record<string, NavItem> = Object.fromEntries(NAV.map((n) => [n.href, n]));
const AGENT_ROUTES = new Set(["/agents", "/claude", "/hermes", "/codex", "/antigravity", "/local", "/fusion"]);

// Sidebar grouping: Command (Mission Control + FRIDAY), Delivery (clients/projects/room),
// Agents (the team + model tabs), Workspace (kanban/goals/journal/memory).
const COMMAND_ROUTES = new Set(["/", "/friday", "/live"]);
const DELIVERY_ROUTES = new Set(["/clients", "/projects", "/schedules", "/room"]);
function sectionOf(href: string): string {
  if (COMMAND_ROUTES.has(href)) return "Command";
  if (DELIVERY_ROUTES.has(href)) return "Delivery";
  if (AGENT_ROUTES.has(href)) return "Agents";
  return "Workspace";
}
const SECTION_ORDER = ["Command", "Delivery", "Agents", "Workspace"];

export default function Sidebar() {
  const pathname = usePathname();
  const {
    list, customize, setCustomize, isHidden, isOver, toggleHidden, reset,
    onDragStart, onDragEnter, onDrop, onDragEnd, onDragEnterEnd, onDropEnd, sectionLabelAt,
  } = useSidebarNav(NAV, sectionOf, SECTION_ORDER, "friday");
  const [version, setVersion] = useState("");
  useEffect(() => { fetch("/api/version").then((r) => r.json()).then((j) => setVersion(j.version || "")).catch(() => {}); }, []);

  return (
    <aside className="hidden md:flex flex-col w-[244px] shrink-0 h-screen overflow-hidden py-6 border-r border-[var(--line-soft)]"
           style={{ background: "var(--bg-mid)" }}>
      <Link href="/" className="block mb-7 px-5 shrink-0">
        {process.env.NEXT_PUBLIC_FRIDAY_AGENCY_NAME && (
          <div className="text-[10px] uppercase tracking-[0.25em] mb-1" style={{ color: "var(--cream-mute)", fontFamily: "'Manrope', sans-serif", fontWeight: 600 }}>
            {process.env.NEXT_PUBLIC_FRIDAY_AGENCY_NAME}
          </div>
        )}
        <div className="text-xl tracking-tight" style={{ fontFamily: "'Bricolage Grotesque', sans-serif", fontWeight: 500, color: "var(--cream)" }}>
          FRIDAY <span className="hand text-[1.3em] ml-1">OS</span>
        </div>
        {version && (
          <div className="text-[10px] mt-1 tracking-wider" style={{ color: "var(--cream-mute)", fontFamily: "'Manrope', sans-serif" }}
               title="Build version">
            build {version}
          </div>
        )}
      </Link>

      <div className="flex-1 min-h-0 overflow-y-auto sidebar-scroll">
      <div className="px-5 pb-1.5 flex items-center justify-between">
        <span className="sidebar-section-label">Command</span>
        <div className="flex items-center gap-2">
          {customize && (
            <button onClick={reset} title="Reset to default order" className="text-[9px] uppercase tracking-[0.15em] hover:opacity-100 opacity-70 transition" style={{ color: "var(--cream-dim)" }}>
              Reset
            </button>
          )}
          <button
            onClick={() => setCustomize((c) => !c)}
            title={customize ? "Done customizing" : "Customize sidebar — drag to reorder, hide items"}
            className="grid place-items-center w-6 h-6 rounded-md transition"
            style={{ color: customize ? "var(--gold)" : "var(--cream-dim)", background: customize ? "rgba(212,165,116,0.14)" : "transparent" }}
          >
            {customize ? <Check size={14} /> : <SlidersHorizontal size={14} />}
          </button>
        </div>
      </div>
      {customize && (
        <div className="px-5 pb-2 text-[10px] leading-snug" style={{ color: "var(--cream-mute)" }}>
          Drag <GripVertical size={10} className="inline -mt-0.5" /> to reorder · tap the eye to hide
        </div>
      )}

      <nav className="flex flex-col gap-0.5 relative">
        {list.map((href, i) => {
          const item = BY_HREF[href];
          if (!item) return null;
          const sectionLabel = sectionLabelAt(i);
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          const hiddenItem = isHidden(href);
          const over = isOver(href);

          return (
            <div key={href}>
              {sectionLabel && (
                <div className="sidebar-section-label mt-5 mb-1.5 px-5">
                  {sectionLabel}
                </div>
              )}

              {customize ? (
                <div
                  draggable
                  onDragStart={() => onDragStart(href)}
                  onDragEnter={() => onDragEnter(href)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(href)}
                  onDragEnd={onDragEnd}
                  className="sidebar-item relative group flex items-center gap-2 py-2.5 px-3 mx-2 rounded-lg cursor-grab active:cursor-grabbing"
                  style={{
                    opacity: hiddenItem ? 0.4 : 1,
                    borderTop: over ? "2px solid var(--gold)" : "2px solid transparent",
                    background: over ? "rgba(212,165,116,0.08)" : "transparent",
                  }}
                >
                  <GripVertical size={14} style={{ color: "var(--cream-mute)" }} className="shrink-0" />
                  <span className="shrink-0 grid place-items-center w-7 h-7 rounded-md" style={{ color: "var(--cream-dim)" }}>
                    {item.icon}
                  </span>
                  <span className="flex-1 truncate" style={{ textDecoration: hiddenItem ? "line-through" : "none" }}>{item.label}</span>
                  <button
                    onClick={() => toggleHidden(href)}
                    title={hiddenItem ? "Show" : "Hide"}
                    className="shrink-0 grid place-items-center w-6 h-6 rounded-md transition hover:bg-[rgba(255,255,255,0.06)]"
                    style={{ color: hiddenItem ? "var(--cream-mute)" : "var(--gold)" }}
                  >
                    {hiddenItem ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              ) : (
                <Link
                  href={href}
                  className={`sidebar-item relative group flex items-center gap-3 py-2.5 px-5 ${active ? "active" : ""}`}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-indicator"
                      className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-[22px]"
                      style={{ background: "var(--gold)", boxShadow: "0 0 10px var(--gold)" }}
                      transition={{ type: "spring", stiffness: 380, damping: 30 }}
                    />
                  )}
                  <span
                    className="shrink-0 grid place-items-center w-7 h-7 rounded-md transition"
                    style={{ color: active ? "var(--gold)" : "var(--cream-dim)" }}
                  >
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </Link>
              )}
            </div>
          );
        })}
        {customize && (
          <div
            onDragEnter={onDragEnterEnd}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDropEnd}
            className="h-6 mx-2 rounded-lg"
            style={{ borderTop: isOver("__end__") ? "2px solid var(--gold)" : "2px solid transparent" }}
          />
        )}
      </nav>
      </div>

      <div className="shrink-0 pt-6 mx-5 border-t border-[var(--line-soft)]">
        <div className="sidebar-section-label mt-4 mb-2">Wired</div>
        <div className="text-[11px] leading-relaxed mono" style={{ color: "var(--cream-dim)" }}>
          claude · lm studio<br />
          github · netlify · supabase<br />
          <span className="hand text-[1.15em]">+</span> Obsidian vault
        </div>
      </div>
    </aside>
  );
}

// Mobile bottom bar: the desktop sidebar is hidden below `md`, so this is the only nav on phones.
// Showing all 17 items in a fixed row overflowed a 375px screen — instead show 4 primary
// destinations + a "More" button that opens a full grouped menu sheet (everything stays reachable).
export function MobileNav() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  // close the sheet whenever the route changes (covers back/forward too)
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const primary = ["/", "/friday", "/projects", "/clients"].map((h) => BY_HREF[h]).filter(Boolean);

  return (
    <>
      <nav className="md:hidden z-40 panel panel-hot px-2 py-1.5 flex gap-1"
        style={{ position: "fixed", bottom: 12, left: "50%", transform: "translateX(-50%)", maxWidth: "calc(100vw - 1.5rem)" }}>
        {primary.map((item) => {
          const active = isActive(item.href);
          return (
            <Link key={item.href} href={item.href}
              className="grid place-items-center w-12 h-11 rounded-lg transition"
              style={{ background: active ? item.dim : "transparent", color: active ? item.accent : "var(--fg-dim)" }}>
              {item.icon}
            </Link>
          );
        })}
        <button onClick={() => setMenuOpen(true)} aria-label="More navigation"
          className="grid place-items-center w-12 h-11 rounded-lg transition"
          style={{ color: menuOpen ? "var(--gold)" : "var(--fg-dim)" }}>
          <Menu size={18} />
        </button>
      </nav>

      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-50" onClick={() => setMenuOpen(false)}>
          <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)" }} />
          <div className="absolute bottom-0 left-0 right-0 max-h-[82vh] overflow-y-auto rounded-t-2xl p-4 pb-8"
            style={{ background: "var(--bg-mid)", borderTop: "1px solid var(--line-soft)" }}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <span className="sidebar-section-label">Navigate</span>
              <button onClick={() => setMenuOpen(false)} aria-label="Close menu"
                className="grid place-items-center w-8 h-8 rounded-lg" style={{ color: "var(--cream-dim)" }}>
                <X size={16} />
              </button>
            </div>
            {["Command", "Delivery", "Agents", "Workspace"].map((sec) => {
              const secItems = NAV.filter((n) => sectionOf(n.href) === sec);
              if (!secItems.length) return null;
              return (
                <div key={sec} className="mb-3">
                  <div className="sidebar-section-label mb-1.5">{sec}</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {secItems.map((item) => {
                      const active = isActive(item.href);
                      return (
                        <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)}
                          className="flex items-center gap-2.5 py-2.5 px-3 rounded-lg transition"
                          style={{ background: active ? item.dim : "rgba(255,255,255,0.03)", color: active ? item.accent : "var(--cream)" }}>
                          <span className="shrink-0 grid place-items-center w-6 h-6">{item.icon}</span>
                          <span className="text-[13px] truncate">{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
