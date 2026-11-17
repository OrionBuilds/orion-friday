// FRIDAY <-> Orion approvals (audit 2026-10-28 gap 9; contract §3 + changes §D).
//
// The OS approval queue (workflow_approval_queue, source='agent_approval', agent_slug='friday') is the
// ONLY authority for an ask. The local approvals.json row is just the execution payload FRIDAY needs to
// carry out a decision (which task/deploy/PR/draft) — it never decides anything on its own:
//   * RAISE: an ask counts as raised only once agent_approval_mirror returns the hub row id. It is
//     written synchronously with retries (raiseApproval); an ask that could not be raised is retried
//     on every bridge tick until it lands. Pending local asks from before this change are migrated
//     the same way at startup (idempotent on external_ref).
//   * NOTIFY: the OS sends exactly ONE owner notification per ask (DB trigger on insert). FRIDAY never
//     sends its own approval email/SMS/notify for an ask.
//   * EXPIRE: one window — 48 h after requestedAt (the OS enforces it). An expired ask is status
//     `expired` locally: no decision, never a reject (no reject side effects run).
//   * DECIDE: decisions come from the hub (pullAndApplyDecisions → decideApproval source "os").
//     Local surfaces (SMS/email/dashboard/CLARA) may no longer decide an ask that is in the hub —
//     decideApproval refuses them and points to the OS queue. The authority auto-lane (asks that were
//     never questions for the owner and never reach the hub) is unchanged.
//
// Every entry point is best-effort and NEVER throws into its caller.
//
// Kill switch: FRIDAY_OS_BRIDGE=off (then nothing can be raised — asks wait locally, unraised).

import { osClient, osEnabled } from "@/lib/friday/osClient";
import { store, logEvent } from "@/lib/persistence/store";
import type { Approval } from "@/lib/friday/types";

import { dial } from "@/lib/friday/dials";

const AGENT_SLUG = "friday";

// Test seam: every hub call goes through hubCall (defaults to FRIDAY's native OS client).
type HubCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
let hubCall: HubCall = (tool, args) => osClient.callTool(tool, args);
let forceEnabled = false;
/** Test hook: route hub calls to a fake (and treat the bridge as enabled); null restores the default. */
export function _setHubCallForTests(fn: HubCall | null): void {
  hubCall = fn ?? ((tool, args) => osClient.callTool(tool, args));
  forceEnabled = Boolean(fn);
}

export function osBridgeEnabled(): boolean {
  if (forceEnabled) return true;
  if (dial("os_bridge") === "off") return false; // dial > FRIDAY_OS_BRIDGE > "on"
  return osEnabled();
}

// MCP tool results arrive as [{ type: "text", text: "<json>" }] — same unwrap as osTasks.ts.
function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

/** One expiry for every ask (contract §3): 48 h after it was requested. */
export const APPROVAL_TTL_MS = 48 * 3600_000;
export function expiresAtFor(a: Pick<Approval, "requestedAt">): string | undefined {
  const base = Date.parse(a.requestedAt);
  if (!Number.isFinite(base)) return undefined;
  return new Date(base + APPROVAL_TTL_MS).toISOString();
}

function actionTypeFor(a: Approval): string {
  if (a.emailDraftId) return "email_reply";
  if (a.deployProjectId) return "deploy";
  if (a.taskId) return "task_dispatch";
  return "agent_approval";
}

/** The hub row id from agent_approval_mirror's answer (`{approval:{id}}`, `{id}` or a row array). */
export function hubIdOf(res: unknown): string | null {
  if (Array.isArray(res)) return hubIdOf(res[0]);
  if (!res || typeof res !== "object") return null;
  const o = res as { id?: unknown; approval?: { id?: unknown } | null };
  if (o.approval && typeof o.approval.id === "string") return o.approval.id;
  if (typeof o.id === "string") return o.id;
  return null;
}

/**
 * Raise one pending ask in the OS queue — synchronously, with retries. Idempotent server-side on
 * (agent_slug, external_ref): re-raising returns the existing row and sends no new notification.
 * Returns true only when the hub row exists (its id is then stored as `hubId` on the local row).
 * Never throws.
 */
