// FRIDAY → owner notifications. One throttle point for every proactive push to the operator.
// Callers: finalizeRun (every completed run), queueApproval (new gate), inbound client messages,
// and the scheduler jobs (briefs, nudges, uptime). Best-effort — never throws into the caller.
//
// Delivery (2026-10, one source of truth): every owner notification goes to the OS through the
// `agent_notify_owner` tool and CLARA's ladder there delivers it. FRIDAY has no mail or phone channel
// of her own any more, so she cannot text, call or email the owner herself.
//   * emergency  → priority critical + category: Clara texts (quiet hours demote all but
//                  production/security to email).
//   * timely     → critical without a category: Clara emails immediately.
//   * normal/low → handed to the OS as normal: held for Clara's morning brief.
// If the OS can't be reached the item is queued locally and retried by the next tick.
//
// What counts as an emergency is an ALLOWLIST (EMERGENCY_KINDS) — a critical must carry an explicit
// emergencyCategory AND an allowlisted kind, otherwise it demotes to timely. The old regex
// inference ("autoqa" → production, "engine.auth" → production …) paged the owner for a run that
// didn't change code and for an expired CLI login; those are brief items, not 3am pages.
//
// The DECISION belongs to the shared notify-policy module in agent-core; dedupe/queue state is
// file-backed (<FRIDAY_DATA_DIR>/notify-policy-state.json).

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, logEvent } from "@/lib/persistence/store";
import { osClient, osEnabled } from "@/lib/friday/osClient";
import {
  parseQuietHours,
  createNotifyPolicy,
  type NotifyPolicy,
  type NotifyPolicyRequest,
  type Priority as PolicyPriority,
  type EmergencyCategory,
  type QueuedNotification,
} from "@autom8ionlab/agent-core";

export type { EmergencyCategory };

// Quiet hours as "START-END" 24h local (default 22-7). Wraps midnight.
export function inQuietHours(d = new Date()): boolean {
  return parseQuietHours(process.env.FRIDAY_QUIET_HOURS?.trim() || "22-7", d);
}

// ── Shared policy engine ─────────────────────────────────────────────────
function policy(): NotifyPolicy {
  const g = globalThis as unknown as { __fridayNotifyPolicy?: NotifyPolicy };
  if (!g.__fridayNotifyPolicy) {
    g.__fridayNotifyPolicy = createNotifyPolicy({
      app: "FRIDAY",
      dataDir: FRIDAY_DATA_DIR,
      quietHours: process.env.FRIDAY_QUIET_HOURS?.trim() || "22-7",
      perKindHourlyCap: EMERGENCY_HOURLY_CAP,
      isAway: async () => {
        try {
          const { isAway } = await import("@/lib/friday/ownerStatus");
          return await isAway();
        } catch {
          return false; // status read failed — treat as present
        }
      },
    });
  }
  return g.__fridayNotifyPolicy;
}

// Emergencies are an allowlist. Each kind names the ONE situation that justifies interrupting the
// owner through CLARA: a confirmed production outage, a security finding, or a deploy that left
// production broken. Everything else that used to be "critical" is now timely (immediate email).
export const EMERGENCY_KINDS: ReadonlySet<string> = new Set(["uptime.down", "security.finding", "deploy.broken", "approval.merge_ready"]);

// Per-kind hourly caps so a flapping probe can't turn one outage into a stream of escalations.
const EMERGENCY_HOURLY_CAP: Record<string, number> = { "uptime.down": 2, "security.finding": 3, "deploy.broken": 2 };

const QUEUE_FILE = path.join(FRIDAY_DATA_DIR, "notify-queue.json");
interface Queued { kind: string; text: string; at: string }

/** Strip emoji/pictographs from owner-facing text (constitution rule 20: no emoji anywhere). */
export function stripEmoji(s: string): string {
  return s.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+/gm, "").trim();
}

export interface NotifyLink { label: string; url: string }
export interface NeedsDecision { question: string; options: string[]; approvalId?: string }

export type Priority = "critical" | "normal" | "low";

