// Retainer clients (owner rule 2026-09-29).
//
// The owner's rule: anything coming from a retainer client does not require approvals — if they ask
// for something, go ahead and do it. If FRIDAY is unclear about the client's request, ensure they
// follow up and get clarifying questions answered so the task can be executed.
//
// So for a retainer client the scope gate is gone: an ask that would have been parked as "new" or
// "out of scope" for the owner is executed instead. What stays: money and contract/signature text still get
// one owner OK (decideAutonomy checks those before anything else), critical-risk work still stops, and
// an unclear ask goes back to the requester through the normal clarify flow, never to the owner.
//
// Matching is by any of: FRIDAY client id, FRIDAY or OS project id, exact requester email, or email
// domain — but callers must only pass identity they can trust: portal CRs match by OS project only
// (the portal link is scoped to one project; the form's email is typed in by the submitter), and
// the email channel only after the sender passed DMARC/aligned DKIM (emailAgent.senderAuthenticated).
// Retainer clients are added without a deploy via FRIDAY_RETAINER_CLIENTS (JSON, same shape
// as RetainerClient, one object or an array).

export interface RetainerClient {
  name: string;
  clientIds?: string[];
  /** FRIDAY local project ids and/or OS project ids. */
  projectIds?: string[];
  emails?: string[];
  domains?: string[];
}

// Built-in list is empty; configure retainer clients via FRIDAY_RETAINER_CLIENTS.
export const RETAINER_CLIENTS: RetainerClient[] = [];

function envClients(raw = process.env.FRIDAY_RETAINER_CLIENTS): RetainerClient[] {
  if (!raw?.trim()) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    const list = Array.isArray(v) ? v : [v];
    const strArr = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
    // Shape-checked, not just name-checked: a string where an array belongs (or a non-string item)
    // would throw inside retainerFor and fail every client request and CR triage.
    return list.filter((c): c is RetainerClient => {
      if (!c || typeof c !== "object") return false;
      const o = c as RetainerClient;
      return typeof o.name === "string" && strArr(o.clientIds) && strArr(o.projectIds) && strArr(o.emails) && strArr(o.domains);
    });
  } catch {
    return [];
  }
}

export function retainerClients(raw?: string): RetainerClient[] {
  return [...RETAINER_CLIENTS, ...envClients(raw)];
}

export interface RetainerQuery {
  clientId?: string | null;
  projectId?: string | null;
  osProjectId?: string | null;
  email?: string | null;
}

function emailOf(s: string | null | undefined): string | null {
  if (!s) return null;
  // Accept "Name <addr>" as well as a bare address.
  const m = s.match(/<([^>]+)>/);
  const addr = (m ? m[1] : s).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : null;
}

/** Which retainer client (if any) this request belongs to. Pure except for the env read. */
export function retainerFor(q: RetainerQuery, raw?: string): RetainerClient | null {
  const email = emailOf(q.email);
  const domain = email ? email.slice(email.lastIndexOf("@") + 1) : null;
  for (const c of retainerClients(raw)) {
    if (q.clientId && c.clientIds?.includes(q.clientId)) return c;
    if (q.projectId && c.projectIds?.includes(q.projectId)) return c;
    if (q.osProjectId && c.projectIds?.includes(q.osProjectId)) return c;
    if (email && c.emails?.some((e) => e.toLowerCase() === email)) return c;
    if (domain && c.domains?.some((d) => d.toLowerCase() === domain)) return c;
  }
  return null;
}

export function isRetainer(q: RetainerQuery, raw?: string): boolean {
  return retainerFor(q, raw) !== null;
}

/** The reason line recorded when the retainer rule replaces the scope gate. */
export function retainerReason(c: RetainerClient): string {
  return `retainer client (${c.name}) — no approval gate, owner rule 2026-09-29`;
}

/**
 * The retainer client for a client-request intake, using only identity the channel can vouch for:
 * a verified sender (email DMARC/DKIM, sms/voice number) may match by client, project or email; an
 * OS portal item (`os_ticket`) matches by its project only, since the project comes from the OS record
 * and the requester email on it is free text. Anything else gets no retainer treatment.
 */
export function retainerForIntake(
  input: { channel: string; senderVerified?: boolean; clientId: string; projectId: string; email?: string | null },
  raw?: string,
): RetainerClient | null {
  // Portal items first, and by project only — a caller marking one "verified" must not let the
  // free-text requester email or the resolved client id decide.
  if (input.channel === "os_ticket") return retainerFor({ projectId: input.projectId }, raw);
  if (input.senderVerified) return retainerFor({ clientId: input.clientId, projectId: input.projectId, email: input.email }, raw);
  return null;
}
