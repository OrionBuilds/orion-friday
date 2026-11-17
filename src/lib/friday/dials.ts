// FRIDAY — autonomy dials as data instead of environment variables.
//
// Authority mode is the most consequential setting in the system: it decides whether FRIDAY
// proposes work or just does it. Until now it lived in FRIDAY_AUTHORITY, which means changing it
// required editing .env.local and restarting the server — so the single most important lever was
// also the one thing that absolutely required sitting at the machine. That is exactly backwards
// for an operation meant to run from a phone.
//
// ── Why a synchronous reader over a cached file ───────────────────────────────────────────────
// authorityMode() is called from deep inside synchronous classification code in a dozen places.
// Making it async would ripple through every caller and every eval harness for no behavioural
// gain. So the store of record is a small JSON file, loaded once at boot and written through on
// every change, with a synchronous in-memory read. A dial change takes effect on the next call —
// no restart — which is the entire point.
//
// ── Why the env var stays ─────────────────────────────────────────────────────────────────────
// The env var remains the fallback, so a machine with no dials file behaves exactly as it does
// today and nothing breaks mid-migration. Precedence is dial > env > default: once a dial is set
// it wins, because someone deliberately set it more recently than the env file was written.

import { promises as fs, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, logEvent } from "@/lib/persistence/store";

/** A dial's identity, its legal values, and which env var it falls back to. */
export interface DialSpec {
  name: string;
  values: readonly string[];
  envVar: string;
  fallback: string;
  /** One line, shown when the dials are read back over SMS. */
  describe: string;
}

export const DIALS: readonly DialSpec[] = [
  {
    name: "authority",
    values: ["off", "shadow", "active"] as const,
    envVar: "FRIDAY_AUTHORITY",
    fallback: "shadow",
    describe: "off = every action waits; shadow = decides but still asks; active = auto-approves tier 1/2",
  },
  {
    name: "os_tasks",
    values: ["off", "shadow", "active"] as const,
    envVar: "FRIDAY_OS_TASKS",
    fallback: "shadow",
    describe: "whether OS-scheduled tasks are polled and run",
  },
  {
    name: "os_bridge",
    values: ["on", "off"] as const,
    envVar: "FRIDAY_OS_BRIDGE",
    fallback: "on",
    describe: "mirrors approvals to and from the OS hub",
  },
  {
    name: "meeting_followups",
    values: ["on", "off"] as const,
    envVar: "FRIDAY_MEET_FOLLOWUP",
    fallback: "on",
    describe: "whether FRIDAY drafts a same-day recap email after a client meeting",
  },
  {
    // Client-communication master gate (owner rule 2026-08-29, now a dial). Default OFF: FRIDAY
    // does not talk to clients on any channel unless this is deliberately flipped on.
    name: "client_comms",
    values: ["on", "off"] as const,
    envVar: "FRIDAY_CLIENT_COMMS",
    fallback: "off",
    describe: "off = FRIDAY never messages clients (CLARA drafts, owner sends); on = client replies/acks may go out under authority",
  },
  {
    // Owner SMS master gate (owner rule 2026-09-24: "I no longer want alerts from FRIDAY unless
    // it's via email"). Default OFF: FRIDAY never texts the owner on her own initiative. The ONLY
    // exception is a reply to a text the owner just sent (channels.sendSMS `inboundReply`). Flip
    // to `on` only if email delivery is broken and a text is the last resort.
    name: "owner_sms",
    values: ["on", "off"] as const,
    envVar: "FRIDAY_OWNER_SMS",
    fallback: "off",
    describe: "off = FRIDAY never texts the owner unprompted (email + CLARA's brief only); on = legacy owner SMS allowed",
  },
  {
    // Owner voice-call gate. Default OFF and there is no exception: FRIDAY never phones the owner.
    // Emergencies go to CLARA (delegateBridge.escalateToClara), who decides whether to call.
    name: "owner_calls",
    values: ["on", "off"] as const,
    envVar: "FRIDAY_OWNER_CALLS",
    fallback: "off",
    describe: "off = FRIDAY never phones the owner (CLARA escalates); on = legacy owner calls allowed",
  },
  {
    // Daily token budget for the project-knowledge updater (FRIDAY_PROJECT_KNOWLEDGE). Starts low; raise it
    // after the pilot shows what a refresh really costs. "0" = no rewrites (notes are only marked stale).
    name: "knowledge_daily_tokens",
    values: ["0", "50000", "100000", "200000", "250000", "500000", "1000000"] as const,
    envVar: "FRIDAY_KNOWLEDGE_DAILY_TOKENS",
    fallback: "100000",
    describe: "estimated tokens per day the project-knowledge updater may spend rewriting notes (0 = none, stale-mark only)",
  },
  {
    // Which autonomy model evaluateAuthority uses. `origin` (default, 2026-09) = who asked decides:
    // owner/CLARA/scheduler work is auto, client work is auto only inside approved scope, money and
    // the safety floors always gate. `legacy` = the per-client profile × action-class POLICY table.
    name: "autonomy_policy",
    values: ["legacy", "origin"] as const,
    envVar: "FRIDAY_AUTONOMY_POLICY",
    fallback: "origin",
    describe: "origin = who-asked decides (owner/clara/scheduler auto, client in-scope auto, money gates); legacy = profile × action-class table",
  },
] as const;

