// FRIDAY — client welcome email (owner ask 2026-07-19: a real first-impression moment).
//
// Queued ONLY from the new-client form's "Send welcome email" checkbox (owner rule: new clients get
// a welcome, imported/existing relationships don't — the checkbox is the control). ALWAYS lands in
// the approve-to-send loop (Gmail draft + queueEmailApproval): a first impression is a hard Tier-3
// moment, no authority path, the owner reads every welcome before it leaves.
//
// Copy discipline: the deterministic template is the floor and the fallback. An optional LLM pass
// may only add warmth/personalization; its output must survive welcomeIssues() — which forbids
// dollars, concrete date promises, internal jargon, placeholders — and must KEEP the honest-AI
// disclosure. Anything less falls back to the template. Kill switch FRIDAY_WELCOME=off.

import { store, logEvent } from "@/lib/persistence/store";
import { OWNER_FIRST, AGENCY } from "@/lib/friday/persona";
import type { Client } from "@/lib/friday/types";

export function welcomeEnabled(): boolean {
  return (process.env.FRIDAY_WELCOME ?? "on").trim().toLowerCase() !== "off";
}

const INTERNAL_MARKERS = /\[(?:QA|Fix(?:\s*R\d+)?)\]|VERDICT:|\bqa_testing\b|\bTier\s*\d\b|\bdispatch\b/i;
const PLACEHOLDER = /\{[a-z0-9_ .-]+\}|\[[a-z0-9_ .-]+\]|\bTBD\b|\blorem\b|X{3,}/i;
// Concrete schedule promises don't belong in a welcome — timelines are owner-gated (Tier 3).
const DATE_PROMISE = /\b(?:by|within|in)\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\bwithin\s+\d+\s*(?:hours?|days?|weeks?)\b|\bby\s+(?:tomorrow|next week|end of (?:day|week))\b/i;

export function welcomeIssues(text: string): string[] {
  const issues: string[] = [];
  if (!text || text.trim().length < 200) issues.push("welcome is too thin (<200 chars)");
  if (text.length > 2400) issues.push("welcome is too long (>2400 chars)");
  if (INTERNAL_MARKERS.test(text)) issues.push("contains internal jargon");
  if (PLACEHOLDER.test(text)) issues.push("contains a placeholder/template token");
  if (/\$\s?\d/.test(text)) issues.push("contains a dollar figure (money talk is owner-gated)");
  if (DATE_PROMISE.test(text)) issues.push("contains a concrete schedule promise (timelines are owner-gated)");
  if (!/\bAI\b/.test(text)) issues.push("lost the honest-AI disclosure");
  return issues;
}

export function welcomeTemplate(client: Client): { subject: string; body: string } {
  const first = client.name.trim().split(/\s+/)[0] || "there";
  const body = [
    `Hi ${first},`,
    ``,
    `I'm FRIDAY — Technical Director here at ${AGENCY}, and your day-to-day contact on everything we build for you. I'm an AI teammate: I keep your projects moving around the clock, log every request the moment it lands, and keep ${OWNER_FIRST} — who leads the agency and personally reviews the big calls — in the loop on all of it.`,
    ``,
    `A few things that make working together easy:`,
    `• Email me anything, anytime — bugs, changes, questions, screenshots. Every ask gets tracked; nothing falls through the cracks.`,
    `• You'll hear back from ${OWNER_FIRST} or me the same day, and nothing important happens without their sign-off.`,
    `• Rather talk it through? Just say the word and we'll set up a call.`,
    ``,
    `Looking forward to building with you.`,
  ].join("\n");
  return { subject: `Welcome aboard — how to reach us, day or night`, body };
}

async function warmthPass(client: Client, template: string): Promise<string | null> {
  try {
    const { complete } = await import("@/lib/friday/engines");
    const out = await complete({
      system:
        "You lightly personalize a client welcome email. Keep EVERY factual statement, the bullet structure, and the sentence disclosing the sender is an AI. " +
        "You may only adjust warmth and flow. Never add dates, prices, promises, or new claims. Return the email body only.",
      prompt: `Client name: ${client.name}${client.company ? `\nCompany: ${client.company}` : ""}\n\nEmail to polish:\n${template}`,
      temperature: 0.4,
      timeoutMs: 45_000,
    });
    return out?.trim() || null;
  } catch {
    return null;
  }
}

export interface WelcomeResult {
  queued: boolean;
  reason?: string;
  subject?: string;
  body?: string;
}

/**
 * Compose + park the welcome in the approve-to-send loop. Idempotent via Client.welcomeQueuedAt —
 * a client gets at most one welcome, ever, no matter how the trigger fires.
 */
export async function queueWelcomeEmail(clientId: string): Promise<WelcomeResult> {
  if (!welcomeEnabled()) return { queued: false, reason: "FRIDAY_WELCOME=off" };
  const client = await store.clients.get(clientId);
  if (!client) return { queued: false, reason: "client not found" };
  if (!client.email) return { queued: false, reason: "client has no email" };
  if (client.welcomeQueuedAt) return { queued: false, reason: `welcome already queued ${client.welcomeQueuedAt.slice(0, 10)}` };

  const { subject, body: template } = welcomeTemplate(client);
  let body = template;
  const warmed = await warmthPass(client, template);
  if (warmed && welcomeIssues(warmed).length === 0) body = warmed;
  // (template itself always passes welcomeIssues by construction — it is the floor)

  // Client email is drafted into the owner's approval queue in the OS; Clara sends it once they approve.
  const { queueClientEmail } = await import("@/lib/friday/osClientEmail");
  const draft = await queueClientEmail(client, { subject, body, ref: `welcome:${client.id}`, summary: `Welcome email — ${client.name}` });
  if (!draft.ok) return { queued: false, reason: `draft failed: ${draft.error}` };
  await store.clients.update(client.id, { welcomeQueuedAt: new Date().toISOString() });
  await logEvent("welcome.queued", { clientId: client.id, client: client.name });
  return { queued: true, subject, body };
}
