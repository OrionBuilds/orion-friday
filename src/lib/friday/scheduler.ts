// FRIDAY scheduler — the always-on heartbeat. A single setInterval (started once at server boot via
// instrumentation.ts) runs inherently PERIODIC jobs: the morning brief, a Google Meet → tasks poll
// (a fallback for a real-time push), overdue/stale nudges, and the Gmail-watch renewal. Inbound
// email is event-driven when GMAIL_PUBSUB_TOPIC is configured — new mail arrives via the
// api/friday/gmail/push webhook instead of waiting on a tick (see google/gmailWatch.ts); the
// inbox-triage job below still runs as its fallback. Calendar has no push yet — Meet stays
// poll-only. Last-run times persist to scheduler.json so a restart never double-fires a daily job.
// Everything is best-effort and Node-only.

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store, logEvent, nowISO } from "@/lib/persistence/store";
import { isClosed } from "@/lib/friday/stages";
import { OWNER } from "@/lib/friday/persona";
import { notifyOwner, ownerReachable, flushDigest } from "@/lib/friday/notify";
import { runOsTasksPoll, osTasksMode } from "@/lib/friday/osTasks";
import { legacyChannelsOn } from "@/lib/friday/legacyChannels";

interface Job {
  id: string;
  everyMs?: number;        // periodic cadence
  dailyAfterHour?: number; // OR: run once per local day, only once local hour >= this
  run: () => Promise<string | void>;
}

const STATE_FILE = path.join(FRIDAY_DATA_DIR, "scheduler.json");
// jobId → last SUCCESSFUL run ISO; plus per-job failure keys `<jobId>:retryAt` (backoff gate)
// and `<jobId>:lastError` (diagnostics). Failure keys never feed isDue's cadence math.
type State = Record<string, string>;

// Shared by the uptime and engine-auth-watch jobs: don't re-page a still-down/still-lapsed
// condition more than once per window, but don't go silent on a genuinely sustained outage either.
const SIX_H = 6 * 3600_000;

async function loadState(): Promise<State> {
  try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); } catch { return {}; }
}
async function saveState(s: State): Promise<void> {
  try { await fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2), "utf8"); } catch { /* ignore */ }
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isDue(job: Job, state: State, now: Date): boolean {
  // Failure backoff: a failed attempt no longer advances the cadence stamp (a daily job that
  // hit a transient Gmail outage used to go silent until tomorrow), but it must not hot-loop
  // either — retryAt holds the job for ~5 minutes per failure, then it is due again.
  const retryAt = state[`${job.id}:retryAt`];
  if (retryAt && now.getTime() < Date.parse(retryAt)) return false;
  const last = state[job.id];
  if (job.dailyAfterHour != null) {
    if (now.getHours() < job.dailyAfterHour) return false;
    return !last || !sameLocalDay(new Date(last), now); // once per local day
  }
  if (job.everyMs != null) return !last || now.getTime() - new Date(last).getTime() >= job.everyMs;
  return false;
}

