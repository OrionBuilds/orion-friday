// Proactive client notifications. When a client-reported [Bug] task is resolved, FRIDAY
// texts the client the all-clear — closing the loop (client reports → team fixes → client
// hears back). Kept separate from repo.ts to avoid a circular import (repo → this → store).
//
// 2026-07-19 (client experience): the same closed loop now covers NON-bug client work too —
// notifyClientWorkDelivered fires when a client-requested feature/change task (not owned by a review
// Request — those go through the portal review — and not linked to a portal ticket/CR) first reaches a
// closed stage (`completed` or `delivered`; see deliveryNotifyRules.ts). Every draft is also logged into
// OS Conversations by osClientEmail.draftClientEmail. Modes via FRIDAY_DELIVERY_NOTIFY:
//   draft (DEFAULT) — email drafted + parked in approve-to-send; the owner releases it
//   nudge           — pre-2026-07-19 behavior: owner nudge only, no client-facing artifact
//   auto            — sends without approval ONLY under FRIDAY_AUTHORITY=active + client_notify tier <3
//   off             — nothing beyond the unconditional owner nudge in repo.ts

import { store, logEvent } from "@/lib/persistence/store";
import { complete } from "@/lib/friday/engines";
import { appendProjectLog } from "@/lib/persistence/obsidian";
import { recordOutcome } from "@/lib/friday/vaultMemory";
import type { Task } from "@/lib/friday/types";

export async function notifyClientBugResolved(task: Task): Promise<void> {
  const project = await store.projects.get(task.projectId);
  if (!project) return;
  const client = await store.clients.get(project.clientId);
  if (!client?.email) return; // no email address: nothing FRIDAY can draft (she has no text channel any more)

  const issue = task.title.replace(/^\[Bug\]\s*/i, "").slice(0, 100);
  const { clientCompanyName, clientSignoff, atCompany } = await import("@/lib/friday/clientBrand");
  const co = clientCompanyName();
  let body = `Hi ${client.name.split(/\s+/)[0] || "there"},\n\nGood news${co ? ` from ${co}` : ""}: the issue you reported on ${project.name} ("${issue}") is now resolved. Thanks for your patience! Let us know if anything else comes up.\n\n${clientSignoff()}`;
  // Try to warm it up a touch; fall back to the template on any error.
  try {
    const drafted = await complete({
      system: `You are FRIDAY, account manager${atCompany()}, emailing our client ${client.name}. Warm, brief (2-3 sentences), professional. Tell them the issue they reported ("${issue}") on their ${project.name} project is now fixed. No emojis. Output only the email body.`,
      prompt: "Write the email.",
      timeoutMs: 30_000,
    });
    if (drafted && drafted.trim().length > 30) body = drafted.trim().slice(0, 1500);
  } catch { /* keep template */ }

  // A draft in the owner's approval queue (OS); Clara sends it after they approve.
  const { queueClientEmail } = await import("@/lib/friday/osClientEmail");
  const res = await queueClientEmail(client, { subject: `Fixed: ${issue}`.slice(0, 120), body, ref: `bugfix:${task.id}`, summary: `Bug fixed — ${issue.slice(0, 80)}` });
  await appendProjectLog(project, { actor: "FRIDAY", kind: "client-update", text: `${res.ok ? "Drafted for approval" : "Could not draft"} a bug-fixed email to ${client.name}: ${issue}` });
  await logEvent("client.notify", { client: client.name, project: project.name, ok: res.ok }, { projectId: project.id, level: res.ok ? "info" : "warn" });
  await rememberNotify(project, task, client.name, "email", res.ok, body, false);
}

/** The memory outcome of a notification: sent → info, queued for quiet hours → waiting, else failed. Pure. */
export function notifyOutcome(ok: boolean, queued = false): "info" | "waiting" | "failed" {
  return ok ? (queued ? "waiting" : "info") : "failed";
}

/** Vault memory: every client notification lands on the feature thread so the next action knows the client already heard. */
async function rememberNotify(project: Parameters<typeof recordOutcome>[0]["project"], task: Task, clientName: string, via: string, ok: boolean, text: string, queued = false): Promise<void> {
  // A quiet-hours queue is not a send: the message may still be capped or fail at flush time, so it
  // is recorded as waiting and the next agent must not assume the client heard.
  const sent = ok && !queued;
  await recordOutcome({
    project, task, kind: "client-notify", title: task.title,
    outcome: notifyOutcome(ok, queued),
    summary: sent ? `${clientName} was told via ${via} that this work is done.`
      : queued && ok ? `A note to ${clientName} via ${via} is queued for after quiet hours — not sent yet.`
      : `Notifying ${clientName} via ${via} failed.`,
    findings: text.slice(0, 300),
    next: sent ? "Wait for the client's reply; treat any adjustment as follow-up on this thread."
      : queued && ok ? "Confirm it went out after quiet hours before assuming the client knows."
      : "Retry the client notification or tell the owner.",
  }).catch(() => undefined);
}

