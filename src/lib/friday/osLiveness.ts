// OS-session liveness alarm (2026-10-28 audit, gap 8 / §1 "session fragility").
//
// From 2026-10-21 to 10-23 every OS call failed with `refresh_token_already_used` and nothing
// alarmed: the OS liveness cron watches heartbeats that come from the same broken session, and
// FRIDAY's own owner notifications ride that session too (notifyOwner → agent_notify_owner). So the
// alarm here must NOT depend on the OS session:
//
//   * every 5 min the `os-auth-liveness` scheduler job probes the session (agent_whoami through
//     callOsTool, which feeds the auth-failure ledger in osTool.ts — as does every other callOsTool
//     call in the app);
//   * once an auth-failure streak has lasted > OS_AUTH_ALARM_AFTER_MS it RAISES the alarm:
//       - an error-level `os.auth_broken` event (logs.jsonl),
//       - FRIDAY_DATA_DIR/os-auth-alarm.json (survives restarts; the repair is interactive /os/auth),
//       - GET /api/health turns 503 with `osAuth: "broken"` — that endpoint exists precisely for an
//         EXTERNAL heartbeat monitor, which is the only channel that still works when the OS
//         session is dead;
//       - a best-effort notifyOwner(critical). It goes through the OS and will fail while the session
//         is broken, but notify.ts queues it locally and the hourly digest retries it, so the owner still
//         hears about it once the session is repaired. No other send (SMS/email) is attempted.
//   * the first healthy probe clears the alarm file (and logs `os.auth_recovered`).

import path from "node:path";
import { promises as fs } from "node:fs";
import { FRIDAY_DATA_DIR, logEvent } from "@/lib/persistence/store";
import { callOsTool, osAuthFailureState } from "@/lib/friday/osTool";

export const OS_AUTH_ALARM_AFTER_MS = 10 * 60_000;
export const OS_AUTH_REALERT_MS = 6 * 3_600_000;
const ALARM_FILE = () => path.join(FRIDAY_DATA_DIR, "os-auth-alarm.json");

export interface OsAuthAlarm {
  raisedAt: string;
  firstFailureAt: string;
  lastFailureAt: string;
  failures: number;
  lastError: string;
  /** When the owner was last alerted about this alarm (re-alert every OS_AUTH_REALERT_MS while it lasts). */
  lastAlertedAt?: string;
}

export async function readOsAuthAlarm(): Promise<OsAuthAlarm | null> {
  try { return JSON.parse(await fs.readFile(ALARM_FILE(), "utf8")) as OsAuthAlarm; } catch { return null; }
}

/** Pure: should the alarm be raised for this streak at `now`? */
export function alarmDue(state: { firstAt: number } | null, now: number, afterMs = OS_AUTH_ALARM_AFTER_MS): boolean {
  return !!state && now - state.firstAt > afterMs;
}

type ToolClient = { callTool(name: string, args?: Record<string, unknown>): Promise<unknown> };

/**
 * One liveness check. Never throws. `probe:false` skips the active whoami call (tests / callers that
 * just want to evaluate the ledger). Returns a short status string for the scheduler log.
 */
export async function checkOsAuthLiveness(opts: {
  now?: number;
  probe?: boolean;
  client?: ToolClient;
  notify?: (input: { kind: string; priority: "critical"; text: string; dedupeKey: string }) => Promise<unknown>;
  localAlert?: (title: string, body: string) => Promise<unknown>;
} = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  if (opts.probe !== false) {
    // Feeds osTool's ledger: success clears the streak, an auth error extends it.
    await callOsTool("agent_whoami", {}, { client: opts.client, context: { for: "os-auth-liveness" } });
  }
  const state = osAuthFailureState();
  const existing = await readOsAuthAlarm();

  if (!state) {
    if (existing) {
      await fs.rm(ALARM_FILE(), { force: true }).catch(() => {});
      await logEvent("os.auth_recovered", { raisedAt: existing.raisedAt, failures: existing.failures }).catch(() => {});
      return "os auth recovered — alarm cleared";
    }
    return "os auth ok";
  }

  if (!alarmDue(state, now)) return `os auth failing for ${Math.round((now - state.firstAt) / 60_000)}m (${state.count}x) — alarm at 10m`;

  const lastAlerted = existing?.lastAlertedAt ? Date.parse(existing.lastAlertedAt) : 0;
  const alertNow = !existing || now - lastAlerted > OS_AUTH_REALERT_MS;
  const alarm: OsAuthAlarm = {
    raisedAt: existing?.raisedAt ?? new Date(now).toISOString(),
    firstFailureAt: new Date(state.firstAt).toISOString(),
    lastFailureAt: new Date(state.lastAt).toISOString(),
    failures: state.count,
    lastError: state.lastError,
    lastAlertedAt: alertNow ? new Date(now).toISOString() : existing?.lastAlertedAt,
  };
  await fs.writeFile(ALARM_FILE(), JSON.stringify(alarm, null, 2), "utf8").catch(() => {});
  await logEvent("os.auth_broken", { ...alarm, repair: "re-run the OS sign-in at /os/auth (interactive)" }, { level: "error" }).catch(() => {});
  if (alertNow) {
    const text = `FRIDAY has been cut off from the OS for ${Math.round((now - state.firstAt) / 60_000)} minutes (${state.lastError.slice(0, 120)}). Every OS call is failing. Re-run the OS sign-in at /os/auth.`;
    // 1) Through the OS: will fail while the session is broken, but notify.ts queues it locally and
    //    the hourly digest retries, so the owner still hears once the session is repaired.
    const notify = opts.notify ?? (async (i) => (await import("@/lib/friday/notify")).notifyOwner(i));
    await notify({ kind: "os.auth_broken", priority: "critical", text, dedupeKey: `os.auth_broken:${alarm.firstFailureAt}:${Math.floor(now / OS_AUTH_REALERT_MS)}` }).catch(() => {});
    // 2) Independent of the OS session: owner-alerts.log, a desktop notification and (when
    //    FRIDAY_ALERT_WEBHOOK_URL is set) a phone-reaching webhook.
    const local = opts.localAlert ?? (async (t: string, b: string) => (await import("@/lib/friday/ownerAlertRelay")).localOwnerAlert(t, b));
    await local("FRIDAY: OS session broken", text).catch(() => {});
  }
  return `OS AUTH BROKEN for ${Math.round((now - state.firstAt) / 60_000)}m (${state.count} failures) — alarm raised`;
}
