// Email-threaded approvals — the owner's approval channel.
//
// Every approval becomes ONE Gmail thread: FRIDAY sends the request, the owner just replies —
// "approve", "reject", or a question — and the poller matches the reply back to the approval by
// thread id. No codes to retype, no channel-switching, and the whole discussion of a task lives in
// one place. The dashboard buttons and the SMS "approve #CODE" command keep working in parallel;
// first decision wins (decideApproval is idempotent).
//
// SAFETY MODEL — read before touching anything here:
//  1. The poller reads ONLY `threads/{storedThreadId}` for pending approvals. It never runs an inbox
//     search and never touches processInbox / inbox-processed.json / the reply floor.
//  2. Every message FRIDAY sends in these threads is X-Agent stamped. The poller classifies ONLY
//     unstamped mail from the owner's address — in the owner-account fallback (friday@ not
//     configured) the thread is owner→owner, so the STAMP is the real discriminator and the From
//     check is belt-and-braces.
//  3. stripQuoted() runs before ANY classification. Every approval email ends with `reply "approve"
//     or "reject"`, and Gmail quotes the original into every reply — without stripping, a reply asking
//     "why is this needed?" contains the word "approve" and would RELEASE THE GATE. This is the
//     single most safety-critical line in the module.
//  4. Classification is conservative: ambiguity is a QUESTION, never a decision. A wrongly-parked
//     approval costs a nudge; a wrongly-released one costs money or a client-facing send.

import { store, logEvent, nowISO } from "@/lib/persistence/store";
import { googleConfigured } from "@/lib/friday/google/auth";
import { sendEmail, getThreadDetail, type ThreadMessageDetail } from "@/lib/friday/google/gmail";
import { draftApprovalCopy, type ApprovalFacts } from "@/lib/friday/approvalCopy";
import { STRONG_APPROVE, STRONG_REJECT, SOFT_YES, SOFT_NO } from "@/lib/friday/ownerCommands";
import { FRIDAY_CORE, OWNER_FIRST } from "@/lib/friday/persona";
import { complete } from "@/lib/friday/engines";
import type { Approval } from "@/lib/friday/types";

type NotifyAccount = "owner" | "friday";

const MAX_SEND_ATTEMPTS = 10;
const RESEND_WINDOW_MS = 7 * 24 * 60 * 60_000; // legacy pendings older than this: dashboard-only
const ANSWER_TIMEOUT_MS = Number(process.env.FRIDAY_APPROVAL_ANSWER_TIMEOUT_MS ?? 60_000);

/** Approval email is the only owner-facing push for a pending approval (no kill switch since
 *  2026-09-24 — the legacy path it reverted to was an SMS, which FRIDAY no longer sends). */
export function approvalEmailEnabled(): boolean {
  return true;
}

function addrOf(header: string): string {
  return (header.match(/<([^>]+)>/)?.[1] ?? header).trim().toLowerCase();
}

// ── Quote stripping + classification ────────────────────────────────────────

/**
 * Remove quoted history from an email reply, leaving only what the OWNER typed.
 * Cut at the first "On <date> … wrote:" attribution line, drop `>`-quoted lines, drop everything
 * below a signature delimiter. MUST run before any classification (see safety model #3).
 */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    // Gmail/Outlook attribution headers — everything below is quoted history.
    if (/^On .{0,200}wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim())) break;
    if (/^From:\s.+$/.test(line.trim()) && out.length > 0) break; // forwarded-block header
    if (line.trim() === "--") break; // signature delimiter
    if (/^\s*>/.test(line)) continue; // quoted line
    out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * What did the owner's reply mean? Deterministic and conservative — regexes only, no LLM in the
 * decision path. "approve" must be a short, unhedged statement: length-capped and question-mark-free,
 * so "what happens if I approve?" can never release the gate.
 *
 * When BOTH signal sets match ("don't do it" hits STRONG_REJECT via "don't" AND STRONG_APPROVE via
 * "do it") the reply is ambiguous → question, never a decision. A naive reject-needs-no-approve rule
 * classified "don't do it" as APPROVE — the exact catastrophic direction this gate exists to prevent.
 */
