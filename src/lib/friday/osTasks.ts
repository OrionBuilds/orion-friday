// FRIDAY <-> Orion "Agent Tasks" integration. The OS owns the schedules; this module registers
// FRIDAY's handlers and runs one poll per scheduler tick. Shadow-first: gated by FRIDAY_OS_TASKS
// (off|shadow|active, default shadow). The OS also carries a per-schedule mode, so a run only has
// real side effects when BOTH the env gate and the schedule are 'active'.
//
// The OS is the source of truth. FRIDAY's own local schedules.ts (user-defined per-project work)
// is untouched; the four catalog task_keys below live only in the OS.

import { osClient, osEnabled } from "@/lib/friday/osClient";
import {
  pollOsTasks,
  type HandlerRegistry,
  type PollContext,
  type PollSummary,
  type DueRun,
  type ResolvedRun,
} from "@autom8ionlab/agent-core";

import { dial } from "@/lib/friday/dials";

export type OsTasksMode = "off" | "shadow" | "active";

export function osTasksMode(): OsTasksMode {
  const v = dial("os_tasks"); // dial > FRIDAY_OS_TASKS > "shadow"
  return v === "off" || v === "active" ? v : "shadow";
}

// --- identity cache (agent_whoami) --------------------------------------------------------
let identity: { user_id: string; organization_id: string } | null = null;
async function whoami(): Promise<{ user_id: string; organization_id: string } | null> {
  if (identity) return identity;
  try {
    const raw = await osClient.callTool("agent_whoami", {});
    const parsed = unwrap(raw) as { user_id?: string; organization_id?: string };
    if (parsed?.user_id && parsed?.organization_id) {
      identity = { user_id: parsed.user_id, organization_id: parsed.organization_id };
    }
    return identity;
  } catch {
    return null;
  }
}

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

// --- owner-briefing delivery ---------------------------------------------------------------
// Post owner-facing output to a team channel (team_message_send → A3 inbox fan-out). Channel
// choice: prefer a name that reads like a briefing/ops channel, else the first visible one.
// Best-effort — returns false on any failure so a handler can note it without failing the run.
async function postOwnerBriefing(ctx: PollContext, content: string): Promise<boolean> {
  try {
    const raw = await ctx.osClient.callTool("team_channels_list", { organization_id: ctx.orgId });
    const channels = (unwrap(raw) as Array<{ id: string; name?: string }>) ?? [];
    if (!channels.length) return false;
    const preferred = channels.find((c) => /brief|owner|ops|general|agent/i.test(c.name ?? ""));
    const channel = preferred ?? channels[0];
    await ctx.osClient.callTool("team_message_send", {
      channel_id: channel.id,
      organization_id: ctx.orgId,
      sender_id: ctx.agentUserId,
      content: content.slice(0, 8000),
    });
    return true;
  } catch {
    return false;
  }
}

// --- handlers -----------------------------------------------------------------------------
// Each returns { summary, result }. Owner-facing output is posted via team_message_send by the
// handler when the run is active; in shadow the summary is just recorded on the run.

/**
 * Security-header sweep over every live project site.
 *
 * Deterministic — no LLM, no mutation, no repo access. Same posture as website_system_monitoring
 * next to it: fetch, look, report. That makes it cheap enough to run daily and eval-lockable, and
 * it cannot break a client site by running.
 *
 * The four headers checked are the ones whose ABSENCE is a real finding on a marketing/brochure
 * site. Deliberately NOT checking CSP: a meaningful policy is per-app, and a "missing CSP" alert
 * would fire forever on every site and train the owner to ignore the channel.
 */
const SECURITY_HEADERS: Array<{ header: string; why: string }> = [
  { header: "strict-transport-security", why: "no HSTS — a downgrade to http is possible on first visit" },
  { header: "x-content-type-options", why: "no nosniff — browsers may MIME-sniff a response into script" },
  { header: "x-frame-options", why: "no frame protection — the site can be iframed for clickjacking" },
  { header: "referrer-policy", why: "no referrer policy — full URLs leak to third parties" },
];