// ── Jobs ─────────────────────────────────────────────────────────────────
const JOBS: Job[] = [
  {
    // Stale human-handoffs. An open escalation gags FRIDAY on every channel for that client and
    // ONLY `resume <name>` clears it — there is no TTL. Nothing used to revisit one, so a handoff
    // opened 2026-07-30 was still swallowing a client's messages 26 hours later and the owner had
    // no idea. This is the safety net for the case where the client gives up and stops writing,
    // so the suppressed-message nudge in escalations.ts never fires either.
    //
    // Reports only. Handing a client back is a human decision, never automatic.
    id: "stale-handoff-sweep",
    everyMs: 60 * 60_000,
    run: async () => {
      const { staleEscalations } = await import("@/lib/friday/escalations");
      const stale = await staleEscalations();
      if (!stale.length) return "no stale handoffs";

      const { store } = await import("@/lib/persistence/store");
      const { notifyOwner } = await import("@/lib/friday/notify");
      const lines: string[] = [];
      for (const e of stale) {
        const name = (await store.clients.get(e.clientId))?.name ?? e.clientId;
        const hours = Math.floor((Date.now() - Date.parse(e.createdAt)) / 3_600_000);
        lines.push(`- ${name} — ${hours}h, ${e.suppressedCount ?? 0} message(s) unanswered`);
      }
      await notifyOwner({
        kind: "escalation.stale",
        priority: "normal",
        text: `Still on manual handoff (I'm muted for these clients):\n${lines.join("\n")}\nTell CLARA to hand any of them back to me, or reply "resume <name>" to a text from me.`,
        // One page per hour regardless of how many are stale.
        dedupeKey: `stale-handoff-sweep:${new Date().toISOString().slice(0, 13)}`,
      }).catch(() => {});
      return `stale handoffs: ${stale.length}`;
    },
  },
  {
    // OS-scheduled agent tasks — pull due work from Orion once a minute, run FRIDAY's handlers,
    // report back. Gated by FRIDAY_OS_TASKS (off|shadow|active, default shadow); a run only has
    // real side effects when the env gate AND the per-schedule OS mode are both 'active'.
    id: "os-agent-tasks-poll",
    everyMs: 60_000,
    run: async () => {
      if (osTasksMode() === "off") return "os-tasks off";
      const s = await runOsTasksPoll((m, e) => logEvent("os-tasks", { m, e: e ? String(e).slice(0, 200) : undefined }).catch(() => {}));
      return s ? `os-tasks: claimed ${s.claimed}, done ${s.completed}, parked ${s.parked}, failed ${s.failed}` : "os-tasks: skipped";
    },
  },
  {
    // Mirror the FRIDAY + CLARA Obsidian vaults to the Orion /memory module (Memory Galaxy, graph,
    // search). Only changed notes are uploaded. FRIDAY_VAULT_SYNC=off disables it.
    id: "vault-sync",
    everyMs: 5 * 60_000,
    run: async () => {
      const { runVaultSync } = await import("@/lib/friday/vaultSync");
      return runVaultSync();
    },
  },
  {
    // One-off requests other agents hand FRIDAY through the OS (Clara relaying the owner's asks):
    // claim, plan, track, report. Gated by FRIDAY_OS_REQUESTS=active (default off). See osRequests.ts.
    id: "os-agent-requests",
    everyMs: 60_000,
    run: async () => (await import("@/lib/friday/osRequestsRuntime")).runOsRequestsPoll(),
  },
  {
    // Registry refresh — the skill/agent index used to be rebuilt only by the Agents-page button, so a
    // library change (or a source added to config.json) never reached dispatch until someone clicked.
    // Every 30 min (the boot scan in instrumentation.ts covers restarts); prunes rows for deleted files.
    id: "registry-scan",
    everyMs: 30 * 60_000,
    run: async () => {
      const { seedAgents } = await import("@/lib/friday/agents");
      const { scanSources } = await import("@/lib/friday/registry");
      await seedAgents();
      const r = await scanSources();
      return `${r.skills} skills, ${r.agents} agents, pruned ${r.pruned.skills + r.pruned.agents} (${r.durationMs}ms)`;
    },
  },
  {
    // skills.sh self-improvement (2026-10-23): once a week, agy (her browser agent) browses skills.sh
    // for new skills worth adopting for FRIDAY + her sub-agents. Official/audited ones are auto-adopted
    // (SKILL.md written into a scanned dir by registry — NO npx, NO install-time code execution); the
    // rest are surfaced for the owner to approve ("tell me to adopt <name>"). registry-scan then indexes
    // them. Kill switch FRIDAY_SKILLS_DISCOVERY=off. Weekly cadence persists in scheduler.json.
    id: "skills-discovery",
    everyMs: 7 * 24 * 60 * 60_000,
    run: async () => {
      const { runSkillsDiscovery, skillsDiscoveryEnabled } = await import("@/lib/friday/skillsDiscovery");
      if (!skillsDiscoveryEnabled()) return "skills-discovery off";
      const { notifyOwner } = await import("@/lib/friday/notify");
      const r = await runSkillsDiscovery({
        notifyOwner: async (headline, detail) => { await notifyOwner({ kind: "skills.discovery", priority: "normal", headline, text: detail, email: true }); },
      });
      return r.error ? `skills-discovery: ${r.error}` : `skills-discovery: adopted ${r.adopted.length}, to-approve ${r.proposed.length}, skipped ${r.skipped}`;
    },
  },
  {
    // OS approvals bridge (Wave 3) — same cadence as the os-tasks poll above: back-mirror pending
    // approvals on the first tick after boot, pull hub decisions (approved/rejected/expired,
    // unacked), apply each through the LOCAL decide spine (CAS — first decision wins), then ack.
    // Gated by FRIDAY_OS_BRIDGE (default on when the OS sign-in is configured); never throws.
    id: "os-approvals-bridge",
    everyMs: 60_000,
    run: async () => {
      const { pullAndApplyDecisions } = await import("@/lib/friday/osApprovalsBridge");
      return pullAndApplyDecisions();
    },
  },
  {
    // Notification digest — flush batched (low-priority / quiet-hours) pings as one message. Runs
    // hourly; flushDigest itself is a no-op during quiet hours, so the queue drains each morning.
    id: "notify-digest",
    everyMs: 60 * 60_000,
    run: async () => flushDigest(),
  },
  {
    // Institutional-memory catch-up — embed any messages/runs the live capture hooks missed, so
    // recall stays complete even across restarts. Idempotent (dedupes by id). Every 5 min.
    // 2026-10-28 (audit gap 8): no embedding provider ⇒ "disabled" + one warn log per process (not a
    // fake "up to date"); an embed failure throws → scheduler.error + backoff, visible in the log.
    id: "memory-reindex",
    everyMs: 5 * 60_000,
    run: async () => {
      const { reindexMemory } = await import("@/lib/friday/memory");
      const r = await reindexMemory();
      if (r.disabled) {
        const g = globalThis as unknown as { __fridayReindexDisabledWarned?: boolean };
        if (!g.__fridayReindexDisabledWarned) {
          g.__fridayReindexDisabledWarned = true;
          await logEvent("memory.reindex_disabled", { reason: "no embedding provider configured — set FRIDAY_EMBEDDINGS_URL + FRIDAY_EMBEDDINGS_MODEL (LM Studio is retired)" }, { level: "warn" }).catch(() => {});
        }
        return "DISABLED — no embedding provider configured (FRIDAY_EMBEDDINGS_URL); memory recall is not being indexed";
      }
      return r.indexed ? `indexed ${r.indexed} (total ${r.total})` : "up to date";
    },
  },
  {
    // OS-session liveness alarm (2026-10-28 audit): probes the OS session every 5 min and, after a
    // >10-min auth-failure streak (refresh_token_already_used & co), raises an alarm that does NOT
    // need the broken session — error log, os-auth-alarm.json, /api/health 503. See osLiveness.ts.
    id: "os-auth-liveness",
    everyMs: 5 * 60_000,
    run: async () => {
      const { osEnabled } = await import("@/lib/friday/osClient");
      if (!osEnabled()) return "os not connected";
      const { checkOsAuthLiveness } = await import("@/lib/friday/osLiveness");
      const r = await checkOsAuthLiveness();
      // autodeploy.sh queues its failures in ~/.agentic-os/autodeploy.alerts; relay the new ones to the owner.
      const { relayAutodeployAlerts } = await import("@/lib/friday/ownerAlertRelay");
      const relayed = await relayAutodeployAlerts();
      if (r.startsWith("OS AUTH BROKEN")) throw new Error(r); // scheduler.error too, so it shows as a failed job
      return `${r}; ${relayed}`;
    },
  },
  {
    // OS per-agent settings (Settings → AI Agents) — keep the cached snapshot warm so sync call sites
    // (caps, voice, CLI allow-lists) read a current answer. Failure keeps the last good snapshot.
    id: "os-agent-settings",
    everyMs: 60_000,
    run: async () => {
      const { refreshAgentSettings, agentSettingsEnabled, agentSettingsState } = await import("@/lib/friday/agentSettings");
      if (!agentSettingsEnabled()) return "agent settings off (FRIDAY_AGENT_SETTINGS=off)";
      const snap = await refreshAgentSettings();
      const st = agentSettingsState();
      if (st.lastError) return `settings fetch failed (${st.lastError.slice(0, 120)}) — ${snap ? "using last good" : "using built-in defaults"}`;
      return snap ? `status ${snap.root.status}, ${Object.keys(snap.subagents).length} subagent row(s)` : "no settings";
    },
  },
  {
    // FRIDAY's model-call ledger → OS agent_usage_report (Agent Health dashboard). Batched, deduped
    // server-side by ledger id; inert until agent-core allowlists the tool. See osUsageReport.ts.
    id: "os-usage-report",
    everyMs: 5 * 60_000,
    run: async () => {
      const { pushModelCallUsage } = await import("@/lib/friday/osUsageReport");
      const r = await pushModelCallUsage();
      if (r.startsWith("usage push failed")) throw new Error(r); // scheduler.error + backoff
      return r;
    },
  },
  {
    // Ops self-healing (2026-10-02) — primary layer on top of autodeploy's sha-stamp check. Scans
    // every office service's running stamp, restarts the ones whose stamp doesn't match HEAD on
    // the service's correct branch. 30-minute cooldown per service so a crash-looping build never
    // thrashes. Texts the owner through CLARA when anything restarted; silent otherwise.
    id: "service-staleness-sweep",
    everyMs: 10 * 60_000,
    run: async () => {
      const [{ cleanupMergedBranches, summarizeCleanup, sweepStaleServices, summarizeSweep }, { textOwnerAboutOps }] = await Promise.all([
        import("@/lib/friday/opsHealing"), import("@/lib/friday/delegateBridge"),
      ]);
      // Branch cleanup FIRST — a worktree sitting on a just-merged branch (its origin ref is gone)
      // gets switched back to default + the local branch deleted. Then the staleness check sees
      // the fresh default-branch HEAD and restarts anything the switch brought along.
      const cleanup = await cleanupMergedBranches();
      const cleanupLine = summarizeCleanup(cleanup);
      if (cleanupLine) {
        await textOwnerAboutOps({
          kind: "ops_branch_cleaned",
          text: cleanupLine,
          dedupeKey: `branchclean:${cleanup.cleaned.map((c) => `${c.repo}:${c.branch}`).sort().join(",")}|${cleanup.blocked.map((b) => `${b.repo}:${b.branch}`).sort().join(",")}`,
        });
      }
      const r = await sweepStaleServices();
      if (r.restarted.length) {
        const summary = summarizeSweep(r);
        if (summary) {
          const sha = Object.values(r.shaByService)[0]?.slice(0, 7) ?? "";
          await textOwnerAboutOps({
            kind: "ops_services_restarted",
            text: summary,
            dedupeKey: `restart:${sha}:${r.restarted.sort().join(",")}`,
          });
        }
      }
      const parts: string[] = [];
      if (cleanup.cleaned.length) parts.push(`cleaned ${cleanup.cleaned.length}`);
      if (cleanup.blocked.length) parts.push(`cleanup blocked ${cleanup.blocked.length}`);
      if (r.restarted.length) parts.push(`restarted ${r.restarted.length}`);
      if (r.handedOff?.length) parts.push(`left ${r.handedOff.length} to auto-deploy`);
      if (r.blocked.length) parts.push(`restart blocked ${r.blocked.length}`);
      return parts.length ? parts.join(", ") : "all current";
    },
  },
  {
    // Nudge autodeploy on a 30-min cadence so a stalled systemd timer, a laptop coming out of
    // sleep, or a long-running tick that fell behind the schedule doesn't leave work pending for
    // half an hour. The autodeploy service is a one-shot — triggering it when it's already
    // running is a no-op, not a retry storm.
    id: "autodeploy-nudge",
    everyMs: 30 * 60_000,
    run: async () => {
      const { triggerAutodeploy } = await import("@/lib/friday/opsHealing");
      const r = await triggerAutodeploy();
      return r.ok ? "autodeploy nudged" : `nudge failed: ${r.error}`;
    },
  },
  {
    // Daily sweep (after 9am local): any office worktree sitting on a feature branch for more than
    // a week gets a one-line heads-up to the owner. Dedupe by the branch+day so one morning text per
    // stuck worktree, not one every tick.
    id: "stale-branch-sweep",
    dailyAfterHour: 9,
    run: async () => {
      const { staleBranchSweep, summarizeStaleBranches } = await import("@/lib/friday/opsHealing");
      const stale = await staleBranchSweep();
      const summary = summarizeStaleBranches(stale);
      if (summary) {
        const { textOwnerAboutOps } = await import("@/lib/friday/delegateBridge");
        const date = new Date().toISOString().slice(0, 10);
        await textOwnerAboutOps({
          kind: "ops_stale_branches",
          text: summary,
          dedupeKey: `stalebranch:${date}:${stale.map((r) => `${r.repo}:${r.branch}`).sort().join(",")}`,
        });
      }
      return stale.length ? `${stale.length} stuck on feature branches` : "all worktrees on default branch";
    },
  },
  {
    // Morning brief — once/day after 7am local; queues into CLARA's 8am executive brief.
    id: "morning-brief",
    dailyAfterHour: 7,
    run: async () => {
      // Normal-priority items queue into CLARA's brief; they need no FRIDAY-side email channel.
      const { generateDream } = await import("@/lib/friday/dream");
      const dream = await generateDream(true);
      const lines = [dream.greeting, ...dream.prescriptions.map((p, i) => `${i + 1}. ${p.title} → ${p.action}`)];
      await notifyOwner({ kind: "brief", headline: "FRIDAY morning brief", summary: lines.join("\n").slice(0, 1300), text: `FRIDAY morning brief\n${lines.join("\n").slice(0, 1300)}`, dedupeKey: `brief:${new Date().toDateString()}` });
      return `sent (${dream.prescriptions.length} prescriptions)`;
    },
  },
  {
    // Client-docs Drive pull — daily sweep of every client's Drive "Documents" folder so files the owner
    // drops there become agent context without touching the UI (two-way sync; idempotent by
    // driveFileId + modifiedTime). The per-client sync button covers the impatient path.
    id: "client-docs-drive-sync",
    dailyAfterHour: 7,
    run: async () => {
      const { googleConfigured } = await import("@/lib/friday/google/auth");
      if (!googleConfigured()) return "google not connected";
      const { syncAllClientDocs } = await import("@/lib/friday/docs/driveSync");
      return syncAllClientDocs();
    },
  },
  {
    // Feedback watcher — reads pending "how'd we do?" threads and captures 1-5 replies
    // deterministically (feedback.ts). Negative scores page the owner; positives batch.
    id: "feedback-watch",
    everyMs: 5 * 60_000,
    run: async () => {
      const { googleConfigured } = await import("@/lib/friday/google/auth");
      if (!googleConfigured()) return "google not connected";
      const { pollFeedbackReplies } = await import("@/lib/friday/feedback");
      return pollFeedbackReplies();
    },
  },
  {
    // Board hygiene — once/day after 8am: auto-merge near-certain duplicate planning cards (same
    // project, similarity ≥ 0.85) into the oldest, and digest the stale-planning count. Never deletes
    // a non-duplicate — stale cards go only via the owner's "sweep planning" text. See boardHygiene.ts.
    id: "board-hygiene",
    dailyAfterHour: 8,
    run: async () => {
      const { runBoardHygiene } = await import("@/lib/friday/boardHygiene");
      const r = await runBoardHygiene();
      return `${r.merged} merged, ${r.stale} stale planning`;
    },
  },
  {
    // Meeting watcher — poll recent Google Meet transcripts → auto-create tasks. Fallback for the
    // real-time Gmail/Calendar push; safe/idempotent (ingest dedupes on conferenceRecord).
    id: "meeting-watcher",
    everyMs: 15 * 60_000,
    run: async () => {
      // 2026-09: DEFAULT OFF. CLARA digests meetings now; FRIDAY's poll double-created tasks and
      // follow-up drafts for the same call. ingestMeetings stays callable (API / manual / tests) —
      // only the timed sweep is parked. FRIDAY_MEETING_WATCHER=on restores it.
      if ((process.env.FRIDAY_MEETING_WATCHER ?? "off") === "off") return "off — CLARA digests meetings";
      const { googleConfigured } = await import("@/lib/friday/google/auth");
      if (!googleConfigured()) return "google not connected";
      const { ingestMeetings } = await import("@/lib/friday/ingest");
      const r = await ingestMeetings(2);
      if (r.tasksCreated > 0) {
        const names = r.items.map((i) => i.project || i.client).filter(Boolean).slice(0, 3).join(", ");
        await notifyOwner({ kind: "meeting", text: `${r.tasksCreated} action item(s) from ${r.meetings} recent call(s)${names ? ` (${names})` : ""} — reply "status" to review or "dispatch" to start.` });
      }
      return `${r.meetings} meetings, ${r.tasksCreated} tasks`;
    },
  },
  {
    // Inbox triage — fallback poll for when Gmail push (below) is unset, misconfigured, or a
    // notification is dropped: scans unread client email in BOTH the owner's and FRIDAY's inboxes.
    // Routine replies auto-send from FRIDAY (owner CC'd); commitments are drafted + held for approval.
    // Idempotent via inbox-processed.json, and shares triageInboxNow's overlap guard with the push
    // webhook so the two never race. See emailAgent.processInbox / triageInboxNow.
    id: "inbox-triage",
    everyMs: 15 * 60_000,
    run: async () => {
      const { googleConfigured } = await import("@/lib/friday/google/auth");
      if (!googleConfigured()) return "google not connected";
      const { triageInboxNow } = await import("@/lib/friday/emailAgent");
      const r = await triageInboxNow();
      if (!r) return "skipped (push-triggered scan already in flight)";
      // The floor rides along in every summary so "why didn't she reply to that?" answers itself
      // from logs.jsonl, without anyone having to know this file exists.
      return `${r.scanned} scanned, ${r.replied} replied, ${r.drafted} drafted · reply floor ${r.floorISO}`;
    },
  },
  {
    // Gmail watch renewal — re-registers push notifications (Cloud Pub/Sub) for every connected
    // account so inbound mail triggers gmail/push instead of waiting on the poll above. A watch
    // lapses after 7 days; renewing roughly daily means a missed tick (a restart, a slow day)
    // never leaves more than ~a day resting on the 15-min fallback. No-op (and cheap) when
    // GMAIL_PUBSUB_TOPIC isn't set — see gmailWatch.ts for the one-time GCP setup.
    id: "gmail-watch-renew",
    everyMs: 20 * 3600_000,
    run: async () => {
      const { renewAllWatches } = await import("@/lib/friday/google/gmailWatch");
      return renewAllWatches();
    },
  },
  {
    // Approval email loop — reads the owner's replies in pending approvals' Gmail threads and acts
    // on them (approve/reject/answer questions). Thread-scoped only; never a general inbox read.
    // Also retries approval emails that failed to send. See approvalEmail.ts.
    id: "approval-email-watch",
    everyMs: 2 * 60_000,
    run: async () => {
      const { pollApprovalReplies } = await import("@/lib/friday/approvalEmail");
      return pollApprovalReplies();
    },
  },
  {
    // Client-review loop (OS portal since 2026-10-28) — every 2 min, read client_reviews_list
    // (Approve → close, Request changes → revision, comment → portal answer) and re-file any review
    // that never got out (crash recovery). No Google: runs regardless of FRIDAY_LEGACY_CHANNELS.
    // See clientReview.ts.
    id: "client-review-watch",
    everyMs: 2 * 60_000,
    run: async () => {
      const { pollClientReviewReplies, resendPendingReviews } = await import("@/lib/friday/clientReview");
      const resent = await resendPendingReviews();
      const polled = await pollClientReviewReplies();
      return `${polled}${resent ? ` · ${resent} (re)sent` : ""}`;
    },
  },
  {
    // Portal ticket/CR clarify loop (2026-09-18) — every 5 min, poll BOTH the client's portal-reply
    // thread and the mirrored clarify email thread for an outstanding clarifying question, and
    // resolve/ask-again/force-resolve whichever answers first (bounded to 2 rounds). Runs
    // independently of the OS's own hourly ticket-triage cadence so client-facing latency isn't tied
    // to it. See ticketClarify.pollClarifyReplies.
    id: "ticket-clarify-watch",
    everyMs: 5 * 60_000,
    run: async () => {
      const { pollClarifyReplies } = await import("@/lib/friday/ticketClarify");
      return pollClarifyReplies();
    },
  },
  {
    // Clarify silence handling (2026-09-18) — hourly: a 24h SMS nudge, then an owner page if still
    // silent. See ticketClarify.clarifySilenceSweep (reviewSilenceSweep's elapsed-time-only pattern,
    // tuned tighter since a ticket/CR clarify is more time-sensitive than a review sign-off).
    id: "ticket-clarify-silence-sweep",
    everyMs: 60 * 60_000,
    run: async () => {
      const { clarifySilenceSweep } = await import("@/lib/friday/ticketClarify");
      return clarifySilenceSweep();
    },
  },
  {
    // Outbound flush — every 5 min, send messages that were held for client quiet hours once their
    // local 08:00 has arrived (re-checked against the rate caps at flush time). See outbound.ts.
    id: "outbound-flush",
    everyMs: 5 * 60_000,
    run: async () => {
      const { flushOutboundQueue } = await import("@/lib/friday/outbound");
      return flushOutboundQueue();
    },
  },
  {
    // Review silence nudge — once/day after 9am: a warm day-3 portal nudge (once, only with client comms
    // on), and a day-7 auto-close that marks the deliverable delivered so nothing sits in limbo. OS
    // portal only (no Google), so not retired. See clientReview.reviewSilenceSweep.
    id: "review-silence-nudge",
    dailyAfterHour: 9,
    run: async () => {
      const { reviewSilenceSweep } = await import("@/lib/friday/clientReview");
      return reviewSilenceSweep();
    },
  },
  {
    // Meeting prep (Wave-2 #5) — every 10 min, look 75 min ahead on the calendar; any event with a
    // known client attendee gets ONE owner briefing (account state + openers). Dedupe per event id.
    // THE single pre-meeting system (the old SMS "premeeting" job was deleted in the Wave-1
    // notification overhaul); delivery is email-only — see meetingPrep.ts.
    id: "meeting-prep-watch",
    everyMs: 10 * 60_000,
    run: async () => {
      const { runMeetingPrepSweep } = await import("@/lib/friday/meetingPrep");
      return runMeetingPrepSweep();
    },
  },
  {
    // Weekly client updates (Wave-2 #7) — Friday afternoons, each active client with movement gets a
    // short plain-English check-in drawn from the task board. Default path = Gmail draft + the
    // approve-to-send loop; sends autonomously only for promoted clients under FRIDAY_AUTHORITY=active.
    // The module's own 6-day dedupe makes the daily fire idempotent within a week.
    id: "weekly-client-update",
    dailyAfterHour: 14,
    run: async () => {
      if (new Date().getDay() !== 5) return "not Friday";
      const { runWeeklyUpdates, summarizeResults } = await import("@/lib/friday/weeklyUpdate");
      return summarizeResults(await runWeeklyUpdates());
    },
  },
  {
    // repoUrl backfill (2026-09-18, mAI Dashboard portal-updates incident) — portal-updates and
    // release-approvals below both key off repoUrl/repoUrls, which no project has ever had
    // populated (only workspaceDir, a local checkout), so both silently no-op forever with no
    // error. Runs first in the tick so a freshly-backfilled repoUrl is visible to portal-updates
    // in the SAME pass. Idempotent — cheap to run hourly, skips anything already populated.
    id: "repo-url-backfill",
    everyMs: 60 * 60_000,
    run: async () => {
      const { runRepoUrlBackfill } = await import("@/lib/friday/repoUrlBackfill");
      return runRepoUrlBackfill();
    },
  },
  {
    // Client-portal development updates — once a day, post a plain-English, sectioned entry
    // (what took place / what we did / how it affects your software / what's live now / what to
    // check) to the OS portal feed for every repo-linked project: one per merged PR, one per merge
    // commit, one per day of direct commits on the default branch. Housekeeping (deps/CI/config-only)
    // is classified by changed files and skipped. First sighting of a repo only initializes its
    // cursor (history belongs to scripts/friday/portal-updates-backfill.ts, never the automation).
    // Kill switch: FRIDAY_PORTAL_UPDATES=off. Per-project: Project.portalUpdates=false.
    // Dedup: local cursor + skippedRefs, server-side source_ref, and per-row commit shas.
    id: "portal-updates",
    dailyAfterHour: 16,
    run: async () => {
      const { runPortalUpdates } = await import("@/lib/friday/portalUpdates");
      return runPortalUpdates();
    },
  },
  {
    // Per-build client release approvals — ensure every open client PR has a pending sign-off
    // row in the OS so the client sees a "Ready for your review" card and the office merge panel
    // shows the badge. Idempotent (server-side dedup on project_id+pr_url). The owner still does
    // the merge+deploy. Kill switch: FRIDAY_RELEASE_APPROVALS=off.
    id: "release-approvals",
    everyMs: 30 * 60_000,
    run: async () => {
      const { runReleaseApprovals } = await import("@/lib/friday/releaseApprovals");
      return runReleaseApprovals();
    },
  },
  {
    // PR shepherd (2026-09-24) — every 10 min, every open PR on every active project's repos is
    // driven toward a merge: superseded/stale upkeep closed, conflicts updated or rebased, failing
    // checks and review comments fixed in a worktree on the PR branch, QA where needed, then a
    // gated merge (pinned head sha) + production deploy wait + probe. Also does the old pr-watcher
    // duty (a PR merged elsewhere completes its task). FRIDAY_PR_SHEPHERD=off|dry|active (dry:
    // decisions logged, no effects).
    id: "pr-shepherd",
    everyMs: 10 * 60_000,
    run: async () => {
      const { runPrShepherd } = await import("@/lib/friday/prShepherd");
      return (await runPrShepherd()).summary;
    },
  },
  {
    // Worm guard (2026-09-28): a repo blocked as malware-suspected is re-scanned every 30 minutes —
    // its default branch is fetched into FRIDAY's bare scan cache (never checked out or run). Clean →
    // the block lifts and the owner is told. "resume <repo>" lifts it by hand.
    id: "worm-recheck",
    everyMs: 30 * 60_000,
    run: async () => {
      const { blockedRepos, recheckBlockedRepos } = await import("@/lib/friday/wormGuard");
      if (!(await blockedRepos()).length) return "no blocked repos";
      return recheckBlockedRepos();
    },
  },
  {
    // Worktree cleanup — once a day. Every coding run now works in its own git worktree under
    // ~/.agentic-os/friday/worktrees (never the owner's checkout); remove the ones untouched for 7
    // days whose task is closed or whose PR branch is gone from origin. Dirty worktrees are kept.
    id: "worktree-sweep",
    dailyAfterHour: 3,
    run: async () => {
      const { sweepWorktrees } = await import("@/lib/friday/delivery");
      const { isClosed } = await import("@/lib/friday/stages");
      const tasks = await store.tasks.all();
      const n = await sweepWorktrees({
        isTaskClosed: async (id8) => {
          const { worktreeTaskClosed } = await import("@/lib/friday/delivery");
          return worktreeTaskClosed(id8, tasks, (s) => isClosed(s) || s === "on_hold");
        },
      });
      return `worktree sweep: removed ${n}`;
    },
  },
  {
    // Overdue / stale nudge — once/day after 8am. Flags active projects past their target end date
    // and in-progress tasks untouched for 3+ days.
    id: "stale-nudge",
    dailyAfterHour: 8,
    run: async () => {
      if (!ownerReachable()) return "no email channel";
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10);
      const [projects, tasks] = await Promise.all([store.projects.all(), store.tasks.all()]);
      const overdue = projects.filter((p) => p.status === "active" && p.targetEndDate && p.targetEndDate < today);
      const stale = tasks.filter((t) => !isClosed(t.status) && t.status === "in_progress" && now - new Date(t.updatedAt).getTime() > 3 * 86_400_000);
      if (!overdue.length && !stale.length) return "nothing stale";
      const parts: string[] = [];
      if (overdue.length) parts.push(`${overdue.length} project(s) past due: ${overdue.slice(0, 3).map((p) => p.name).join(", ")}`);
      if (stale.length) parts.push(`${stale.length} task(s) stuck 3+ days: ${stale.slice(0, 3).map((t) => t.title.slice(0, 40)).join("; ")}`);
      await notifyOwner({ kind: "nudge", text: parts.join("\n"), dedupeKey: `nudge:${today}` });
      return parts.join(" | ");
    },
  },
  {
    // Delivery calendar — daily, put each active project's target end date on the owner's calendar.
    id: "delivery-cal",
    dailyAfterHour: 6,
    run: async () => {
      const { googleConfigured } = await import("@/lib/friday/google/auth");
      if (!googleConfigured()) return "google off";
      const { createEvent } = await import("@/lib/friday/google/calendar");
      const projects = (await store.projects.all()).filter((p) => p.status === "active" && p.targetEndDate);
      const f = path.join(FRIDAY_DATA_DIR, "delivery-cal.json");
      let done: Record<string, string> = {};
      try { done = JSON.parse(await fs.readFile(f, "utf8")); } catch { /* fresh */ }
      let n = 0;
      for (const p of projects) {
        const key = `${p.id}:${p.targetEndDate}`;
        if (done[key]) continue;
        const start = new Date(`${p.targetEndDate}T09:00:00`);
        if (Number.isNaN(start.getTime())) continue;
        const res = await createEvent({ summary: `🎯 ${p.name} — target delivery`, startISO: start.toISOString(), endISO: new Date(start.getTime() + 60 * 60_000).toISOString(), description: "FRIDAY delivery milestone" });
        if (res.ok) { done[key] = new Date().toISOString(); n++; }
      }
      await fs.writeFile(f, JSON.stringify(done, null, 2), "utf8").catch(() => {});
      return `${n} milestone events`;
    },
  },
  {
    // Uptime monitor — every 10 min, GET each active project's deployUrl. Flap-damped (Wave-1
    // notification overhaul): per-project {status, consecutiveFails, lastDownAlertAt} persists to
    // uptime-state.json; a DOWN page fires only after 2 consecutive failed checks AND >6h since
    // that project's last down alert (a sustained outage re-pages every ~6h, a blip never does).
    // "Back up" rides the digest (priority low) instead of paging.
    id: "uptime",
    everyMs: 10 * 60_000,
    run: async () => {
      // Kill switch: the OS runs this check now (friday-website-monitoring, flap-damped the same way).
      // FRIDAY_UPTIME=off here avoids double-paging while both exist.
      if ((process.env.FRIDAY_UPTIME ?? "on").trim().toLowerCase() === "off") return "OFF — uptime runs in the OS (friday-website-monitoring)";
      // Sites come from OS projects.netlify_site_url, local deployUrl only as a fallback (siteTargets.ts,
      // 2026-10-28 audit gap 8 — every project's local deployUrl was empty, so this job reported
      // "no deploy urls" forever). Zero sites is an ERROR now, never a quiet pass. State stays
      // keyed by the local project id when one maps, so existing uptime-state.json keeps working.
      const { resolveSiteTargets, noSitesError } = await import("@/lib/friday/siteTargets");
      const sites = await resolveSiteTargets();
      if (!sites.targets.length) {
        const err = noSitesError("uptime", sites);
        await logEvent("uptime.no_sites", { error: err.message, osError: sites.osError }, { level: "error" }).catch(() => {});
        throw err;
      }
      const projects = sites.targets.map((t) => ({ id: t.key, name: t.name, deployUrl: t.url, status: "active" as const }));
      const f = path.join(FRIDAY_DATA_DIR, "uptime-state.json");
      interface UptimeState { status: "up" | "down"; consecutiveFails: number; lastDownAlertAt?: string }
      let raw: Record<string, unknown> = {};
      try { raw = JSON.parse(await fs.readFile(f, "utf8")); } catch { /* fresh */ }
      // Migrate the legacy flat "up"/"down" string format in place. A legacy "down" was already
      // paged by the old code, so stamp lastDownAlertAt=now to start its 6h re-alert clock.
      const state: Record<string, UptimeState> = {};
      for (const [id, v] of Object.entries(raw)) {
        state[id] = typeof v === "string"
          ? (v === "down"
            ? { status: "down", consecutiveFails: 2, lastDownAlertAt: new Date().toISOString() }
            : { status: "up", consecutiveFails: 0 })
          : (v as UptimeState);
      }
      let alerted = 0;
      for (const p of projects) {
        let ok = false;
        try { ok = (await fetch(p.deployUrl!, { method: "GET", signal: AbortSignal.timeout(8000) })).ok; } catch { ok = false; }
        const prev = state[p.id] ?? { status: "up" as const, consecutiveFails: 0 };
        if (ok) {
          if (prev.status === "down") await notifyOwner({ kind: "uptime.up", priority: "low", text: `${p.name} is back up.`, dedupeKey: `up:${p.id}` });
          // Recovery clears the alert clock, so the NEXT outage is a first alert again.
          state[p.id] = { ...prev, status: "up", consecutiveFails: 0, lastDownAlertAt: undefined };
        } else {
          const consecutiveFails = prev.consecutiveFails + 1;
          const next: UptimeState = { ...prev, consecutiveFails };
          if (consecutiveFails >= 2) {
            next.status = "down"; // only a CONFIRMED outage counts as down (so "back up" can't flap)
            // "First alert of THIS outage" is a transition, not "never alerted": it is true until the
            // first alert of the current down-streak has been stamped. The first alert is held until
            // the emergency threshold (3 fails) so the one allowlisted production emergency actually
            // fires; re-alerts every 6h while still down are timely emails.
            const firstAlert = prev.status !== "down" || !next.lastDownAlertAt;
            const sinceAlert = next.lastDownAlertAt ? Date.now() - Date.parse(next.lastDownAlertAt) : Infinity;
            const due = firstAlert ? consecutiveFails >= 3 : sinceAlert > SIX_H;
            if (due) {
              alerted++;
              next.lastDownAlertAt = new Date().toISOString();
              // Emergency (through CLARA) only on the FIRST confirmed outage of a real production
              // URL after 3 consecutive fails; the 6h re-alert while still down is a timely email,
              // and preview deploys never escalate.
              const preview = /--[a-z0-9-]+\.netlify\.app/i.test(p.deployUrl ?? "");
              const emergency = firstAlert && consecutiveFails >= 3 && p.status === "active" && !preview;
              await notifyOwner({
                kind: emergency ? "uptime.down" : "uptime",
                priority: "critical",
                ...(emergency ? { emergencyCategory: "production" as const } : {}),
                headline: `${p.name} is down`,
                summary: `${p.deployUrl} has failed ${consecutiveFails} consecutive checks${firstAlert ? "" : " and is still down"}.`,
                links: p.deployUrl ? [{ label: "Site", url: p.deployUrl }] : [],
                suggestedAction: "Check the host / last deploy; roll back if a recent deploy caused it.",
                text: `${p.name} looks DOWN (${consecutiveFails} checks): ${p.deployUrl}`,
                dedupeKey: `down:${p.id}:${firstAlert ? "first" : next.lastDownAlertAt.slice(0, 13)}`,
              });
            }
          }
          state[p.id] = next;
        }
      }
      // Drop state for anything we no longer probe. Without this the last reading is frozen
      // forever: archiving a project stops the probe but leaves its row behind, and
      // clientHealth.ts (and therefore the daily brief's "Watch" section) keeps reporting that
      // stale reading as a live outage. "Springfield Website Redo is DOWN (66 consecutive fails)"
      // sat in every morning brief for days after the project was archived and its deploy URL
      // (a long-dead netlify preview) stopped being checked at all.
      const monitored = new Set(projects.map((p) => p.id));
      let pruned = 0;
      for (const id of Object.keys(state)) {
        if (!monitored.has(id)) { delete state[id]; pruned++; }
      }
      await fs.writeFile(f, JSON.stringify(state, null, 2), "utf8").catch(() => {});
      return `${projects.length} checked, ${alerted} down alert(s)${pruned ? `, ${pruned} stale entr(y/ies) pruned` : ""}`;
    },
  },
  {
    // Engine-auth watchdog — every 30 min, probe engine auth (engineHealthDeep) and alert the owner
    // when an engine that WAS authed goes un-authed (e.g. an OAuth token expired), so it can be
    // re-logged-in before tasks silently degrade. Only definitive booleans are watched (codex
    // always; claude too when AGENTIC_OS_DEEP_AUTH_PROBE=1).
    //
    // 2026-08-20 incident: the live claude completion probe contends with FRIDAY's own heavy
    // concurrent CLI usage (scheduled tasks, dispatches) and periodically trips session/usage
    // limits, which fail the probe the exact same way a genuine logout does. That paged CRITICAL
    // with a "re-login" instruction that didn't apply, 5-6 times over 4 days, then silently
    // recovered each time (recovery is priority:"normal", which the shared notify-policy always
    // batches, never SMS). Two fixes, mirroring the uptime job's own proven pattern above:
    //   - debounce: only a CONFIRMED lapse (2 consecutive failing ticks, ~30-60 min) pages —
    //     a single blip from contention self-clears before the next tick.
    //   - reason-aware copy: engines.ts now classifies the failure text (session/usage limit vs
    //     a real logout) so a transient hit says so instead of telling the owner to re-login.
    //   - sustained-lapse re-alert: a real, ongoing lapse pages again every 6h instead of going
    //     silent after the first page (engine-auth-state.json read `claude:false` for days with
    //     nothing further said).
    id: "engine-auth-watch",
    everyMs: 30 * 60_000,
    run: async () => {
      const { engineHealthDeep } = await import("@/lib/friday/engines");
      const health = await engineHealthDeep();
      const f = path.join(FRIDAY_DATA_DIR, "engine-auth-state.json");
      interface EngineAuthState { authed: boolean; consecutiveFails: number; lastAlertAt?: string; reason?: string }
      let raw: Record<string, unknown> = {};
      try { raw = JSON.parse(await fs.readFile(f, "utf8")); } catch { /* fresh */ }
      // Migrate the legacy flat boolean format in place. A legacy `false` was already paged by the
      // old code, so stamp lastAlertAt=now to start its 6h re-alert clock rather than re-paging
      // immediately on the first tick after this ships.
      const state: Record<string, EngineAuthState> = {};
      for (const [id, v] of Object.entries(raw)) {
        state[id] = typeof v === "boolean"
          ? (v ? { authed: true, consecutiveFails: 0 } : { authed: false, consecutiveFails: 2, lastAlertAt: new Date().toISOString() })
          : (v as EngineAuthState);
      }
      let checked = 0;
      let confirmedLapsed = 0;
      for (const [engine, h] of Object.entries(health) as [string, { authed: boolean | null; reason?: "transient" | "auth" | "unknown" }][]) {
        if (typeof h.authed !== "boolean") continue; // skip un-probed (null)
        if (engine === "lmstudio" || engine === "hermes") continue; // retired 2026-09-13 — never page about them
        checked++;
        const prev = state[engine] ?? { authed: true, consecutiveFails: 0 };
        if (h.authed) {
          if (prev.authed === false) {
            await notifyOwner({ kind: "engine.auth", text: `Engine auth restored: ${engine}.`, dedupeKey: `authok:${engine}:${nowISO().slice(0, 13)}` });
          }
          state[engine] = { authed: true, consecutiveFails: 0 };
        } else {
          const consecutiveFails = prev.consecutiveFails + 1;
          const next: EngineAuthState = { ...prev, consecutiveFails, reason: h.reason };
          if (consecutiveFails >= 2) {
            next.authed = false;
            confirmedLapsed++;
            const sinceAlert = next.lastAlertAt ? Date.now() - Date.parse(next.lastAlertAt) : Infinity;
            if (sinceAlert > SIX_H) {
              next.lastAlertAt = new Date().toISOString();
              const transient = h.reason === "transient";
              await notifyOwner({
                kind: "engine.auth",
                priority: "normal",
                text: transient
                  ? `${engine} CLI is hitting session/usage limits (not a login issue) — should clear on its own; no action needed unless it persists.`
                  : `Engine auth lapsed: ${engine}. Re-login (run \`claude\` → /login, or \`codex login\`) — tasks on ${engine} will fail until then.`,
                dedupeKey: `authlapse:${engine}:${next.lastAlertAt.slice(0, 10)}`,
              });
            }
          }
          state[engine] = next;
        }
      }
      await fs.writeFile(f, JSON.stringify(state, null, 2), "utf8").catch(() => {});
      return `checked ${checked}, ${confirmedLapsed} lapsed`;
    },
  },
  {
    // User-defined recurring agent schedules — fire due ones by creating + dispatching a task through
    // dispatchTask (which applies the approval gate: read-only/analysis auto-runs; deploy/send titles or
    // high risk queue an approval). Respects the daily run budget. Every tick (~1min precision).
    id: "scheduled-agent-tasks",
    everyMs: 60_000,
    run: async () => {
      const { scheduleDue, updateSchedule } = await import("@/lib/friday/schedules");
      // Shared with the OS-scheduled SEO/AI-visibility handlers (osTasks.ts) — same budget gates,
      // same createTask + dispatchTask runner (scheduledDispatch.ts, 2026-10-28).
      const { scheduledBudgetBlock, dispatchScheduledTask, runStillRunning, localScheduleRetired } = await import("@/lib/friday/scheduledDispatch");
      const now = new Date();
      // Retired (lead research) or OS-owned (SEO / AI visibility while FRIDAY_SEO_SCHEDULES_IN_OS=1)
      // local rows never fire here — the OS agent_task_schedules rows drive them now.
      const due = (await store.schedules.all()).filter((s) => !localScheduleRetired(s) && scheduleDue(s, now));
      if (!due.length) return "none due";
      const blocked = await scheduledBudgetBlock(due.length);
      if (blocked) return blocked;
      let fired = 0; const MAX = 5; // backpressure: cap dispatches per tick
      for (const s of due) {
        if (fired >= MAX) break;
        // Skip if a prior run of this schedule is still running (avoid pile-up on slow agents).
        if (await runStillRunning(s.lastRunId)) continue;
        // Resolve target project(s).
        let projects: { id: string; name: string; status?: string }[] = [];
        if (s.targetType === "project" && s.projectId) { const p = await store.projects.get(s.projectId); if (p) projects = [p]; }
        else if (s.targetType === "client" && s.clientId) projects = await store.projects.find((p) => p.clientId === s.clientId && p.status === "active");
        else if (s.targetType === "all-active") projects = (await store.projects.all()).filter((p) => p.status === "active");
        if (!projects.length) { await updateSchedule(s.id, { lastRunAt: now.toISOString(), lastStatus: "no target" }); continue; }
        let lastRunId: string | undefined; let gated = false;
        for (const p of projects) {
          if (fired >= MAX) break;
          const res = await dispatchScheduledTask({ projectId: p.id, projectName: p.name, titleTemplate: s.title, description: s.description, assignee: s.assignee, risk: s.risk });
          if (res.runId) lastRunId = res.runId; else if (res.gated) gated = true;
          fired++;
        }
        await updateSchedule(s.id, { lastRunAt: now.toISOString(), lastRunId, lastStatus: gated ? "awaiting approval" : lastRunId ? "dispatched" : "error" });
        await notifyOwner({ kind: "schedule.dispatched", priority: "low", text: `⏰ Scheduled "${s.name}" → ${projects.length} task(s) on ${projects.map((p) => p.name).slice(0, 3).join(", ")}${gated ? " (needs your approval)" : ""}.`, dedupeKey: `sched:${s.id}:${now.toISOString().slice(0, 10)}` });
      }
      return `${fired} dispatched`;
    },
  },
  {
    // Daily usage summary — how many agent runs today vs. the soft cap (cost/usage visibility).
    // Daily 09:00 stall check-in (Wave 1, F5). For each active client with (a) no client-authored
    // contact in >= 14 days, (b) at least one open task, (c) no open escalation, (d) no check-in
    // sent/queued <30d ago: draft a warm one-paragraph nudge referencing one open item + ask what
    // they want prioritized. Three-state: FRIDAY_STALL_CHECKIN=off|shadow|active. Default `shadow` —
    // drafts + logs would_fire, no Gmail draft or approval queued. Active still ALWAYS rides
    // queueEmailApproval (client-facing hard rule — never auto-sends).
    id: "stall-checkin",
    dailyAfterHour: 9,
    run: async () => {
      const { runStallCheckins, summarizeCheckins, stallCheckinMode } = await import("@/lib/friday/stallCheckin");
      if (stallCheckinMode() === "off") return "off";
      return summarizeCheckins(await runStallCheckins());
    },
  },
  {
    // Wednesday morning dependency-update sweep (Wave 1, F1). For each active project's repos,
    // create + dispatch a devops task to apply PATCH bumps + security patches, run tests, and open
    // a PR (`deps: weekly patch bumps`) if green. The owner reviews/merges via GitHub. Three-state:
    // FRIDAY_DEP_SWEEP=off|shadow|active. Default `shadow` — logs would_fire with the intended
    // prompt, no task/dispatch — so a soak week proves the shape before promotion.
    id: "dep-sweep-weekly",
    dailyAfterHour: 6,
    run: async () => {
      if (new Date().getDay() !== 3) return "not Wednesday";
      const { runDepSweep, summarizeDepSweep, depSweepMode, depSweepOwner } = await import("@/lib/friday/depSweep");
      if (depSweepOwner() === "os") return "skipped — FRIDAY_DEP_SWEEP_OWNER=os (OS devops_housekeeping schedule owns the sweep)"; // single-owner rule (Wave 5)
      if (depSweepMode() === "off") return "off";
      return summarizeDepSweep(await runDepSweep({ max: 5 }));
    },
  },
  {
    // Approval expiry (rewritten 2026-10-28, audit gap 9 / contract §3). The OS approval queue owns
    // expiry now: ONE 48h window, enforced server-side, and an expired ask is status `expired` —
    // NEVER a reject. The bridge applies OS expiries (osApprovalsBridge.markExpired). This job no
    // longer rejects anything; it only reports pending asks that are past 48h but still not raised
    // in the OS (the bridge keeps retrying those), so a stuck raise is visible instead of silent.
    id: "approval-expiry",
    everyMs: 30 * 60_000,
    run: async () => {
      const { APPROVAL_TTL_MS } = await import("@/lib/friday/osApprovalsBridge");
      const now = Date.now();
      const pending = await store.approvals.find((a) => a.status === "pending");
      const unraisedStale = pending.filter((a) => !a.hubId && now - Date.parse(a.requestedAt) > APPROVAL_TTL_MS);
      if (unraisedStale.length) {
        await logEvent("approval.unraised_stale", { count: unraisedStale.length, ids: unraisedStale.slice(0, 10).map((a) => a.id) }, { level: "warn" }).catch(() => {});
        return `${unraisedStale.length} pending ask(s) older than 48h are still not in the OS queue (raise retrying)`;
      }
      return `${pending.length} pending (OS queue owns expiry)`;
    },
  },
  {
    id: "usage-summary",
    dailyAfterHour: 18,
    run: async () => {
      if (!ownerReachable()) return "no email channel";
      const { dailyRunCap } = await import("@/lib/friday/usage");
      const today = new Date().toISOString().slice(0, 10);
      const runs = await store.runs.find((r) => (r.startedAt || "").slice(0, 10) === today);
      const projects = new Set(runs.map((r) => r.projectId).filter(Boolean)).size;
      const errors = runs.filter((r) => r.status === "error").length;
      await notifyOwner({ kind: "usage", priority: "low", text: `Today: ${runs.length} agent run(s) across ${projects} project(s)${errors ? `, ${errors} failed` : ""} (cap ${dailyRunCap()}).`, dedupeKey: `usage:${today}` });
      return `${runs.length} runs`;
    },
  },
];