export function deliveryNotifyMode(): "draft" | "nudge" | "auto" | "off" {
  const v = (process.env.FRIDAY_DELIVERY_NOTIFY ?? "draft").trim().toLowerCase();
  return v === "nudge" || v === "auto" || v === "off" ? v : "draft";
}

/**
 * Non-bug client-requested work reached `delivered` → close the loop with the client instead of only
 * nudging the owner. Repo.ts already excluded bugs (own path) and review-owned Requests (richer email);
 * this respects escalations, quiet-hour gates (SMS), and defaults to the approve-to-send loop.
 */
export async function notifyClientWorkDelivered(task: Task): Promise<void> {
  const mode = deliveryNotifyMode();
  if (mode === "off" || mode === "nudge") return; // owner nudge in repo.ts stays either way
  const project = await store.projects.get(task.projectId);
  if (!project) return;
  const client = await store.clients.get(project.clientId);
  if (!client) return;
  const escalated = await store.escalations.find((e) => e.clientId === client.id && e.status === "open");
  if (escalated.length) return; // The owner has this client — no autonomous or parked contact

  const what = task.title.slice(0, 100);
  const first = client.name.trim().split(/\s+/)[0] || "there";
  let bodyText = `Hi ${first},\n\nGood news — "${what}" on ${project.name} is done on our side. Take a look when you get a chance, and if anything needs adjusting just reply here and I'll get it sorted.`;
  try {
    const { atCompany } = await import("@/lib/friday/clientBrand");
    const drafted = await complete({
      system: `You are FRIDAY, Technical Director${atCompany()}, emailing our client ${client.name}. Warm, brief (2-3 sentences). Tell them the work they asked for ("${what}") on ${project.name} is now done, invite them to take a look and reply with any adjustments. No dates, no money, no promises of other work, no sign-off/signature. Output only the email body.`,
      prompt: "Write the note.",
      timeoutMs: 30_000,
    });
    if (drafted && drafted.trim().length > 20 && !/\$\s?\d/.test(drafted)) bodyText = drafted.trim().slice(0, 900);
  } catch { /* keep template */ }
  const subject = `${project.name}: "${what.slice(0, 60)}" is done`;

  // Always a DRAFT in the owner's approval queue (OS); Clara sends it after they approve. FRIDAY sends no
  // client mail or texts of her own, whatever the authority dial says.
  if (!client.email) return;
  const { queueClientEmail } = await import("@/lib/friday/osClientEmail");
  // The "how'd we do?" ask rides the delivered note (at most once per client per FRIDAY_FEEDBACK_MIN_DAYS);
  // Clara reads the reply from the synced mailbox in the OS and records the score.
  const { feedbackAskEnabled, askEligible, FEEDBACK_ASK_LINE } = await import("@/lib/friday/feedback");
  const asking = feedbackAskEnabled() && askEligible(client);
  const finalBody = asking ? `${bodyText}\n\n${FEEDBACK_ASK_LINE}` : bodyText;
  const draft = await queueClientEmail(client, { subject, body: finalBody, ref: `delivered:${task.id}`, summary: `Delivered — ${what.slice(0, 80)}${asking ? " (+ feedback ask)" : ""}` });
  if (draft.ok && asking) await store.clients.update(client.id, { lastFeedbackAskAt: new Date().toISOString() }).catch(() => {});
  if (!draft.ok) {
    await logEvent("client.delivered_notify_error", { client: client.name, task: what, error: draft.error }, { projectId: project.id, level: "warn" });
    return;
  }
  await logEvent("client.delivered_notify", { client: client.name, task: what, via: "draft" }, { projectId: project.id });
  await recordOutcome({
    project, task, kind: "client-notify", title: task.title, outcome: "waiting",
    summary: `Drafted a "work is done" email to ${client.name}; it is parked in approve-to-send.`,
    next: "Once released, the client has been told. Do not draft a second note for this work.",
  }).catch(() => undefined);
}