async function sweepSiteSecurity(_run?: DueRun, ctx?: PollContext): Promise<{ summary: string; result: Record<string, unknown> }> {
  // Sites come from OS projects.netlify_site_url (local deployUrl fallback) — see siteTargets.ts. Zero
  // targets THROWS so agent_run_report records a failed run instead of a green "0 probed".
  const { resolveSiteTargets, noSitesError } = await import("@/lib/friday/siteTargets");
  const sites = await resolveSiteTargets({ client: ctx?.osClient });
  if (!sites.targets.length) throw noSitesError("site_security_sweep", sites);
  const projects = sites.targets.map((t) => ({ name: t.name, url: t.url }));

  const findings: Array<{ site: string; issue: string; detail: string }> = [];
  let probed = 0;

  for (const p of projects) {
    let res: Response;
    try {
      res = await fetch(p.url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(10_000) });
    } catch {
      // Reachability is website_system_monitoring's job, not this one. Skipping rather than
      // double-reporting keeps one outage to one alert.
      continue;
    }
    probed++;

    if (!/^https:/i.test(res.url)) {
      findings.push({ site: p.name, issue: "no-https", detail: `resolved to ${res.url.split("?")[0]} — not served over https` });
    }
    for (const { header, why } of SECURITY_HEADERS) {
      if (!res.headers.get(header)) findings.push({ site: p.name, issue: header, detail: why });
    }
  }

  if (probed === 0) {
    throw new Error(`site_security_sweep: 0 of ${projects.length} site(s) could be probed (all unreachable) — nothing was checked.`);
  }
  const bySite = new Set(findings.map((f) => f.site));
  return {
    summary: `Security sweep: ${probed} site(s) probed, ${findings.length} finding(s) across ${bySite.size} site(s).`,
    result: {
      probed,
      findings,
      // One alert per SITE, not per header — four missing headers on one site is one piece of work,
      // and four rows would just be noise. Deduped on the site name so a standing gap is one row.
      alerts: [...bySite].map((site) => ({
        kind: "site.security_headers",
        text: `${site} is missing security headers: ${findings.filter((f) => f.site === site).map((f) => f.issue).join(", ")}.`,
        priority: "normal",
        dedupeKey: `site.security_headers:${site}`,
      })),
    },
  };
}

