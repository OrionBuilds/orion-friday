// Client comms → OS Conversations (audit gap 10, contract §4).
//
// Nothing FRIDAY said to a client used to reach the OS Conversations module. Portal comments, ticket
// and change-request replies posted through the OS portal tools are logged by the OS itself, so FRIDAY
// only logs what does NOT go through a portal tool: email drafts parked for approval (Clara sends them),
// and any direct email/SMS send left behind the legacy-channels rollback switch.
//
// Tolerant by contract: if `conversation_log_message` isn't deployed yet the miss is logged once
// (os.tool_missing) and the send/draft it describes is unaffected — logging must never block a send.

import { callOsTool, type CallOsToolOpts } from "@/lib/friday/osTool";

export interface ConversationLogInput {
  projectId?: string;   // OS project uuid, when known
  contactId?: string;   // OS contact uuid, when known
  channel: "portal" | "email" | "sms";
  direction?: "outbound" | "inbound";
  body: string;
  subject?: string;
  /** Dedupe key — the same external_id logged twice is one message. */
  externalId: string;
  metadata?: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build the tool args. Pure — exported for tests. Non-uuid ids are dropped (they are local ids, not OS ones). */
export function conversationLogArgs(i: ConversationLogInput): Record<string, unknown> {
  const args: Record<string, unknown> = {
    channel: i.channel,
    direction: i.direction ?? "outbound",
    body: i.body.slice(0, 8000),
    external_id: i.externalId.slice(0, 200),
  };
  if (i.projectId && UUID.test(i.projectId)) args.project_id = i.projectId;
  if (i.contactId && UUID.test(i.contactId)) args.contact_id = i.contactId;
  if (i.subject) args.subject = i.subject.slice(0, 300);
  args.metadata = { agent: "friday", ...(i.metadata ?? {}) };
  return args;
}

/** Log one client-facing message. Never throws; returns whether the OS accepted it. */
export async function logClientConversation(i: ConversationLogInput, opts: CallOsToolOpts = {}): Promise<boolean> {
  try {
    const r = await callOsTool("conversation_log_message", conversationLogArgs(i), { ...opts, context: { externalId: i.externalId, ...(opts.context ?? {}) } });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * OS project id for a local project id, via the shared project_agent_meta cache in projectUrls.ts
 * (one mapping, not a second lookup). Local ids are uuids too, so a uuid is never assumed to be the
 * OS id. Best-effort: undefined when unmapped or the OS is unreachable.
 */
export async function osProjectIdFor(localProjectId: string | undefined): Promise<string | undefined> {
  if (!localProjectId) return undefined;
  const { osProjectUrlsFor, refreshOsProjectUrls } = await import("@/lib/friday/projectUrls");
  const cached = osProjectUrlsFor(localProjectId)?.osProjectId;
  if (cached) return cached;
  return (await refreshOsProjectUrls(true)).get(localProjectId)?.osProjectId;
}
