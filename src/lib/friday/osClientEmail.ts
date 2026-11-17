// Client email, the one-source-of-truth way: FRIDAY never sends mail. When she has something to say to a
// client by email she DRAFTS it into the owner's approval queue in the OS; Clara sends it from her
// mailbox only after they approve. Idempotent on the external ref, so a retried job can't queue it twice.

import { osClient, osEnabled } from "@/lib/friday/osClient";

export interface DraftInput {
  /** OS contact UUID (Client.osContactId). */
  contactId: string;
  subject: string;
  body: string;
  /** Stable key, e.g. `weekly:<clientId>:<isoWeek>`. */
  externalRef: string;
  /** One line for the approval card. */
  summary?: string;
}

export type DraftResult = { ok: true; created: boolean; approvalId?: string } | { ok: false; error: string };

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

export type DraftCaller = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export async function draftClientEmail(i: DraftInput, call?: DraftCaller): Promise<DraftResult> {
  if (!call && !osEnabled()) return { ok: false, error: "OS not configured" };
  const c: DraftCaller = call ?? ((t, a) => osClient.callTool(t, a));
  try {
    const out = unwrap(await c("agent_draft_client_email", {
      contact_id: i.contactId, subject: i.subject.slice(0, 200), body: i.body, external_ref: i.externalRef.slice(0, 200), summary: i.summary?.slice(0, 500),
    })) as { created?: boolean; approval_id?: string; error?: string } | string | null;
    if (typeof out === "string") return { ok: false, error: out.slice(0, 200) };
    if (out && typeof out === "object" && out.error) return { ok: false, error: String(out.error).slice(0, 200) };
    const created = Boolean(out?.created);
    // Audit gap 10 / contract §4: an email draft is a non-portal client send, so it goes into the OS
    // Conversations log (deduped on the same external ref). Only a NEWLY created draft logs — a
    // re-queue of an existing ref is the same message. Tolerant: a missing tool never fails the draft.
    if (created) {
      const { logClientConversation } = await import("@/lib/friday/conversationLog");
      await logClientConversation({
        contactId: i.contactId, channel: "email", direction: "outbound",
        subject: i.subject, body: i.body, externalId: `friday-email:${i.externalRef}`,
        metadata: { status: "drafted_pending_approval", approval_id: out?.approval_id, external_ref: i.externalRef, sender: "clara_after_owner_approval" },
      }, call ? { client: { callTool: (t: string, a?: Record<string, unknown>) => c(t, a ?? {}) } } : {}).catch(() => false);
    }
    return { ok: true, created, approvalId: out?.approval_id };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

/** Draft a client email for the owner's approval, addressed via the client's OS contact. */
export async function queueClientEmail(
  client: { id: string; name: string; osContactId?: string; email?: string },
  o: { subject: string; body: string; ref: string; summary: string },
  call?: DraftCaller,
): Promise<DraftResult> {
  if (!client.email) return { ok: false, error: "client has no email address" };
  if (!client.osContactId) return { ok: false, error: `${client.name} has no OS contact yet (osContactId); sync clients first` };
  return draftClientEmail({ contactId: client.osContactId, subject: o.subject, body: o.body, externalRef: o.ref, summary: o.summary }, call);
}
