// FRIDAY Dream — a daily brief. Reads the day's state (active projects, open tasks, pending
// approvals, recent activity) and asks FRIDAY for the few highest-impact things to do today.
// Cached per-day to disk + mirrored to Obsidian. Inspired by the Claude Code OS "Dream" engine.

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store, nowISO, logEvent } from "@/lib/persistence/store";
import { complete, completeJSON, defaultEngine } from "@/lib/friday/engines";
import { FRIDAY_CORE, OWNER } from "@/lib/friday/persona";
import { assigneeIds } from "@/lib/friday/agents";
import { appendFridayLog } from "@/lib/persistence/obsidian";
import { isClosed } from "@/lib/friday/stages";
import { todayISO } from "@/lib/vaultWriter";

export interface Prescription {
  title: string;
  why: string;
  action: string;      // the concrete next step
  agent?: string;      // suggested agent to run it
  projectId?: string;
}
export interface Dream {
  date: string;
  greeting: string;
  prescriptions: Prescription[];
  generatedAt: string;
}

function dreamFile(date: string): string {
  return path.join(FRIDAY_DATA_DIR, `dream-${date}.json`);
}

async function readCached(date: string): Promise<Dream | null> {
  try { return JSON.parse(await fs.readFile(dreamFile(date), "utf8")) as Dream; } catch { return null; }
}

async function buildContext(): Promise<string> {
  const [projects, tasks, approvals, logs, clients] = await Promise.all([
    store.projects.all(),
    store.tasks.all(),
    store.approvals.find((a) => a.status === "pending"),
    store.logs.tail(200),
    store.clients.all(),
  ]);
  const active = projects.filter((p) => p.status === "active");
  const lines: string[] = [];
  lines.push(`Clients: ${clients.length}. Active projects: ${active.length}.`);
  for (const p of active.slice(0, 8)) {
    const pt = tasks.filter((t) => t.projectId === p.id);
    const open = pt.filter((t) => !isClosed(t.status));
    const blocked = pt.filter((t) => t.status === "blocked");
    lines.push(`- ${p.name}: ${open.length} open task(s)${blocked.length ? `, ${blocked.length} blocked` : ""}${open.slice(0, 4).length ? ` — ${open.slice(0, 4).map((t) => t.title).join("; ")}` : ""} [projectId:${p.id}]`);
  }
  if (approvals.length) lines.push(`Awaiting your approval: ${approvals.map((a) => a.action).slice(0, 5).join(" | ")}`);

  // Tier-2 work FRIDAY decided and dispatched herself, without asking — surfaced so the owner always
  // sees what she did on their behalf while they were away. This visibility is what makes the autonomy safe.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const autonomous = logs.filter(
    (l) => l.event === "friday.autonomous" && new Date(l.ts).getTime() >= dayAgo,
  );
  if (autonomous.length) {
    const items = autonomous.slice(-8).map((l) => {
      const d = (l.data ?? {}) as { client?: string; project?: string; summary?: string };
      return `  • ${d.client ?? "a client"} · ${d.project ?? "—"}: ${d.summary ?? "(handled)"}`;
    });
    lines.push(`Handled autonomously while you were away (Tier 2 — already dispatched, no action needed):\n${items.join("\n")}`);
  }

  // Outbound governor visibility — capped/held client sends are never silently dropped; they surface here.
  const dayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
  const outRecent = await store.outbound.find((r) => Date.parse(r.ts) >= dayAgoMs && r.status !== "sent");
  if (outRecent.length) {
    const blocked = outRecent.filter((r) => r.status === "blocked").length;
    const queued = outRecent.filter((r) => r.status === "queued").length;
    const bits = [blocked ? `${blocked} rate-capped/blocked` : "", queued ? `${queued} held for quiet hours` : ""].filter(Boolean);
    if (bits.length) lines.push(`Outbound held/blocked (last 24h): ${bits.join(", ")}.`);
  }

  // Model spend today (2.2) — best-effort; a decision-context money line, not a bill.
  const todayStr = new Date().toISOString().slice(0, 10);
  const calls = await store.modelCalls.find((c) => (c.ts || "").slice(0, 10) === todayStr);
  const spend = calls.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  if (spend > 0) {
    const byProj = new Map<string, number>();
    for (const c of calls) if (c.costUsd && c.projectId) byProj.set(c.projectId, (byProj.get(c.projectId) ?? 0) + c.costUsd);
    const top = [...byProj.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([pid, usd]) => `${projects.find((p) => p.id === pid)?.name ?? "?"} $${usd.toFixed(2)}`).join(", ");
    lines.push(`Model spend today: ~$${spend.toFixed(2)} (${calls.length} calls)${top ? ` — top: ${top}` : ""}.`);
  }

  const events = logs.slice(-12).map((l) => l.event).filter((e) => !e.startsWith("registry")).join(", ");
  if (events) lines.push(`Recent activity: ${events}`);
  return lines.join("\n");
}

export async function generateDream(force = false): Promise<Dream> {
  const date = todayISO();
  if (!force) { const cached = await readCached(date); if (cached) return cached; }

  const context = await buildContext();
  // Agent options generated from the live roster (minus "human"), so the brief can never suggest an
  // agent that doesn't exist — and every specialist is reachable (the seo/marketing/sales/designer gap).
  const agentOptions = assigneeIds().filter((a) => a !== "human").join("|");
  const system = `${FRIDAY_CORE}\n\nYou are writing ${OWNER}'s morning brief. Read the state and pick the 3-4 HIGHEST-IMPACT things to do today for client delivery. If a "Handled autonomously" section is present, briefly REPORT what you already took care of (one warm line in the greeting or a low-priority prescription) — do NOT re-task work you've already dispatched. Respond with ONLY JSON:
{ "greeting": "one warm spoken-style line", "prescriptions": [ { "title": "short", "why": "1 sentence impact", "action": "the concrete next step", "agent": "${agentOptions}", "projectId": "id or null" } ] }
Be specific to the actual projects/tasks. Return JSON only.`;

  let dream: Dream;
  const parsed = await completeJSON<{ greeting: string; prescriptions: Prescription[] }>({
    engine: defaultEngine(), system, prompt: `Today: ${date}\n\nState:\n${context}`, timeoutMs: 120_000,
  });
  if (parsed && Array.isArray(parsed.prescriptions)) {
    dream = { date, greeting: parsed.greeting || `Morning, ${OWNER}.`, prescriptions: parsed.prescriptions.slice(0, 4), generatedAt: nowISO() };
  } else {
    dream = { date, greeting: `Morning, ${OWNER}.`, prescriptions: [], generatedAt: nowISO() };
  }

  await fs.writeFile(dreamFile(date), JSON.stringify(dream, null, 2), "utf8").catch(() => {});
  await mirrorDream(dream);
  await logEvent("dream.generate", { date, count: dream.prescriptions.length });
  return dream;
}

async function mirrorDream(dream: Dream): Promise<void> {
  const body = [
    dream.greeting, "",
    ...dream.prescriptions.map((p, i) => `${i + 1}. **${p.title}** — ${p.why}\n   → ${p.action}${p.agent ? ` _(${p.agent})_` : ""}`),
  ].join("\n");
  await appendFridayLog({ kind: "note", actor: "FRIDAY", text: `🌅 **Daily brief**\n${body}` });
}

export async function getTodayDream(): Promise<Dream> {
  const cached = await readCached(todayISO());
  return cached ?? generateDream();
}
