// FRIDAY — first-of-kind-then-auto format registry (Wave-2 Track B, 2026-07-30).
//
// The FIRST instance of each client-facing FORMAT per client gates for the owner (Tier 3). When the
// owner HUMAN-approves that format-stamped row, the (clientId, formatKind) pair is GRANTED here —
// and later instances of the exact same format ride Tier 2 (auto-send + digest note) once authority
// goes active. Under shadow authority the grant only changes what the shadow log SAYS would happen.
//
// The formats (stamped where the approvals are queued):
//   weekly_update     — the Friday client check-in email      (weeklyUpdate.ts → queueEmailApproval)
//   client_notify     — the "your work is delivered" note     (clientNotify.ts → queueEmailApproval)
//   meeting_followup  — the same-day meeting recap email      (ingest.ts → queueEmailApproval)
//
// Ad-hoc email replies never carry a formatKind — they stay hard Tier 3 (commitment by
// construction). Deploys are untouched: always gate. Revoke any grant with
// "revoke <format> for <client>" over SMS or POST /api/friday/authority.
// Independent implementation — sibling agents keep their own copy of this idea (owner hard rule: no shared code).

import { store, newId, nowISO, logEvent } from "@/lib/persistence/store";
import type { FormatGrant } from "@/lib/friday/types";

/** The format kinds FRIDAY stamps today (informational — the registry stores any string). */
export const FORMAT_KINDS = ["weekly_update", "client_notify", "meeting_followup"] as const;

/** The active grant for (clientId, formatKind), or null. Truthy ⇒ the format may auto-send. */
export async function formatGranted(clientId: string, formatKind: string): Promise<FormatGrant | null> {
  if (!clientId || !formatKind) return null;
  const rows = await store.formatGrants.find(
    (g) => g.clientId === clientId && g.formatKind === formatKind && g.status === "granted",
  );
  return rows[0] ?? null;
}

/**
 * Grant (clientId, formatKind) — called from decideApproval when a HUMAN approves a format-stamped
 * row. Idempotent: an existing active grant is returned untouched; a revoked grant is re-activated
 * (a fresh human approve after a revoke re-establishes trust).
 */
export async function grantFormat(
  clientId: string,
  formatKind: string,
  opts: { approvalId: string },
): Promise<FormatGrant> {
  const existing = (await store.formatGrants.find((g) => g.clientId === clientId && g.formatKind === formatKind))[0];
  if (existing?.status === "granted") return existing;
  const now = nowISO();
  if (existing) {
    // Re-grant after a revoke: same row, fresh provenance; the autoSendCount history carries on.
    const updated = await store.formatGrants.update(existing.id, {
      status: "granted", grantedAt: now, grantedFromApprovalId: opts.approvalId,
      revokedAt: undefined, revokedReason: undefined, updatedAt: now,
    });
    await logEvent("format.granted", { grantId: existing.id, clientId, formatKind, approvalId: opts.approvalId, regrant: true });
    return updated ?? existing;
  }
  const grant: FormatGrant = {
    id: newId(), clientId, formatKind, status: "granted",
    grantedAt: now, grantedBy: "owner", grantedFromApprovalId: opts.approvalId,
    autoSendCount: 0, createdAt: now, updatedAt: now,
  };
  await store.formatGrants.insert(grant);
  await logEvent("format.granted", { grantId: grant.id, clientId, formatKind, approvalId: opts.approvalId });
  return grant;
}

/** Revoke (clientId, formatKind) — the format gates again from the next instance on. */
export async function revokeFormat(clientId: string, formatKind: string, reason?: string): Promise<FormatGrant | null> {
  const grant = await formatGranted(clientId, formatKind);
  if (!grant) return null;
  const now = nowISO();
  const updated = await store.formatGrants.update(grant.id, {
    status: "revoked", revokedAt: now, revokedReason: reason ?? "owner revoke", updatedAt: now,
  });
  await logEvent("format.revoked", { grantId: grant.id, clientId, formatKind, reason });
  return updated ?? grant;
}

/** All grants (granted + revoked), newest grant first — the /api/friday/authority report reads this. */
export async function listGrants(): Promise<FormatGrant[]> {
  const rows = await store.formatGrants.all();
  return rows.sort((a, b) => (a.grantedAt < b.grantedAt ? 1 : -1));
}

/** Stamp one autonomous send onto the grant (active-mode Tier-2 auto path). Best-effort. */
export async function recordAutoSend(grantId: string): Promise<void> {
  const g = await store.formatGrants.get(grantId).catch(() => null);
  if (!g) return;
  await store.formatGrants
    .update(grantId, { autoSendCount: (g.autoSendCount ?? 0) + 1, lastAutoSentAt: nowISO(), updatedAt: nowISO() })
    .catch(() => null);
}

// ── Owner text command: "revoke <format> for <client>" ──────────────────────
// Resolved deterministically before the approval verbs (ownerCommands.handleOwnerApproval calls
// this first). Restrictive action (takes autonomy away), so it's safe over any channel.

const FORMAT_ALIASES: Record<string, string> = {
  "weekly update": "weekly_update", weekly_update: "weekly_update", weekly: "weekly_update",
  "client notify": "client_notify", client_notify: "client_notify", notify: "client_notify",
  "delivery note": "client_notify",
  "meeting followup": "meeting_followup", "meeting follow-up": "meeting_followup",
  meeting_followup: "meeting_followup", followup: "meeting_followup", "follow-up": "meeting_followup",
};

function resolveFormatKind(raw: string): string | null {
  const k = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return FORMAT_ALIASES[k] ?? (FORMAT_KINDS as readonly string[]).find((f) => f === k.replace(/ /g, "_")) ?? null;
}

/** Returns a reply string when the text was a revoke command, else null. */
export async function tryResolveRevokeCommand(text: string): Promise<string | null> {
  const m = text.trim().match(/^\s*revoke\s+(.+?)\s+for\s+(.+)$/i);
  if (!m) return null;
  const kind = resolveFormatKind(m[1]);
  if (!kind) return `I don't recognize the format "${m[1].trim()}". Formats: ${FORMAT_KINDS.join(", ")}.`;
  const who = m[2].trim();
  const clients = await store.clients.all();
  const hits = clients.filter((c) => c.name.toLowerCase().includes(who.toLowerCase()));
  if (hits.length !== 1) {
    return hits.length === 0
      ? `No client matches "${who}".`
      : `"${who}" matches ${hits.length} clients (${hits.map((c) => c.name).join(", ")}) — be more specific.`;
  }
  const client = hits[0];
  const revoked = await revokeFormat(client.id, kind, "owner revoke (text command)");
  return revoked
    ? `Revoked ${kind} for ${client.name} — the next one gates for your approval again.`
    : `${kind} was never granted for ${client.name} — every instance already gates.`;
}