export async function raiseApproval(approval: Approval, opts: { attempts?: number; backoffMs?: number } = {}): Promise<boolean> {
  if (!osBridgeEnabled()) return false;
  const attempts = Math.max(1, opts.attempts ?? 3);
  const facts: Record<string, unknown> = {};
  if (approval.projectId) facts.projectId = approval.projectId;
  if (approval.emailClientId) facts.emailClientId = approval.emailClientId;
  if (approval.formatKind) facts.formatKind = approval.formatKind;
  if (approval.mergePrUrl) facts.prUrl = approval.mergePrUrl;
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const raw = await hubCall("agent_approval_mirror", {
        agent_slug: AGENT_SLUG,
        external_ref: approval.id,
        title: approval.action.slice(0, 200),
        description: approval.detail || undefined,
        risk: approval.risk,
        action_type: actionTypeFor(approval),
        facts,
        expires_at: expiresAtFor(approval),
        ...(await principalRouting(approval)),
      });
      const res = unwrap(raw) as { created?: boolean } | undefined;
      const hubId = hubIdOf(res);
      if (!hubId) throw new Error("agent_approval_mirror returned no approval id");
      await store.approvals.update(approval.id, { hubId, hubRaisedAt: new Date().toISOString() }).catch(() => {});
      await logEvent("os-bridge.raised", { id: approval.id, hubId, created: res?.created ?? null, action: approval.action.slice(0, 80) }, { projectId: approval.projectId }).catch(() => {});
      return true;
    } catch (e) {
      lastError = String(e).slice(0, 200);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, (opts.backoffMs ?? 750) * (i + 1)));
    }
  }
  await logEvent(
    "os-bridge.raise_failed",
    { id: approval.id, error: lastError, note: "ask NOT raised yet — retried on every bridge tick" },
    { level: "warn", projectId: approval.projectId },
  ).catch(() => {});
  return false;
}

/** Back-compat name: every former "mirror" call is now a synchronous raise. */
export const mirrorApproval = raiseApproval;

/**
 * The local decide spine ran — supersede the still-pending hub mirror row so the hub can't
 * double-decide. If the hub decided FIRST (returns superseded:false with a decided row), the
 * local decision already executed and CAS means first-wins: we only LOG the conflict when the
 * two decisions differ; the pull loop has already acked (or will ack) the hub row.
 */
export async function closeApproval(
  approvalId: string,
  outcome: "approved" | "rejected" | "expired",
): Promise<void> {
  if (!osBridgeEnabled()) return;
  try {
    const raw = await hubCall("agent_approval_close", {
      agent_slug: AGENT_SLUG,
      external_ref: approvalId,
      outcome,
    });
    const res = unwrap(raw) as
      | { superseded?: boolean; approval?: { status?: string } | null; reason?: string }
      | undefined;
    if (res && res.superseded === false && res.approval) {
      const hubStatus = res.approval.status;
      if ((hubStatus === "approved" || hubStatus === "rejected" || hubStatus === "expired") && hubStatus !== outcome) {
        // Both surfaces decided, differently. The LOCAL decision already executed (first wins);
        // nothing to undo — record the conflict so it's visible in the event log / brief.
        await logEvent(
          "os-bridge.decision_conflict",
          { id: approvalId, local: outcome, hub: hubStatus, reason: res.reason },
          { level: "warn" },
        ).catch(() => {});
      }
    }
  } catch (e) {
    await logEvent(
      "os-bridge.close_failed",
      { id: approvalId, outcome, error: String(e).slice(0, 200) },
      { level: "warn" },
    ).catch(() => {});
  }
}

// Startup migration + raise retry. The first tick after boot raises EVERY pending local ask (pending
// rows from before the OS became authoritative get their hub row and hubId — idempotent on
// external_ref); every later tick re-raises only asks that are still unraised (an earlier raise
// failed). Single-attempt per tick so one OS outage can't stall the heartbeat.
let migrated = false;
async function raisePendingAsks(): Promise<void> {
  const pending = await store.approvals.find((a) => a.status === "pending");
  let allOk = true;
  for (const a of pending) {
    if (migrated && a.hubId) continue;
    if (!(await raiseApproval(a, { attempts: 1 }))) allOk = false;
  }
  if (allOk) migrated = true;
}

/** An OS-expired ask: no decision. Never a reject — no reject side effects run. */
export async function markExpired(ref: string): Promise<boolean> {
  const done = await store.approvals.update(
    ref,
    {
      status: "expired",
      decidedAt: new Date().toISOString(),
      decidedBy: "os (expired)",
      resultNote: "expired in the OS approval queue after 48h with no decision — not rejected; re-ask if still needed",
    },
    { onlyIf: (row) => row.status === "pending" },
  ).catch(() => null);
  return Boolean(done);
}