// Jobs that talk to clients or the owner on FRIDAY's OWN channels (Gmail/Google, Twilio SMS/voice) or read
// Google Calendar/Meet/Drive. Retired in the one-source-of-truth move (2026-10): Clara owns client email
// and calls, the OS owns the owner's approvals, Microsoft replaced Google. They stay in the file until the
// replacements are verified in production, but do not run unless FRIDAY_LEGACY_CHANNELS=on (a rollback
// switch, not a mode). Replacements: weekly-client-update -> portal post + owner-approved email draft
// (weeklyUpdate.ts); stall-checkin / feedback / meeting prep -> Clara; client-docs-drive-sync -> SharePoint.
// client-review-watch / review-silence-nudge were un-retired 2026-10-28: they now run on the OS project
// portal (client_reviews_*), not Gmail.
export const RETIRED_CLIENT_CHANNEL_JOBS: ReadonlySet<string> = new Set([
  "inbox-triage", "gmail-watch-renew", "approval-email-watch",
  "outbound-flush", "stall-checkin", "feedback-watch", "meeting-watcher", "meeting-prep-watch",
  "client-docs-drive-sync", "stale-handoff-sweep",
]);

// Run any due jobs now (also the /api/friday/cron backstop). Serialised; skips overlap via the guard.
export async function runDueJobs(force = false): Promise<{ ran: string[]; results: Record<string, string> }> {
  const now = new Date();
  const state = await loadState();
  const ran: string[] = [];
  const results: Record<string, string> = {};
  for (const job of JOBS) {
    if (RETIRED_CLIENT_CHANNEL_JOBS.has(job.id) && !legacyChannelsOn()) continue; // retired: never due, never run
    if (!force && !isDue(job, state, now)) continue;
    ran.push(job.id);
    try {
      const r = await job.run();
      results[job.id] = typeof r === "string" ? r : "ok";
      // Only SUCCESS advances the cadence stamp — see isDue's failure-backoff note.
      state[job.id] = new Date().toISOString();
      delete state[`${job.id}:retryAt`];
      delete state[`${job.id}:lastError`];
    } catch (e) {
      results[job.id] = `error: ${String(e).slice(0, 120)}`;
      await logEvent("scheduler.error", { job: job.id, error: String(e).slice(0, 200) }, { level: "warn" }).catch(() => {});
      state[`${job.id}:retryAt`] = new Date(Date.now() + 5 * 60_000).toISOString();
      state[`${job.id}:lastError`] = String(e).slice(0, 200);
    }
    await saveState(state);
  }
  if (ran.length) await logEvent("scheduler.tick", { ran, results }).catch(() => {});
  return { ran, results };
}