export function classifyOwnerReply(raw: string): "approve" | "reject" | "question" {
  const t = stripQuoted(raw);
  if (!t) return "question"; // nothing but quoted history — nudge, never decide
  const short = t.length <= 120 && !t.includes("?");
  const approveish = STRONG_APPROVE.test(t) || SOFT_YES.test(t);
  const rejectish = STRONG_REJECT.test(t) || SOFT_NO.test(t);
  if (approveish && rejectish) return "question"; // mixed signals never decide
  if (rejectish) return "reject"; // an unambiguous no needs no length guard — rejecting is the safe direction
  if (approveish && short) return "approve";
  return "question";
}

// ── Facts resolution (shared by send + answer) ──────────────────────────────

async function resolveFacts(a: Approval): Promise<{ facts: ApprovalFacts; projectName?: string; taskTitle?: string }> {
  const task = a.taskId ? await store.tasks.get(a.taskId) : null;
  const project = a.projectId ? await store.projects.get(a.projectId) : null;
  if (a.facts) return { facts: a.facts, projectName: project?.name, taskTitle: task?.title };
  // Rows queued before facts existed (or internal gates): honest internal_task fallback.
  const facts: ApprovalFacts = {
    kind: "internal_task",
    taskTitle: task?.title ?? a.action,
    taskDescription: task?.description ?? a.detail,
    projectName: project?.name,
    agentName: task?.assignee ?? "team",
    risk: a.risk,
  };
  return { facts, projectName: project?.name, taskTitle: task?.title };
}

// ── Send ────────────────────────────────────────────────────────────────────

/**
 * Send (or re-send after a failure) the approval email for a pending approval. Idempotent: a row
 * that already has its thread, is already decided, or has exhausted retries is left alone.
 */
export async function sendApprovalEmail(approvalId: string): Promise<boolean> {
  const a = await store.approvals.get(approvalId);
  if (!a || a.status !== "pending") return false;
  if (a.notifyThreadId) return true; // already sent — the thread IS the idempotency record
  const attempts = a.notifyAttempts ?? 0;
  if (attempts >= MAX_SEND_ATTEMPTS) return false;

  const { ownerEmail } = await import("@/lib/friday/emailAgent");
  const to = await ownerEmail();
  if (!to) {
    await logEvent("approval.email.no_owner", { id: approvalId }, { level: "warn" });
    return false;
  }
  const account: NotifyAccount = googleConfigured("friday") ? "friday" : "owner";

  const { facts, projectName, taskTitle } = await resolveFacts(a);
  const copy = await draftApprovalCopy(facts); // never throws; deterministic fallback inside
  // No code in the subject or body (2026-09-24): the thread id IS the correlation.
  const subject = `[${projectName ?? "FRIDAY"}] ${(taskTitle ?? copy.subject).slice(0, 80)} — needs your OK`;
  // State check rides every approval email verbatim (never through the LLM drafter, which could drop
  // it): one line telling the owner whether this smells like a duplicate or already-shipped work.
  const stateLine = a.stateNote ? `\n\n${a.stateNote}` : "";
  const { stripEmoji } = await import("@/lib/friday/notify");
  const body = stripEmoji(`${copy.email}${stateLine}\n\nJust reply to this email — "approve" or "reject" works, or ask me a question.\nThe dashboard buttons work too.`);

  const res = await sendEmail({ to, subject, body, agent: "FRIDAY" }, account);
  if (!res.ok || !res.threadId) {
    await store.approvals.update(a.id, { notifyAttempts: attempts + 1 });
    if (attempts + 1 >= MAX_SEND_ATTEMPTS) {
      await logEvent("approval.email.giveup", { id: a.id, error: res.error }, { level: "error" });
    } else {
      await logEvent("approval.email.send_failed", { id: a.id, attempt: attempts + 1, error: res.error }, { level: "warn" });
    }
    return false;
  }

  await store.approvals.update(a.id, {
    notifyThreadId: res.threadId,
    notifyAccount: account,
    notifySubject: subject,
    notifySentAt: nowISO(),
    // Seed "seen" at send time so FRIDAY's own message (and anything older) is never classified.
    notifySeenMs: Date.now(),
    notifyAttempts: attempts + 1,
  });
  await logEvent("approval.email.sent", { id: a.id, threadId: res.threadId, account, subject }, { projectId: a.projectId });
  return true;
}

