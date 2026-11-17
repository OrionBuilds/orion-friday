// Stuck change-request escalation (2026-10-28 audit, gap 5).
//
// The hourly change_request_triage swept 15 in_progress CRs untouched since 2026-10-05 (and one
// under_review since 2026-08-24) for weeks, reporting "0 to review, 0 dispatched" each time:
// nothing ever told the owner they were stuck. Now any CR that has sat in `in_progress` or
// `under_review` for more than STUCK_DAYS is escalated to the owner ONCE (dedupe key
// `cr-stuck:<id>`, persisted in FRIDAY_DATA_DIR/cr-stuck-escalations.json so a restart doesn't
// re-page) through notifyOwner → agent_notify_owner, i.e. the OS sends the one notification.

import path from "node:path";
import { promises as fs } from "node:fs";
import { FRIDAY_DATA_DIR, logEvent } from "@/lib/persistence/store";

export const STUCK_DAYS = 7;
const STUCK_STATUSES = new Set(["in_progress", "under_review"]);
const LEDGER = () => path.join(FRIDAY_DATA_DIR, "cr-stuck-escalations.json");

export interface StuckCrCandidate {
  id: string;
  project_id: string;
  title?: string;
  status: string;
  updated_at?: string | null;
  reviewed_at?: string | null;
  approved_at?: string | null;
  created_at?: string | null;
}

/** When the CR entered its current state, best available: the latest of the status timestamps + updated_at. */
export function crStateSince(cr: StuckCrCandidate): number | null {
  const ts = [cr.updated_at, cr.approved_at, cr.reviewed_at, cr.created_at]
    .map((v) => (v ? Date.parse(v) : NaN))
    .filter((n) => Number.isFinite(n));
  return ts.length ? Math.max(...ts) : null;
}

/** Pure: CRs stuck > `days` in in_progress/under_review that haven't been escalated yet. */
export function findStuckCrs<T extends StuckCrCandidate>(
  crs: T[], now: number, escalated: ReadonlySet<string>, opts: { days?: number; exclude?: (cr: T) => boolean } = {},
): Array<T & { stuckDays: number }> {
  const limitMs = (opts.days ?? STUCK_DAYS) * 86_400_000;
  const out: Array<T & { stuckDays: number }> = [];
  for (const cr of crs) {
    if (!STUCK_STATUSES.has(cr.status)) continue;
    if (escalated.has(cr.id)) continue;
    if (opts.exclude?.(cr)) continue;
    const since = crStateSince(cr);
    if (since === null || now - since <= limitMs) continue;
    out.push({ ...cr, stuckDays: Math.floor((now - since) / 86_400_000) });
  }
  return out;
}

export async function loadEscalated(): Promise<Record<string, string>> {
  try { return JSON.parse(await fs.readFile(LEDGER(), "utf8")) as Record<string, string>; }
  catch { return {}; }
}

async function saveEscalated(map: Record<string, string>): Promise<void> {
  await fs.writeFile(LEDGER(), JSON.stringify(map, null, 2), "utf8");
}

export interface StuckEscalationOutcome {
  escalated: number;
  alerts: Array<Record<string, unknown>>;
}

/**
 * Escalate each newly-stuck CR once. `notify` defaults to notifyOwner (OS agent_notify_owner).
 * Only records the dedupe key when the notification was delivered or queued for retry.
 * Never throws — a failure leaves the CR un-recorded so the next sweep retries.
 */
export async function escalateStuckCrs(
  crs: StuckCrCandidate[],
  opts: {
    now?: number;
    projectName?: (osProjectId: string) => string | undefined;
    exclude?: (cr: StuckCrCandidate) => boolean;
    notify?: (input: { kind: string; priority: "normal" | "critical"; text: string; dedupeKey: string }) => Promise<{ email: boolean; queued: boolean; escalated?: boolean }>;
  } = {},
): Promise<StuckEscalationOutcome> {
  const out: StuckEscalationOutcome = { escalated: 0, alerts: [] };
  try {
    const ledger = await loadEscalated();
    const stuck = findStuckCrs(crs, opts.now ?? Date.now(), new Set(Object.keys(ledger)), { exclude: opts.exclude });
    if (!stuck.length) return out;
    const notify = opts.notify ?? (async (i) => (await import("@/lib/friday/notify")).notifyOwner(i));
    for (const cr of stuck) {
      const dedupeKey = `cr-stuck:${cr.id}`;
      const proj = opts.projectName?.(cr.project_id);
      const text =
        `Change request "${(cr.title ?? "untitled").slice(0, 100)}"${proj ? ` on ${proj}` : ""} has been ` +
        `${cr.status.replace("_", " ")} for ${cr.stuckDays} days with no movement. ` +
        `It needs a decision: re-dispatch the work, close it, or tell me what's blocking it.`;
      try {
        const r = await notify({ kind: "cr.stuck", priority: "normal", text, dedupeKey });
        if (r.email || r.queued || r.escalated) {
          ledger[cr.id] = new Date().toISOString();
          out.escalated++;
        }
      } catch (e) {
        await logEvent("cr.stuck.notify_failed", { id: cr.id, error: String(e).slice(0, 200) }, { level: "warn" }).catch(() => {});
      }
      out.alerts.push({ kind: "cr.stuck", text, priority: "warn", dedupeKey });
    }
    await saveEscalated(ledger);
  } catch (e) {
    await logEvent("cr.stuck.error", { error: String(e).slice(0, 200) }, { level: "warn" }).catch(() => {});
  }
  return out;
}