// Orphan-run reconciliation: any run still "running"/"queued" in the store at boot is orphaned — its
// spawned CLI child died with the previous process. Mark them errored so they don't linger forever and
// inflate /api/health's queueDepth. Runs once at startup.
async function reconcileOrphanRuns(): Promise<void> {
  const orphans = await store.runs.find((r) => r.status === "running" || r.status === "queued");
  for (const r of orphans) {
    await store.runs.update(r.id, { status: "error", error: "orphaned by a server restart (process died mid-run)", endedAt: new Date().toISOString() }).catch(() => {});
  }
  if (orphans.length) await logEvent("runs.reconciled", { orphans: orphans.length }).catch(() => {});
}

// Start the single heartbeat. Idempotent across HMR / multiple imports via a globalThis guard.
// Env kill switch: FRIDAY_SCHEDULERS=off skips every in-process scheduled job (email inbox triage,
// PR/deploy watchers, review sweeps, run-budget checks, etc.). Dashboards + read APIs stay live; only
// the autonomous cron half is muted. Set in .env.local and restart; the watchdog will honor it.
export function startScheduler(): void {
  if ((process.env.FRIDAY_SCHEDULERS ?? "").trim().toLowerCase() === "off") {
    console.warn("[scheduler] FRIDAY_SCHEDULERS=off — in-process scheduled jobs disabled");
    return;
  }
  const g = globalThis as unknown as { __fridaySchedulerStarted?: boolean };
  if (g.__fridaySchedulerStarted) return;
  g.__fridaySchedulerStarted = true;
  void reconcileOrphanRuns().catch(() => {});
  let ticking = false;
  const tick = async () => {
    if (ticking) return; // don't overlap a slow job
    ticking = true;
    try { await runDueJobs(); } catch { /* best-effort */ } finally { ticking = false; }
  };
  // first tick shortly after boot (let the server settle), then every 60s
  setTimeout(tick, 20_000);
  setInterval(tick, 60_000);
  // M1: keep the local clients mirror synced with OS contacts (TTL-gated inside — the 60s
  // interval here just drives the check; actual refreshes happen at most every 5 min).
  const contactsTick = () =>
    void import("@/lib/friday/contactsBridge").then((m) => m.refreshContacts()).catch(() => {});
  setTimeout(contactsTick, 30_000);
  setInterval(contactsTick, 60_000);
  // M2: one-way projects/tasks summary mirror into the OS Projects module (TTL-gated inside).
  const projectsTick = () =>
    void import("@/lib/friday/projectsBridge").then((m) => m.syncProjects()).catch(() => {});
  setTimeout(projectsTick, 45_000);
  setInterval(projectsTick, 120_000);
  logEvent("scheduler.start", { jobs: JOBS.map((j) => j.id) }).catch(() => {});
}