interface HubDecisionRow {
  id: string;
  external_ref: string | null;
  status: string; // approved | rejected | expired
  title?: string;
}

/**
 * One bridge heartbeat: back-mirror (first tick only), pull decided-but-unacked hub rows, apply
 * each through the LOCAL decide spine (idempotent — a row already decided locally no-ops), then
 * ack ALL pulled ids (including no-ops/skips, so they never re-pull forever). Returns a summary
 * string for the scheduler log; never throws.
 */
export async function pullAndApplyDecisions(): Promise<string> {
  if (!osBridgeEnabled()) return "bridge off";
  try {
    await raisePendingAsks().catch(() => {});

    const raw = await hubCall("agent_approval_pull_decisions", { agent_slug: AGENT_SLUG, limit: 50 });
    const rows = (unwrap(raw) as HubDecisionRow[] | undefined) ?? [];
    if (!Array.isArray(rows) || rows.length === 0) return "bridge: no decisions";

    const { decideApproval } = await import("@/lib/friday/orchestrator");
    let applied = 0;
    let skipped = 0;
    for (const row of rows) {
      const ref = row.external_ref;
      if (!ref) { skipped++; continue; }
      try {
        const local = await store.approvals.get(ref);
        if (!local) {
          skipped++;
          await logEvent("os-bridge.unknown_ref", { hubId: row.id, ref, status: row.status }, { level: "warn" }).catch(() => {});
        } else if (row.status === "approved" || row.status === "rejected") {
          if (local.status !== "pending" && local.status !== row.status) {
            // Decided on both surfaces, differently — local already executed, first wins.
            await logEvent("os-bridge.decision_conflict", { id: ref, local: local.status, hub: row.status }, { level: "warn" }).catch(() => {});
            skipped++;
          } else {
            await decideApproval(ref, row.status, { source: "os" }); // CAS no-op if already same
            applied++;
          }
        } else if (row.status === "expired") {
          // Expired = NO decision (contract §3). Never reject: the local row goes to `expired`, the
          // reject side effects do not run, and the work simply isn't done unless re-asked.
          if (local.status === "pending" && (await markExpired(ref))) {
            await logEvent("os-bridge.expired", { id: ref, action: local.action.slice(0, 80) }, { projectId: local.projectId }).catch(() => {});
            applied++;
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
      } catch (e) {
        skipped++;
        await logEvent("os-bridge.apply_failed", { ref, status: row.status, error: String(e).slice(0, 200) }, { level: "warn" }).catch(() => {});
      }
    }

    // Ack everything we pulled — even skips/no-ops — or the same rows re-pull every tick.
    try {
      await hubCall("agent_approval_ack", { ids: rows.map((r) => r.id) });
    } catch (e) {
      await logEvent("os-bridge.ack_failed", { ids: rows.length, error: String(e).slice(0, 200) }, { level: "warn" }).catch(() => {});
    }
    return `bridge: pulled ${rows.length}, applied ${applied}, skipped ${skipped}`;
  } catch (e) {
    await logEvent("os-bridge.pull_failed", { error: String(e).slice(0, 200) }, { level: "warn" }).catch(() => {});
    return "bridge: pull failed";
  }
}

// G3 — contact-rooted approval routing: an approval about a client owned by a non-primary
// principal notifies THAT principal's queue. Client resolved from the approval's
// emailClientId, else through its project. Owner ids come from the client mirror's
// osOwnerUserId (stamped by ContactsSync); unknown/primary owners keep today's behavior.
async function principalRouting(approval: { emailClientId?: string; projectId?: string }): Promise<Record<string, string>> {
  try {
    const { store } = await import("@/lib/persistence/store");
    let clientId = approval.emailClientId;
    if (!clientId && approval.projectId) {
      const project = await store.projects.get(approval.projectId);
      clientId = project?.clientId;
    }
    if (!clientId) return {};
    const { getPrincipals, getPrimaryPrincipal } = await import("@autom8ionlab/agent-core");
    const client = await store.clients.get(clientId);
    const ownerId = (client as { osOwnerUserId?: string } | null)?.osOwnerUserId;
    if (!ownerId || ownerId === getPrimaryPrincipal().osUserId) return {};
    const p = getPrincipals().find((x) => x.osUserId === ownerId);
    return p ? { principal_user_id: p.osUserId } : {};
  } catch {
    return {};
  }
}