const registry: HandlerRegistry = {
  handlers: {
    "friday.site_security_sweep": sweepSiteSecurity,

    // Owner-described schedules (the OS confirms a plain-words brief into config.instructions).
    // Shadow = read-only plan; approval_required / external_effects = plan + draft parked for
    // approval and executed by deliver below; otherwise orchestrate() as scheduler-origin work.
    // Idempotent per run id via a local link table (osInstruction.ts).
    "friday.instruction": async (run: DueRun, ctx: PollContext) => {
      const { instructionTask, defaultInstructionDeps } = await import("@/lib/friday/osInstruction");
      return instructionTask(run, ctx, await defaultInstructionDeps());
    },

    // SEO / AI-visibility jobs moved from local schedules.json into OS agent_task_schedules
    // (2026-10-28). Same runner as the local schedule: budget gates → createTask → dispatchTask.
    "friday.seo_weekly_audit": async (run: DueRun, ctx: PollContext) => {
      const { runOsSeoJob } = await import("@/lib/friday/osScheduledJobs");
      return runOsSeoJob(run, ctx);
    },
    "friday.ai_visibility_monthly": async (run: DueRun, ctx: PollContext) => {
      const { runOsSeoJob } = await import("@/lib/friday/osScheduledJobs");
      return runOsSeoJob(run, ctx);
    },

    // Keeps the OS project-knowledge notes in step with the code (design: friday-project-knowledge-design.md §5).
    // Off unless FRIDAY_PROJECT_KNOWLEDGE=on. In shadow (env gate or schedule not 'active') it only reports the
    // plan — which notes the new commits touch — and writes nothing.
    "friday.project_knowledge_refresh": async (run: DueRun, ctx: PollContext) => {
      const pk = await import("@/lib/friday/projectKnowledge");
      if (!pk.knowledgeEnabled()) return { summary: "Project knowledge is off (FRIDAY_PROJECT_KNOWLEDGE); nothing to do.", result: { enabled: false } };
      const { sweepKnowledge } = await import("@/lib/friday/projectKnowledgeLive");
      return sweepKnowledge({ dryRun: !(ctx.mode === "active" && run.mode === "active"), reason: "weekly" });
    },

    // Client-portal work — the "treat OS projects like Jira" pair. Triage sweeps
    // acknowledge internally at once; every client-visible reply parks in the OS
    // approval queue and is posted by the matching deliver handler below. Code
    // work routes through createClientRequestTask, i.e. FRIDAY's normal tiered
    // pipeline — a portal ticket can never auto-ship anything.
    "friday.project_ticket_triage": async (run: DueRun, ctx: PollContext) => {
      const { ticketTriage } = await import("@/lib/friday/osTickets");
      return ticketTriage(run, ctx);
    },
    "friday.change_request_triage": async (run: DueRun, ctx: PollContext) => {
      const { changeRequestTriage } = await import("@/lib/friday/osTickets");
      return changeRequestTriage(run, ctx);
    },

    // Fully implemented: reads every agent's recent runs via the OS and reports health/staleness.
    "friday.cross_agent_orchestration": async (_run: DueRun, ctx: PollContext) => {
      const raw = await ctx.osClient.callTool("agent_task_runs_list", { limit: 100 });
      const runs = (unwrap(raw) as Array<{ status: string; created_at: string; agent_user_id: string }>) ?? [];
      const now = Date.now();
      const last24 = runs.filter((r) => now - new Date(r.created_at).getTime() < 86_400_000);
      const failed = last24.filter((r) => r.status === "failed" || r.status === "expired_lease").length;
      const summary =
        `Agent orchestration: ${last24.length} runs in 24h across all agents, ${failed} failed/expired.`;
      return { summary, result: { window_runs: last24.length, failed } };
    },

    // Weekly client health report (Wave 5) — autonomous / owner_briefing, no approval. Composes a
    // per-client status (tasks wrapped 7d, deliverables, uptime, deploy info) from local stores —
    // clientHealth.ts is pure read-only composition; delivery happens HERE. The combined owner
    // summary always rides the run report (result_summary); when BOTH the env gate and the OS
    // schedule are 'active' it is also posted to a team channel via team_message_send, which the
    // A3 inbox fan-out turns into an owner inbox item. Shadow (or a channel failure) = run-report
    // only, never a throw.
    "friday.client_health_report": async (run: DueRun, ctx: PollContext) => {
      const { buildClientHealthReports } = await import("@/lib/friday/clientHealth");
      const { reports, ownerSummary } = await buildClientHealthReports();
      const clients = new Set(reports.map((r) => r.clientId)).size;
      const down = reports.filter((r) => r.sections.uptime.status === "down").length;
      const wrapped = reports.reduce((n, r) => n + r.sections.tasks.completed7d + r.sections.tasks.delivered7d, 0);
      let posted = false;
      if (ctx.mode === "active" && run.mode === "active") {
        posted = await postOwnerBriefing(ctx, ownerSummary);
        if (!posted) ctx.log?.("client_health_report: team_message_send unavailable — summary is on the run report");
      }
      return {
        summary: `Client health: ${reports.length} project(s) / ${clients} client(s), ${wrapped} task(s) wrapped 7d, ${down} down.${posted ? " Briefing posted." : ""}`,
        result: { clients, projects: reports.length, wrapped_7d: wrapped, down, briefing_posted: posted, owner_summary: ownerSummary, reports: reports.slice(0, 20) },
      };
    },

    // Dev/ops housekeeping — the REAL weekly dependency sweep (Wave 5). Single-owner rule: this OS
    // schedule and the local `dep-sweep-weekly` scheduler job must never both dispatch. Ownership is
    // FRIDAY_DEP_SWEEP_OWNER (default `local`): while local owns the sweep this handler runs it
    // dryRun (reports what it WOULD do); flip the env to `os` — which makes the local job no-op —
    // before enabling this schedule for real dispatch. Either way runDepSweep itself still honors
    // FRIDAY_DEP_SWEEP (off|shadow|active): shadow logs would_fire, active creates + dispatches
    // devops tasks through the normal approval gate.
    "friday.devops_housekeeping": async (run) => {
      const { runDepSweep, summarizeDepSweep, depSweepMode, depSweepOwner, isSweepDay } = await import("@/lib/friday/depSweep");
      const owner = depSweepOwner();
      // The sweep is WEEKLY. The OS schedule for this handler is daily, which opened a sibling deps PR
      // every day (they then conflicted on the same lockfile). Gate here so the cadence holds whoever
      // drives it; `config.force` lets an operator run it off-cycle from the OS.
      if (!isSweepDay() && run.config?.force !== true) {
        return { summary: "dep sweep: not Wednesday (sweep runs Wednesdays; the OS schedule is daily)", result: { skipped: true, owner, mode: depSweepMode() } };
      }
      const findings = await runDepSweep({ max: 5, dryRun: owner !== "os" });
      const dry = findings.filter((f) => f.outcome === "dry").length;
      const summary = `Dep sweep (mode=${depSweepMode()}, owner=${owner}): ${summarizeDepSweep(findings) || "no active projects with repos"}${dry ? ` · ${dry} dry (would fire)` : ""}`;
      return {
        summary,
        result: {
          owner,
          mode: depSweepMode(),
          entries: findings.slice(0, 20).map(({ prompt: _prompt, ...rest }) => rest), // drop the long prompt bodies
        },
      };
    },

    // OS data hygiene — read-only OS scans via MCP (stale leads, unsynced integrations).
    // Named "data hygiene" and described as "proposed fixes (owner approves before apply)", but
    // it only ever counted rows and returned the totals — no defect was ever named, let alone
    // fixed. It now finds specific defects, and where a fix is unambiguous it proposes one
    // through the OS approval queue; the deliver handler applies it only after a human approves.
    //
    // The classes it looks for are the ones that actually cost us: an unowned contact drops out
    // of every owner-scoped view, an unreachable one can never be contacted, and an "Unknown
    // +1..." stub means an agent is talking to somebody it cannot identify — which is exactly how
    // 273 of the owner's own messages ended up on an anonymous row.
    "friday.os_data_hygiene": async (run: DueRun, ctx: PollContext) => {
      interface OsContact {
        id: string; first_name?: string | null; last_name?: string | null;
        email?: string | null; phone?: string | null; owner_id?: string | null; status?: string | null;
      }
      const contacts = (unwrap(await ctx.osClient.callTool("contacts_list", { limit: 500 })) as OsContact[]) ?? [];
      const conns = (unwrap(await ctx.osClient.callTool("integration_connections_list", {})) as Array<{ status?: string }>) ?? [];
      const unsynced = conns.filter((c) => c.status && c.status !== "connected" && c.status !== "active").length;

      const active = contacts.filter((c) => (c.status ?? "active") === "active");
      const ownerless = active.filter((c) => !c.owner_id);
      const unreachable = active.filter((c) => !c.email?.trim() && !c.phone?.trim());
      const stubs = active.filter((c) => (c.first_name ?? "").trim() === "Unknown");

      // result.alerts[] is the only channel that surfaces "the run succeeded but something is
      // wrong" in the OS Agent Health pane — run status alone never shows it.
      const alerts: Array<Record<string, unknown>> = [];
      if (unsynced > 0) alerts.push({ kind: "integration.unhealthy", text: `${unsynced} integration connection(s) are not connected/active.`, priority: "warn", dedupeKey: `integration.unhealthy:${unsynced}` });
      if (unreachable.length) alerts.push({ kind: "contact.unreachable", text: `${unreachable.length} active contact(s) have neither an email nor a phone number.`, priority: "warn", dedupeKey: "contact.unreachable" });
      if (stubs.length) alerts.push({ kind: "contact.unidentified", text: `${stubs.length} active contact(s) are still named "Unknown" — an agent is holding a conversation with someone it cannot identify.`, priority: "warn", dedupeKey: "contact.unidentified" });

      const summary = `OS data hygiene: ${active.length} active contacts — ${ownerless.length} unowned, ${unreachable.length} unreachable, ${stubs.length} unidentified; ${unsynced} integration(s) unhealthy.`;
      const result: Record<string, unknown> = {
        scanned: contacts.length,
        unhealthy_integrations: unsynced,
        ownerless: ownerless.length,
        unreachable: unreachable.length,
        unidentified: stubs.length,
        alerts,
      };

      // Only propose a write when the schedule names who unowned contacts should go to. Without
      // an explicit target this reports and stops rather than guessing an owner — a wrong owner
      // is worse than none, because it looks deliberate.
      const targetOwnerId = typeof run.config?.default_owner_id === "string" ? run.config.default_owner_id : null;
      if (!targetOwnerId || ownerless.length === 0) {
        if (ownerless.length && !targetOwnerId) {
          alerts.push({ kind: "hygiene.unconfigured", text: `${ownerless.length} unowned contact(s) found, but this schedule has no config.default_owner_id, so no fix can be proposed.`, priority: "warn", dedupeKey: "hygiene.unconfigured" });
        }
        return { summary, result };
      }

      const names = ownerless.slice(0, 10).map((c) => `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.id).join(", ");
      return {
        summary,
        result: { ...result, assign_owner: { owner_id: targetOwnerId, contact_ids: ownerless.map((c) => c.id) } },
        requestApproval: {
          title: `Assign ${ownerless.length} unowned contact(s) to an owner`,
          description: `${ownerless.length} active contact(s) have no owner_id, so they fall out of every owner-scoped view and never get assigned work. Approving sets owner_id on all of them and records why on each contact's timeline. Nothing else is changed.\n\nAlso found (reported only, no fix proposed): ${unreachable.length} unreachable, ${stubs.length} still named "Unknown", ${unsynced} unhealthy integration(s).`,
          draft_content: { contacts: names + (ownerless.length > 10 ? `, +${ownerless.length - 10} more` : ""), owner_id: targetOwnerId, count: ownerless.length },
        },
      };
    },

    // Website/system monitoring — probe each active project's deploy URL (read-only fetch).
    // Sites come from OS projects.netlify_site_url (local deployUrl fallback); 0 sites THROWS → failed run.
    "friday.website_system_monitoring": async (_run: DueRun, ctx: PollContext) => {
      const { resolveSiteTargets, noSitesError } = await import("@/lib/friday/siteTargets");
      const sites = await resolveSiteTargets({ client: ctx.osClient });
      if (!sites.targets.length) throw noSitesError("website_system_monitoring", sites);
      const projects = sites.targets.map((t) => ({ name: t.name, deployUrl: t.url }));
      const down: string[] = [];
      for (const p of projects) {
        let ok = false;
        try { ok = (await fetch(p.deployUrl!, { method: "GET", signal: AbortSignal.timeout(8000) })).ok; } catch { ok = false; }
        if (!ok) down.push(p.name);
      }
      return {
        summary: `Uptime: ${projects.length} site(s) probed, ${down.length} down${down.length ? " (" + down.slice(0, 5).join(", ") + ")" : ""}.`,
        // A site being down is exactly what result.alerts[] exists for. Without it the run
        // completes clean and the only trace is a summary string nobody reads — one alert per
        // site, deduped on the name so a persistent outage is one row, not one per hour.
        result: {
          probed: projects.length,
          down,
          alerts: down.map((name) => ({
            kind: "site.down",
            text: `${name} did not respond to an uptime probe.`,
            priority: "critical",
            dedupeKey: `site.down:${name}`,
          })),
        },
      };
    },
  },

  deliver: {
    "friday.project_ticket_triage": async (r: ResolvedRun, ctx: PollContext) => {
      const { deliverTicketReplies } = await import("@/lib/friday/osTickets");
      return deliverTicketReplies(r, ctx);
    },
    "friday.change_request_triage": async (r: ResolvedRun, ctx: PollContext) => {
      const { deliverCrReplies } = await import("@/lib/friday/osTickets");
      return deliverCrReplies(r, ctx);
    },
    // Executes an approved friday.instruction run exactly as shown on the approval (the prompt,
    // plan and draft travel in the run result). Idempotent per run id.
    "friday.instruction": async (r: ResolvedRun, ctx: PollContext) => {
      const { deliverInstruction, defaultInstructionDeps } = await import("@/lib/friday/osInstruction");
      return deliverInstruction(r, ctx, await defaultInstructionDeps());
    },

    // Runs only after a human approved the proposal above. The approved payload travels in the
    // run result, so this applies exactly what was shown — it does not re-scan and re-decide,
    // which would let the set drift between the approval and the apply.
    "friday.os_data_hygiene": async (r: ResolvedRun, ctx: PollContext) => {
      const plan = (r.result as { assign_owner?: { owner_id?: string; contact_ids?: string[] } } | undefined)?.assign_owner;
      const ownerId = plan?.owner_id;
      const ids = Array.isArray(plan?.contact_ids) ? plan!.contact_ids! : [];
      if (!ownerId || ids.length === 0) return { delivery: { applied: 0, note: "nothing to apply" } };

      let applied = 0;
      const failed: string[] = [];
      for (const id of ids) {
        try {
          await ctx.osClient.callTool("contacts_update", { id, owner_id: ownerId });
          // Leave a trail on the contact itself. Without it the only record that an agent
          // changed this row lives in a run result nobody opens.
          await ctx.osClient
            .callTool("contact_timeline_add", {
              contact_id: id,
              event_type: "updated",
              user_id: ctx.agentUserId,
              event_data: { by: "friday.os_data_hygiene", change: "owner_id", owner_id: ownerId, reason: "contact had no owner" },
            })
            .catch(() => {});
          applied++;
        } catch (e) {
          // One bad row must not abandon the rest, and a partial apply has to be visible.
          failed.push(`${id.slice(0, 8)}: ${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`);
        }
      }
      // Report partial application honestly: `applied` and `attempted` differing is the signal
      // that some rows were rejected, which a bare success count would hide.
      return { delivery: { applied, attempted: ids.length, owner_id: ownerId, failed } };
    },
  },

  // Reject hooks — run when the OWNER rejects an approval (deliver only runs on approve). Used
  // for the out-of-scope change-request path: rejecting the scope approval means "don't just do
  // this as-is", so FRIDAY hands off to CLARA, who emails the client (CC the owner) to schedule a call
  // about the new scope. Idempotent (dispatches at-most-once per CR via a thread marker).
  onReject: {
    "friday.change_request_triage": async (r: ResolvedRun, ctx: PollContext) => {
      const { onCrRepliesRejected } = await import("@/lib/friday/osTickets");
      return onCrRepliesRejected(r, ctx);
    },
    // First onReject for ticket triage (2026-09-18, clarify-before-route feature) — a rejected
    // clarify ask/apply proceeds anyway with best-effort assumptions rather than leaving the ticket
    // stuck; a rejected plain ticket reply is a no-op, same as before this existed.
    "friday.project_ticket_triage": async (r: ResolvedRun, ctx: PollContext) => {
      const { onTicketClarifyRejected } = await import("@/lib/friday/osTickets");
      return onTicketClarifyRejected(r, ctx);
    },
  },
};