// ── In-thread replies ───────────────────────────────────────────────────────

async function replyInThread(a: Approval, body: string, replyTo?: ThreadMessageDetail): Promise<void> {
  if (!a.notifyThreadId) return;
  const { ownerEmail } = await import("@/lib/friday/emailAgent");
  const to = await ownerEmail();
  if (!to) return;
  await sendEmail({
    to,
    subject: `Re: ${(a.notifySubject ?? "FRIDAY approval").replace(/^Re:\s*/i, "")}`,
    body,
    // In-Reply-To the owner's own message so the reply threads correctly in HIS mailbox in both
    // account modes; replyToThreadId keeps it threaded in the SENDING mailbox.
    inReplyTo: replyTo?.messageId || undefined,
    references: replyTo ? [replyTo.references, replyTo.messageId].filter(Boolean).join(" ") || undefined : undefined,
    replyToThreadId: a.notifyThreadId,
    agent: "FRIDAY", // load-bearing — keeps this message invisible to the poller and processInbox
  }, (a.notifyAccount ?? "owner"));
}

/**
 * Confirm a decision in the approval's thread. Fire-and-forget from decideApproval — works whether
 * the decision came from an email reply, the dashboard, or an SMS command; silently no-ops for
 * approvals that never had an email thread.
 */
export async function noteDecisionInThread(a: Approval, decision: "approved" | "rejected", source: string): Promise<void> {
  if (!a.notifyThreadId) return;
  try {
    const task = a.taskId ? await store.tasks.get(a.taskId) : null;
    const via = source === "email" ? "" : source === "sms" ? " (decided via text)" : source === "clara" ? " (you told CLARA)" : ` (decided from the dashboard)`;
    let body: string;
    if (a.emailDraftId) {
      body = decision === "approved"
        ? `Done — sent the reply. You're CC'd on it.${via}`
        : `Rejected — I've discarded the draft. Nothing was sent.${via}`;
    } else {
      body = decision === "approved"
        ? `Done — dispatched the ${task?.assignee ?? "team"} on it. I'll follow up when it's finished.${via}`
        : `Rejected — nothing released. The task is back in Planning.${via}`;
    }
    const msgs = await getThreadDetail(a.notifyThreadId, a.notifyAccount ?? "owner").catch(() => [] as ThreadMessageDetail[]);
    await replyInThread(a, body, msgs[msgs.length - 1]);
  } catch {
    /* best-effort — the decision itself already stands */
  }
}

/** Race a promise against a deadline; null on timeout/throw. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function answerQuestionInThread(a: Approval, ownerMsg: ThreadMessageDetail): Promise<void> {
  const fallback = `I got your reply — to move this one: reply "approve" or "reject" when you're ready, or use the dashboard.`;
  let body = fallback;
  try {
    const { facts, projectName } = await resolveFacts(a);
    const task = a.taskId ? await store.tasks.get(a.taskId) : null;
    const question = stripQuoted(ownerMsg.text).slice(0, 800);
    const grounding = JSON.stringify({
      approval: { action: a.action, risk: a.risk },
      project: projectName,
      task: task ? { title: task.title, status: task.status, assignee: task.assignee, details: task.details, executionPlan: task.executionPlan } : undefined,
      facts,
    }, null, 1);
    const out = await withTimeout(complete({
      engine: "codex",
      system: `${FRIDAY_CORE}

${OWNER_FIRST} replied to one of your approval-request emails with a QUESTION. Answer it in 1-4 plain
sentences using ONLY the facts below — never invent details, numbers, or timelines. The work has NOT
started and will not until they approve; never imply otherwise. End by reminding them that replying
"approve" or "reject" moves it. No greeting line, no sign-off — this is mid-thread.

FACTS (the only things you know):
${grounding}`,
      prompt: question || "(their reply had no readable text — ask them to restate)",
      timeoutMs: ANSWER_TIMEOUT_MS,
    }), ANSWER_TIMEOUT_MS + 5_000);
    const cleaned = (out ?? "").trim();
    if (cleaned.length >= 10 && cleaned.length <= 1500 && !/#[0-9A-F]{3,6}\b/i.test(cleaned)) body = cleaned;
  } catch {
    /* fallback stands */
  }
  await replyInThread(a, body, ownerMsg);
  await logEvent("approval.email.answered", { id: a.id }, { projectId: a.projectId });
}