export interface NotifyOpts {
  kind: string;        // short tag for logs/dedupe, e.g. "run.done" | "approval" | "nudge"
  text: string;        // the SMS body (and the email body, unless emailText overrides it)
  priority?: Priority; // critical = emergency (with category) or timely; normal/low = batched
  email?: boolean;     // also email the owner's own address (for longer/durable notices)
  emailText?: string;  // richer body for the email channel — SMS pays per segment, email doesn't
  subject?: string;    // email subject (defaults from kind)
  dedupeKey?: string;  // override the dedupe key (defaults to kind+text)
  // Names WHY a critical is an emergency (revenue/production/security). A critical without one, or
  // whose kind is not in EMERGENCY_KINDS, demotes to timely (immediate email).
  emergencyCategory?: EmergencyCategory;
  // Structured payload (2026-09-24): what the brief/email renders. `text` stays as the fallback line.
  headline?: string;
  summary?: string;
  links?: NotifyLink[];
  needsDecision?: NeedsDecision;
  /** Emergency only: what CLARA should suggest / ask. */
  suggestedAction?: string;
  clientName?: string;
}

// ── Transport: the OS ────────────────────────────────────────────────────────
export interface OwnerMessage { kind: string; priority: Priority; category?: string; text: string; dedupeKey: string }
export type OwnerTransport = (m: OwnerMessage) => Promise<boolean>;

const osTransport: OwnerTransport = async (m) => {
  if (!osEnabled()) return false;
  try {
    await osClient.callTool("agent_notify_owner", {
      kind: m.kind, priority: m.priority, text: m.text.slice(0, 4000), category: m.category, dedupe_key: m.dedupeKey.slice(0, 200),
    });
    return true;
  } catch {
    return false;
  }
};
let transport: OwnerTransport = osTransport;
/** Tests only: replace the OS transport. */
export function _setOwnerTransport(t: OwnerTransport | null): void { transport = t ?? osTransport; }

/** The body Clara delivers: what happened / what I need / links, plain text, no emoji, headline first. */
function ownerBody(opts: NotifyOpts): string {
  const head = opts.headline ? `${stripEmoji(opts.headline)}\n\n` : "";
  return `${head}${renderOwnerEmail(opts)}`;
}

/** Plain-text owner email: what happened / why it matters / what I did or need / links. */
export function renderOwnerEmail(opts: NotifyOpts): string {
  if (!opts.headline && !opts.summary && !opts.links?.length && !opts.needsDecision) return stripEmoji(opts.emailText ?? opts.text);
  const parts: string[] = [];
  parts.push(`What happened\n${stripEmoji(opts.summary ?? opts.emailText ?? opts.text)}`);
  if (opts.needsDecision) {
    parts.push(`What I need\n${stripEmoji(opts.needsDecision.question)} (${opts.needsDecision.options.join(" / ")}) — decide it in your OS approval inbox, or tell Clara by text or call.`);
  } else {
    parts.push("What I need\nNothing from you right now.");
  }
  if (opts.links?.length) parts.push(`Links\n${opts.links.map((l) => `${l.label}: ${l.url}`).join("\n")}`);
  return parts.join("\n\n");
}