let ran = false;
let catalogLogged = false;

/** Log the schedule catalog the OS holds for this agent, once per process.
 *  agent_task_schedules_list was allowlisted from day one but never called, so
 *  drift between OS rows and registered handlers (site_security_sweep shipped a
 *  handler with no schedule row for weeks) was invisible until a run failed. */
async function logScheduleCatalog(log?: (m: string, e?: unknown) => void): Promise<void> {
  if (catalogLogged) return;
  catalogLogged = true;
  try {
    const raw = await osClient.callTool("agent_task_schedules_list", {});
    const rows = (unwrap(raw) as Array<{ task_key: string; mode: string; cadence: string }>) ?? [];
    const known = new Set(Object.keys(registry.handlers));
    const orphanRows = rows.filter((r) => !known.has(r.task_key)).map((r) => r.task_key);
    const orphanHandlers = [...known].filter((k) => !rows.some((r) => r.task_key === k));
    log?.(
      `os-tasks catalog: ${rows.length} schedule(s) — ` +
      rows.map((r) => `${r.task_key}[${r.mode}/${r.cadence}]`).join(", ") +
      (orphanRows.length ? ` · NO HANDLER for: ${orphanRows.join(", ")}` : "") +
      (orphanHandlers.length ? ` · no schedule row for: ${orphanHandlers.join(", ")}` : ""),
    );
  } catch { /* visibility only — never block the poll */ }
}

/** One poll cycle. Call from the FRIDAY scheduler tick. */
export async function runOsTasksPoll(log?: (m: string, e?: unknown) => void): Promise<PollSummary | null> {
  void logScheduleCatalog(log);
  const mode = osTasksMode();
  if (mode === "off" || !osEnabled()) return null;
  const id = await whoami();
  if (!id) { log?.("os-tasks: whoami failed, skipping"); return null; }
  const ctx: PollContext = {
    osClient,
    orgId: id.organization_id,
    agentUserId: id.user_id,
    mode,
    log,
  };
  const summary = await pollOsTasks(registry, ctx, 5);
  if (!ran || summary.claimed > 0 || summary.delivered > 0) {
    log?.(`os-tasks(${mode}): claimed=${summary.claimed} completed=${summary.completed} parked=${summary.parked} failed=${summary.failed} delivered=${summary.delivered}`);
    ran = true;
  }
  return summary;
}
