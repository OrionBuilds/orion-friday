// Owner availability / away mode (2.3). When the owner flags themselves away, FRIDAY holds commitments, gives
// waiting clients an honest return timeline, and pages them ONLY for true incidents (critical) — every
// other ping batches to the digest. On return she hands them one catch-up summary. Persisted to a small
// JSON state file (there's no settings store; this mirrors the notify-queue.json / outbound-pause.json
// pattern). v1 is deliberately simple: no autonomy-ratchet widening yet.

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, logEvent } from "@/lib/persistence/store";

export interface OwnerStatus {
  state: "available" | "away";
  until?: string;   // ISO — when the owner expects to be back
  reason?: string;  // short, client-safe ("traveling", "on a flight")
  since?: string;   // ISO — when away began (for the return digest window)
}

const FILE = path.join(FRIDAY_DATA_DIR, "owner-status.json");
const AVAILABLE: OwnerStatus = { state: "available" };

export async function getOwnerStatus(): Promise<OwnerStatus> {
  try {
    const s = JSON.parse(await fs.readFile(FILE, "utf8")) as OwnerStatus;
    // Auto-expire: an away window whose `until` has passed reverts to available.
    if (s.state === "away" && s.until && Date.parse(s.until) < Date.now()) return AVAILABLE;
    return s?.state ? s : AVAILABLE;
  } catch { return AVAILABLE; }
}

export async function isAway(): Promise<boolean> {
  return (await getOwnerStatus()).state === "away";
}

async function write(s: OwnerStatus): Promise<void> {
  try { await fs.writeFile(FILE, JSON.stringify(s, null, 2), "utf8"); } catch { /* best-effort */ }
}

export async function setAway(untilISO?: string, reason?: string): Promise<OwnerStatus> {
  const s: OwnerStatus = { state: "away", until: untilISO, reason, since: new Date().toISOString() };
  await write(s);
  await logEvent("owner.away", { until: untilISO, reason });
  return s;
}

/** Return to available and hand back a one-shot catch-up digest of what happened while away. */
export async function setAvailable(): Promise<{ status: OwnerStatus; digest: string }> {
  const prev = await getOwnerStatus();
  await write(AVAILABLE);
  await logEvent("owner.back", {});
  const digest = prev.state === "away" ? await catchUpDigest(prev.since) : "";
  return { status: AVAILABLE, digest };
}

// A human-friendly return timeline for clients: end of the next business day after `until` (or after
// today if no date given). Weekends roll to Monday. Local-date granularity is enough for a promise.
export function returnTimeline(status: OwnerStatus): string {
  const base = status.until ? new Date(status.until) : new Date();
  const d = new Date(base);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); // skip Sat/Sun
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

// One-line away context injected into the client prompts so FRIDAY's escalation replies are honest
// about timing while the owner is out. Empty when available.
export async function awayClientNote(): Promise<string> {
  const s = await getOwnerStatus();
  if (s.state !== "away") return "";
  const { OWNER_FIRST } = await import("@/lib/friday/persona");
  return `\nNOTE — ${OWNER_FIRST} is currently away${s.reason ? ` (${s.reason})` : ""}. For anything that needs their sign-off (Tier 3 / new scope / money / dates), do NOT promise it's handled — warmly tell the client ${OWNER_FIRST} is away and you'll have an answer for them by ${returnTimeline(s)}. Keep handling Tier-1/Tier-2 in-scope work normally.`;
}

async function catchUpDigest(sinceISO?: string): Promise<string> {
  const { store } = await import("@/lib/persistence/store");
  const since = sinceISO ? Date.parse(sinceISO) : 0;
  const [pending, logs] = await Promise.all([
    store.approvals.find((a) => a.status === "pending"),
    store.logs.tail(400),
  ]);
  const after = (ts?: string) => (ts ? Date.parse(ts) : 0) >= since;
  const autonomous = logs.filter((l) => l.event === "friday.autonomous" && after(l.ts)).length;
  const clientMsgs = logs.filter((l) => (l.event === "email.reply.sent" || l.event.startsWith("client.")) && after(l.ts)).length;
  const bits = [
    `${pending.length} approval(s) waiting`,
    autonomous ? `${autonomous} thing(s) I handled in-scope` : "",
    clientMsgs ? `${clientMsgs} client message(s) while you were out` : "",
  ].filter(Boolean);
  return `👋 Welcome back. ${bits.join(" · ") || "Nothing needs you — all quiet."}`;
}