// ── The poller (scheduler job) ──────────────────────────────────────────────

export async function pollApprovalReplies(): Promise<string> {
  if (!approvalEmailEnabled()) return "off";
  if (!googleConfigured()) return "google not connected";

  const { ownerEmail } = await import("@/lib/friday/emailAgent");
  const ownerAddr = (await ownerEmail())?.toLowerCase() ?? "";
  if (!ownerAddr) return "no owner address";

  const pending = await store.approvals.find((x) => x.status === "pending");
  let checked = 0, decided = 0, answered = 0, resent = 0;

  for (const a of pending) {
    try {
      if (!a.notifyThreadId) {
        // Never sent (queued while Gmail was down, or a legacy pre-deploy row). Retry recent ones;
        // stale ones stay dashboard-decidable without a surprise week-old email blast.
        if (Date.now() - Date.parse(a.requestedAt) < RESEND_WINDOW_MS) {
          if (await sendApprovalEmail(a.id)) resent++;
        }
        continue;
      }
      checked++;
      const msgs = await getThreadDetail(a.notifyThreadId, a.notifyAccount ?? "owner");
      if (!msgs.length) continue; // fetch failed → retry next cycle (seenMs not advanced)

      const floorMs = Math.max(a.notifySeenMs ?? 0, Date.parse(a.requestedAt) || 0);
      const candidates = msgs
        .filter((m) => Number.isFinite(m.internalDate) && m.internalDate > floorMs)
        .filter((m) => !m.agent.trim())               // FRIDAY's mail is stamped — humans aren't
        .filter((m) => addrOf(m.from) === ownerAddr)  // belt-and-braces (see safety model #2)
        .sort((x, y) => x.internalDate - y.internalDate);
      if (!candidates.length) continue;

      let newestSeen = a.notifySeenMs ?? 0;
      for (const m of candidates) {
        newestSeen = Math.max(newestSeen, m.internalDate);
        const verdict = classifyOwnerReply(m.text);
        if (verdict === "question") {
          await answerQuestionInThread(a, m);
          answered++;
          continue; // keep reading — a later message in the same batch may decide
        }
        // Decisive. decideApproval is idempotent (first decision wins), so a race with the
        // dashboard resolves safely — we just record the source for the thread note.
        const { decideApproval } = await import("@/lib/friday/orchestrator");
        await decideApproval(a.id, verdict === "approve" ? "approved" : "rejected", { source: "email" });
        decided++;
        await logEvent("approval.email.decided", { id: a.id, decision: verdict }, { projectId: a.projectId });
        break; // thread exits polling once decided
      }
      // Persist progress even when everything was a question — a question must be answered ONCE,
      // not once per 2-minute cycle forever.
      await store.approvals.update(a.id, { notifySeenMs: newestSeen });
    } catch (e) {
      await logEvent("approval.email.poll_error", { id: a.id, error: String(e).slice(0, 200) }, { level: "warn" });
    }
  }

  return `${checked} thread(s) checked, ${decided} decided, ${answered} answered, ${resent} (re)sent`;
}