// Reach the owner. Returns which channels fired (or that it was queued for the digest).
// `sms` is kept in the return shape for callers but is always false now — FRIDAY never texts.
export async function notifyOwner(input: NotifyOpts): Promise<{ sms: boolean; email: boolean; queued: boolean; escalated?: boolean }> {
  const opts: NotifyOpts = { ...input, text: stripEmoji(input.text), ...(input.headline ? { headline: stripEmoji(input.headline) } : {}), ...(input.summary ? { summary: stripEmoji(input.summary) } : {}) };
  const priority = opts.priority ?? "normal";
  const isEmergency = priority === "critical" && Boolean(opts.emergencyCategory) && EMERGENCY_KINDS.has(opts.kind);
  const mapped: PolicyPriority = priority === "critical" ? (isEmergency ? "emergency" : "timely") : priority;
  const category = isEmergency ? opts.emergencyCategory : undefined;
  const req: NotifyPolicyRequest = {
    kind: opts.kind,
    text: opts.text,
    priority: mapped,
    category,
    dedupeKey: opts.dedupeKey ?? `${opts.kind}:${opts.text}`,
    meta: {
      ...(opts.emailText ? { emailText: stripEmoji(opts.emailText) } : {}),
      ...(opts.subject ? { subject: stripEmoji(opts.subject) } : {}),
      ...(opts.headline ? { headline: opts.headline } : {}),
      ...(opts.summary ? { summary: opts.summary } : {}),
      ...(opts.links?.length ? { links: opts.links } : {}),
      ...(opts.needsDecision ? { needsDecision: opts.needsDecision } : {}),
    },
  };
  const decision = await policy().decide(req);
  if (decision.action === "drop") return { sms: false, email: false, queued: false };
  const msg = (priorityOut: Priority, categoryOut?: string): OwnerMessage => ({
    kind: opts.kind, priority: priorityOut, category: categoryOut, text: ownerBody(opts), dedupeKey: req.dedupeKey!,
  });

  if (decision.action === "queue") {
    // Held for the brief: the OS keeps it as a normal item. Local queue only if the OS is unreachable.
    if (await transport(msg("normal"))) {
      await policy().commit(req);
    } else {
      await policy().enqueue(req);
    }
    await logEvent("notify.queued", { kind: opts.kind, priority, reason: decision.reason }).catch(() => {});
    return { sms: false, email: false, queued: true };
  }

  const out = { sms: false, email: false, queued: false, escalated: false };
  const emergency = decision.channels.includes("sms");
  const delivered = await transport(msg("critical", emergency ? category : undefined));
  if (!delivered) {
    // Nobody received it: queue instead of committing, or the dedupe key would swallow retries.
    await policy().enqueue(req);
    await logEvent("notify.queued", { kind: opts.kind, priority, reason: "os-unreachable" }).catch(() => {});
    return { sms: false, email: false, queued: true, escalated: false };
  }
  out.escalated = emergency; // Clara owns whether the owner is rung/texted
  out.email = !emergency;
  await policy().commit(req);
  await logEvent("notify.owner", { kind: opts.kind, priority, policyPriority: decision.priority, demoted: decision.demoted ?? false, escalated: out.escalated, via: "os" }).catch(() => {});
  return out;
}

// ── Brief-section surface (Wave 4) ───────────────────────────────────────
// CLARA's 8am executive brief drains this queue TWO-PHASE: GET /api/friday/brief-section peeks
// (non-destructive), and only after the brief email actually delivered does CLARA POST the
// consumed ids back for ack. A failed brief delivery acks nothing — the items simply reappear
// in the next brief (and, past 24h, in flushDigest's fallback below).
export async function peekQueuedNotifications(): Promise<QueuedNotification[]> {
  return policy().peekQueue();
}

export async function ackQueuedNotifications(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  return policy().ackQueue(ids);
}

// Digest fallback. The OS now holds batched items for Clara's morning brief and delivers them; this
// hourly job only retries items that could not reach the OS (they sit in the local queue). Acks only
// what the OS accepted.
export async function flushDigest(): Promise<string> {
  const queued = await policy().peekQueue();
  if (!queued.length) return "empty";
  const sent: string[] = [];
  for (const i of queued) {
    const m = (i.meta ?? {}) as { headline?: string };
    const ok = await transport({ kind: i.kind, priority: "normal", text: stripEmoji(m.headline ? `${m.headline}\n\n${i.text}` : i.text), dedupeKey: `retry:${i.id}` });
    if (ok) sent.push(i.id);
  }
  if (sent.length) {
    await policy().ackQueue(sent);
    await logEvent("notify.digest", { count: sent.length, channel: "os" }).catch(() => {});
  }
  return `${sent.length}/${queued.length} handed to the OS`;
}

/** Can FRIDAY reach the owner at all? Only through the OS now. */
export function ownerReachable(): boolean {
  return osEnabled();
}