export function dialSpec(name: string): DialSpec | null {
  return DIALS.find((d) => d.name === name.trim().toLowerCase()) ?? null;
}

interface DialRecord {
  value: string;
  setBy: string;
  setAt: string;
}

const FILE = path.join(FRIDAY_DATA_DIR, "dials.json");

// Module-level cache. Populated synchronously on first read so a dial set by another process (or
// before this one booted) is honoured without waiting for an async load.
let cache: Record<string, DialRecord> | null = null;

function load(): Record<string, DialRecord> {
  if (cache) return cache;
  try {
    cache = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Record<string, DialRecord>) : {};
  } catch {
    cache = {}; // unreadable/corrupt → fall back to env, never throw from a settings read
  }
  return cache;
}

/**
 * The current value of a dial: whatever was last set, else the env var, else the default.
 * Synchronous by design — see the module header.
 */
export function dial(name: string): string {
  const spec = dialSpec(name);
  if (!spec) return "";
  const set = load()[spec.name]?.value;
  if (set && spec.values.includes(set)) return set;
  const env = (process.env[spec.envVar] ?? "").trim().toLowerCase();
  if (env && spec.values.includes(env)) return env;
  return spec.fallback;
}

/** Where the current value came from — so a reader can say "still on the env default". */
export function dialSource(name: string): "dial" | "env" | "default" {
  const spec = dialSpec(name);
  if (!spec) return "default";
  const set = load()[spec.name]?.value;
  if (set && spec.values.includes(set)) return "dial";
  const env = (process.env[spec.envVar] ?? "").trim().toLowerCase();
  if (env && spec.values.includes(env)) return "env";
  return "default";
}

export interface DialView {
  name: string;
  value: string;
  source: "dial" | "env" | "default";
  values: readonly string[];
  describe: string;
  setBy?: string;
  setAt?: string;
}

export function allDials(): DialView[] {
  const rows = load();
  return DIALS.map((spec) => ({
    name: spec.name,
    value: dial(spec.name),
    source: dialSource(spec.name),
    values: spec.values,
    describe: spec.describe,
    setBy: rows[spec.name]?.setBy,
    setAt: rows[spec.name]?.setAt,
  }));
}

export interface SetDialResult {
  ok: boolean;
  message: string;
  previous?: string;
  value?: string;
}

/**
 * Change a dial. Every transition is logged with who asked and when — this is the setting most
 * worth being able to reconstruct after the fact ("why did it start auto-approving on Tuesday?"),
 * and an unlogged remote flip would make that unanswerable.
 */
export async function setDial(name: string, value: string, setBy: string): Promise<SetDialResult> {
  const spec = dialSpec(name);
  if (!spec) return { ok: false, message: `No dial called "${name}". Known: ${DIALS.map((d) => d.name).join(", ")}.` };

  const v = value.trim().toLowerCase();
  if (!spec.values.includes(v)) {
    return { ok: false, message: `"${value}" isn't valid for ${spec.name}. Options: ${spec.values.join(" | ")}.` };
  }

  const previous = dial(spec.name);
  if (previous === v) return { ok: true, message: `${spec.name} is already ${v}.`, previous, value: v };

  const rows = { ...load(), [spec.name]: { value: v, setBy, setAt: new Date().toISOString() } };
  await fs.mkdir(FRIDAY_DATA_DIR, { recursive: true }).catch(() => {});
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
  await fs.rename(tmp, FILE);
  cache = rows; // write-through, so the very next synchronous read sees it

  await logEvent(
    "dial.changed",
    { dial: spec.name, from: previous, to: v, setBy },
    { level: "warn" }, // warn: an autonomy change should stand out in the log, not blend into info
  ).catch(() => {});

  return { ok: true, message: `${spec.name}: ${previous} → ${v}.`, previous, value: v };
}

/** Drop the cache so the next read re-loads from disk (used by tests and the reload endpoint). */
export function invalidateDialCache(): void {
  cache = null;
}
