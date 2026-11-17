// FRIDAY → CLARA hand-offs. The CLARA app (127.0.0.1:3939) was retired into the OS, so nothing here
// POSTs to it any more (2026-10-29 follow-up of the FRIDAY audit):
//   * owner status texts (textOwnerAbout*)   → notifyOwner → OS agent_notify_owner (Clara's ladder
//                                              delivers: failures are "timely", the rest wait for the brief)
//   * emergency escalation (escalateToClara) → notifyOwner(critical + category) — same OS channel
//   * scope-change meeting email             → client comms are OFF, so the owner is told to run the
//                                              scope call themselves; nothing is sent to the client
//   * delegateFromFriday (ask Clara in chat) → only if FRIDAY_CLARA_BASE_URL is set explicitly;
//                                              otherwise an honest "not available", never a dead port
// Public function names and signatures are unchanged so every call site keeps working.

import {
  tryFallbackChain, interagentAuthHeaders,
  type DelegateEndpoint, type DelegateOutcome, type EscalationRequest, type EscalationResponse,
} from "@autom8ionlab/agent-core";
import { notifyOwner, type Priority } from "@/lib/friday/notify";

/** Only set when a Clara chat endpoint really exists again; there is deliberately no default. */
const CLARA_BASE = (process.env.FRIDAY_CLARA_BASE_URL ?? "").replace(/\/$/, "");

// CLARA's /api/chat contract: { messages: [{role, content}] } → { text, engine, calls }.
const CLARA_ENDPOINTS: DelegateEndpoint[] = [
  {
    path: "/api/chat",
    buildBody: (prompt) => ({ messages: [{ role: "user", content: prompt }] }),
    timeoutMs: 120_000,
    extract: (j) => {
      const o = j as { text?: unknown; calls?: unknown };
      if (typeof o.text !== "string" || !o.text) return null;
      return { reply: o.text };
    },
  },
];

/** Kinds that mean something went wrong: "timely" (email now). Everything else waits for the brief. */
const FAILURE_KINDS: ReadonlySet<string> = new Set(["cr_pr_failed", "migrations_push_failed"]);

async function ownerStatus(input: { kind: string; text: string; dedupeKey: string }): Promise<void> {
  try {
    const priority: Priority = FAILURE_KINDS.has(input.kind) ? "critical" : "normal";
    await notifyOwner({ kind: input.kind, text: input.text, priority, dedupeKey: `${input.kind}:${input.dedupeKey}` });
  } catch { /* best-effort: the decision log still records it and the brief carries the summary */ }
}

/** Routine owner update about a change request FRIDAY handled (received / completed / PR merged / PR failed). */
export async function textOwnerAboutCr(input: {
  kind: "cr_received" | "cr_completed" | "cr_pr_failed" | "cr_pr_merged";
  text: string;
  dedupeKey: string;
}): Promise<void> {
  await ownerStatus(input);
}

/** Ops housekeeping updates: services restarted, stale branches found, a branch cleaned. */
export async function textOwnerAboutOps(input: {
  kind: "ops_services_restarted" | "ops_stale_branches" | "ops_branch_cleaned";
  text: string;
  dedupeKey: string;
}): Promise<void> {
  await ownerStatus(input);
}

/** A Supabase migration push ran or failed. */
export async function textOwnerAboutMigrations(input: {
  kind: "migrations_pushed" | "migrations_push_failed";
  text: string;
  dedupeKey: string;
}): Promise<void> {
  await ownerStatus(input);
}

/**
 * Scope-change meeting (owner rule 2026-08-29): the owner REJECTED an out-of-scope change request.
 * Clara used to email the client from her own app. Client comms are off and that app is gone, so the
 * hand-off is now a notice to the OWNER to schedule the scope call themselves. Returns ok so the caller
 * marks the CR dispatched; if the owner could not be told (OS down) it returns ok=false and the next
 * poll retries — notifyOwner dedupes on `dedupeKey`, so a retry never double-notifies.
 */
export async function requestScopeMeetingEmail(payload: {
  clientEmail: string;
  clientName?: string;
  projectName?: string;
  crTitle?: string;
  dedupeKey: string;
}): Promise<{ ok: boolean; id?: string; skipped?: string; error?: string }> {
  try {
    const who = [payload.clientName, payload.clientEmail].filter(Boolean).join(" ");
    const r = await notifyOwner({
      kind: "scope_meeting",
      priority: "critical",
      headline: `Scope call needed: ${payload.crTitle ?? "change request"}`,
      text: `You declined an out-of-scope change${payload.projectName ? ` on ${payload.projectName}` : ""}${payload.crTitle ? ` ("${payload.crTitle}")` : ""}. Client communications are off, so nothing was sent. Schedule a scope call with ${who || "the client"} yourself.`,
      dedupeKey: `scope_meeting:${payload.dedupeKey}`,
    });
    if (r.queued) return { ok: false, error: "owner notice queued: the OS is unreachable" };
    return { ok: true, skipped: "client-comms-off: owner told to schedule the call" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120) };
  }
}

export async function delegateFromFriday(agent: "clara", task: string): Promise<DelegateOutcome> {
  void agent;
  if (!CLARA_BASE) {
    return { ok: false, via: "none", error: "Clara's chat app is retired and has no endpoint now. Ask the owner in the OS Clara thread instead, or tell them the request." };
  }
  // Frame the ask so the receiver knows it came from a sibling, not the owner typing — the receiving
  // agent's own gates still apply (anything client-facing or irreversible queues for approval on
  // HER side; delegation never launders authority).
  const prompt = `[From FRIDAY, delegated] ${task}`;
  return tryFallbackChain(CLARA_BASE, CLARA_ENDPOINTS, prompt, { headers: interagentAuthHeaders() });
}

/**
 * Emergency escalation (owner rule 2026-09-24): FRIDAY never texts or phones the owner. A confirmed
 * production outage, a security finding, or a broken deploy goes to the OS as a critical owner
 * notification with a category; Clara's ladder there decides whether they are rung. If the OS is
 * unreachable notifyOwner queues it locally and the hourly digest retries.
 */
export async function escalateToClara(input: {
  category: EscalationRequest["category"];
  headline: string;
  detail: string;
  links?: Array<{ label: string; url: string }>;
  dedupeKey: string;
  kind: string;
  refId?: string;
  suggestedAction?: string;
  needsDecision?: { question: string; options: string[] };
  clientName?: string;
}): Promise<EscalationResponse> {
  const { logEvent } = await import("@/lib/persistence/store");
  try {
    const r = await notifyOwner({
      kind: input.kind,
      priority: "critical",
      emergencyCategory: input.category,
      text: input.detail.slice(0, 2000),
      headline: input.headline.slice(0, 120),
      summary: input.detail.slice(0, 2000),
      links: input.links,
      suggestedAction: input.suggestedAction,
      needsDecision: input.needsDecision,
      clientName: input.clientName,
      dedupeKey: input.dedupeKey,
    });
    if (r.queued) {
      await logEvent("escalate.failed", { kind: input.kind, category: input.category, error: "queued: OS unreachable" }, { level: "error" }).catch(() => {});
      return { ok: false, via: "escalate", error: "queued: OS unreachable" };
    }
    await logEvent("escalate.sent", { kind: input.kind, category: input.category, via: "os", escalated: r.escalated ?? false }, { level: "warn" }).catch(() => {});
    return { ok: true, via: "escalate", action: r.escalated ? "texted" : "emailed" };
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
    await logEvent("escalate.failed", { kind: input.kind, category: input.category, error }, { level: "error" }).catch(() => {});
    return { ok: false, via: "escalate", error };
  }
}
