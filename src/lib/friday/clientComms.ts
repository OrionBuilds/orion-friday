// Client-communication master gate (owner rule 2026-08-29; tightened 2026-10-28, audit + contract §6).
//
// FRIDAY does not communicate with clients on ANY channel unless this is deliberately on —
// CLARA is the client-facing reader/drafter and the owner sends. This is the single hard
// switch every client-facing send/reply chokepoint checks. It is DEFAULT-OFF, so the safe
// state holds even if nothing is configured. Owner notifications, the task/run/deploy
// engine, portal updates, and release approvals do NOT route through this gate and are
// unaffected.
//
// Effective value (contract §6): OFF when ANY of these says off —
//   1. env `FRIDAY_CLIENT_COMMS=off` — a HARD off. The `client_comms` dial can NOT override it
//      (the 2026-10-28 audit found dials.json=on silently beating an env off).
//   2. the OS org switch (`org_settings_get` → agent_client_comms_enabled) is off, unset, or the
//      tool is unavailable — unknown ⇒ off (default-deny).
//   3. the `client_comms` dial (dial > env > "off") is not "on".
// So the dial can only ever turn comms OFF over an env/OS "on", never ON over an "off".
//
// The OS switch is cached and refreshed asynchronously (refreshClientCommsSwitch — kicked on read
// when stale and awaited by clientCommsEnabledFresh), so this stays a cheap synchronous read.

import { dial } from "@/lib/friday/dials";

const OS_SWITCH_TTL_MS = 5 * 60_000;

let osSwitch: { on: boolean; at: number; source: string } | null = null;
let inflight: Promise<void> | null = null;

function envHardOff(): boolean {
  return (process.env.FRIDAY_CLIENT_COMMS ?? "").trim().toLowerCase() === "off";
}

/** Parse org_settings_get's answer. Tolerant of `{agent_client_comms_enabled}`, `{settings:{…}}`, or a row array. */
export function parseOsClientCommsSwitch(v: unknown): boolean | null {
  const pick = (o: unknown): unknown => {
    if (!o || typeof o !== "object") return undefined;
    const r = o as Record<string, unknown>;
    if ("agent_client_comms_enabled" in r) return r.agent_client_comms_enabled;
    if ("client_comms_enabled" in r) return r.client_comms_enabled;
    if (r.settings && typeof r.settings === "object") return pick(r.settings);
    if (r.organization && typeof r.organization === "object") return pick(r.organization);
    return undefined;
  };
  const raw = Array.isArray(v) ? pick(v[0]) : pick(v);
  if (raw === true || raw === "true" || raw === "on") return true;
  if (raw === false || raw === "false" || raw === "off") return false;
  return null;
}

let osOrgNameCache: string | null = null;
/** The OS organization's name from the last org_settings_get (null until one succeeded). */
export function osOrgName(): string | null {
  return osOrgNameCache;
}

/** Refresh the cached OS org switch. Never throws; any miss leaves the switch OFF. */
export async function refreshClientCommsSwitch(force = false): Promise<void> {
  if (!force && osSwitch && Date.now() - osSwitch.at < OS_SWITCH_TTL_MS) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { callOsTool } = await import("@/lib/friday/osTool");
      const r = await callOsTool("org_settings_get", {});
      if (!r.ok) { osSwitch = { on: false, at: Date.now(), source: r.missing ? "os:tool_missing" : "os:error" }; return; }
      const v = parseOsClientCommsSwitch(r.data);
      osSwitch = { on: v === true, at: Date.now(), source: v === null ? "os:unset" : "os" };
      // Same row carries the org name (contract-changes §E) — the client sign-off fallback (clientBrand.ts).
      const row = (Array.isArray(r.data) ? r.data[0] : r.data) as { name?: unknown } | null;
      if (row && typeof row.name === "string" && row.name.trim()) osOrgNameCache = row.name.trim();
    } catch {
      osSwitch = { on: false, at: Date.now(), source: "os:error" };
    }
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Synchronous effective gate (see the header). Kicks a background refresh when the OS value is stale. */
export function clientCommsEnabled(): boolean {
  if (envHardOff()) return false;
  const stale = !osSwitch || Date.now() - osSwitch.at >= OS_SWITCH_TTL_MS;
  // Unit tests pin the switch with _setOsClientCommsSwitch; never let a test process reach the live OS.
  if (stale && !process.env.NODE_TEST_CONTEXT) void refreshClientCommsSwitch();
  if (!osSwitch?.on) return false;
  return dial("client_comms") === "on";
}

/** Async variant for call sites that can wait: refreshes the OS switch first when stale. */
export async function clientCommsEnabledFresh(): Promise<boolean> {
  if (envHardOff()) return false;
  if (!process.env.NODE_TEST_CONTEXT) await refreshClientCommsSwitch();
  return clientCommsEnabled();
}

/** Why the gate reads the way it does — for status replies / logs. */
export function clientCommsExplain(): { enabled: boolean; env: string; os: string; dial: string } {
  return {
    enabled: clientCommsEnabled(),
    env: (process.env.FRIDAY_CLIENT_COMMS ?? "").trim().toLowerCase() || "(unset)",
    os: osSwitch ? `${osSwitch.on ? "on" : "off"} (${osSwitch.source})` : "unknown (off)",
    dial: dial("client_comms"),
  };
}

/** Test hook: pin the OS switch (null = unknown ⇒ off). */
export function _setOsClientCommsSwitch(on: boolean | null): void {
  osSwitch = on === null ? null : { on, at: on === null ? 0 : Date.now() + 365 * 86_400_000, source: "test" };
}
