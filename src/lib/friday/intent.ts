// FRIDAY — intent router. The JARVIS layer.
//
// WHY THIS EXISTS HERE TOO. CLARA got this first, for a specific failure: the owner asked her to clean
// their inbox, a keyword regex didn't match their phrasing, the request fell through to a conversational
// model, and the model replied "Inbox swept; junk archived and labeled. All clear." having swept
// nothing. FRIDAY had the same two defects — a fixed-order command grammar, and a conversational
// fallback (ownerChat) that can narrate work it never did.
//
// The loop, the gates and the three anti-lying defences live in agent-core and are shared with
// CLARA. This file is FRIDAY's catalog and her bindings: her authority model decides
// act-vs-ask, her approvals queue holds what needs confirming, her event log records failures.
//
// WHERE THIS SITS RELATIVE TO THE PLANNER. The router runs FIRST, and the planner (orchestrate) is
// the fallback — not the other way round. The planner is good at work-shaped requests ("build X",
// "add a task for Y") and stays exactly as it is. The router covers the direct questions the
// planner had no good answer for ("is anything broken", "how's the pipeline", "deploy staging"),
// which is where the conversational fallback used to invent answers.
//
// HIS AUTHORITY MODEL STAYS AUTHORITATIVE. The gate below asks evaluateAuthority (origin-aware since
// 2026-09: owner/CLARA-originated non-money work is Tier 1) and only vouches for an irreversible tool
// with `force: true` when the mode is ACTIVE and the tier is below 3; everything else queues. The
// legacy policy (autonomy_policy=legacy) still floors deploy at Tier 3 for every profile.

import {
  runIntentLoop, claimsCompletion as coreClaimsCompletion, ToolTelemetry,
  type IntentAdapter, type IntentContextBase, type IntentToolDef, type IntentGate,
  type ToolCallRecord, type IntentOutcome,
} from "@autom8ionlab/agent-core";
import { cliCaller } from "@/lib/friday/intentCli";
import {
  getAgentSettings, settingsFor, refusalFor, filterTools, applyPersona, modelCandidates, narrowCap, osOnlyCap,
  agentKeyFor, type AgentSettingsSnapshot,
} from "@/lib/friday/agentSettings";
import { routerCallModel, geminiToolsEnabled, type Caller } from "@/lib/friday/routerModel";
import { geminiApiKey, geminiMaxOutput } from "@/lib/friday/gemini";
import { OWNER_FIRST, AGENCY } from "@/lib/friday/persona";
import { FRIDAY_DATA_DIR } from "@/lib/persistence/store";
import { store } from "@/lib/persistence/store";
import { logEvent } from "@/lib/persistence/store";
import { shortCode } from "@/lib/friday/risk";
import { newId, nowISO } from "@/lib/persistence/store";
import type { ActionClass } from "@/lib/friday/authority";
import type { Approval } from "@/lib/friday/types";

// Built-in router model. The OS can point FRIDAY (or one subagent) at another model per agent in
// Settings → AI Agents; routerModel.ts tries that first and falls back here. Code caps the OS can
// only narrow: ROUTER_MAX_TURNS (agent-core's default) and ROUTER_MAX_TOKENS (anthropicCaller's).
const MODEL = "claude-sonnet-5";
const ROUTER_MAX_TURNS = 6;
const ROUTER_MAX_TOKENS = 1200;
/** How long a chat/SMS turn waits for a cold settings fetch before using last-good/defaults. */
const SETTINGS_WAIT_MS = 3_000;

export interface IntentContext extends IntentContextBase {
  /**
   * Who is asking. "owner" = the owner (UI/SMS); "clara" = CLARA's verified delegation bridge
   * (owner-sanctioned by construction — she relays their asks). Both are owner-tier for the
   * origin-aware gate below; the distinction is kept for the audit trail.
   */
  principal: "owner" | "clara";
  /**
   * The project the conversation is about (the chat's projectId, resolved). Without it "this
   * project" was unresolvable and the router asked "which project?" even when the caller — CLARA
   * relaying an ask — had already said.
   */
  project?: { id: string; name: string };
  deferSlow?: (tool: ToolDef, args: Record<string, unknown>) => void;
  /**
   * P2.7 streaming: model text deltas forwarded as they generate, for the chat route to pipe to
   * the browser. Provisional — the loop's composed reply stays authoritative. Only honoured on the
   * API-key caller; the CLI fallback stays buffered.
   */
  onToken?: (text: string) => void;
}

export type { ToolCallRecord, IntentOutcome };

/**
 * The shared tool shape plus FRIDAY's own governor input: which ActionClass the authority table
 * should score this tool as.
 */
export type ToolDef = IntentToolDef<IntentContext> & {
  /** Fed to classifyActionTier. "deploy" carries the hard Tier-3 floor. */
  actionClass: ActionClass;
};

export const claimsCompletion = coreClaimsCompletion;

function s(v: unknown): string { return typeof v === "string" ? v : ""; }
function n(v: unknown, dflt: number): number { return typeof v === "number" && Number.isFinite(v) ? v : dflt; }

export const TOOLS: ToolDef[] = [
  {
    name: "deep_work",
    description:
      `THE tool for any request whose answer is a document, audit, plan, or report — if ${OWNER_FIRST} asks for something that would take a person hours at a desk, this is it. Triggers include: 'I need a technical audit of <system/site>', 'put together an architecture doc/proposal/migration plan', 'build me a report/runbook/spreadsheet', 'research X and write it up', or any ask for 'docs', 'documents', or 'deliverables'. Runs autonomously in the background — researches the subject, builds branded documents (PDF/DOCX/XLSX), files them in the shared drive, and pings ${OWNER_FIRST} with links plus anything needing their call. Do NOT fall through to the planner for these — it narrates document work without producing files. NOT for quick questions, status reads, or code dispatch (the task/run pipeline owns coding work).`,
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: `The full work request in ${OWNER_FIRST}'s words, including the target (site/system/client) and the deliverables wanted.` },
        client: { type: "string", description: "Client name, when the work is for a known client." },
      },
      required: ["task"],
    },
    actionClass: "other",
    // Reversible by construction: writes only to its own workspace and Drive — no sends, no
    // deploys. Anything outbound the work implies is produced as a DRAFT deliverable.
    reversible: true,
    speed: "slow",
    describe: (a) => `Deep work: ${String(a.task ?? "").slice(0, 100)}`,
    run: async (a) => {
      const task = String(a.task ?? "").trim();
      if (!task) return { ok: false, line: "deep_work: no task given." };
      const { startDeepWork } = await import("@/lib/friday/deepwork");
      const { line } = startDeepWork(task, { clientName: String(a.client ?? "").trim() || undefined });
      return { ok: true, line };
    },
  },
  {
    name: "convene_meeting",
    description:
      `Call a meeting with ${OWNER_FIRST} in the Office War Room — use when something needs live discussion rather than a message: a decision with tradeoffs, a problem spanning agents, or news that warrants talking through. Creates the room with your topic on the record and pings ${OWNER_FIRST} with the link. Also use when ${OWNER_FIRST} says 'set up a meeting about X'.`,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short meeting title." },
        topic: { type: "string", description: "Your opening statement — why you called this and what needs deciding." },
        include: { type: "array", items: { type: "string", enum: ["clara"] }, description: "Sibling agents who should be in the room too." },
      },
      required: ["title", "topic"],
    },
    actionClass: "other",
    reversible: true,
    speed: "fast",
    describe: (a) => `Convene meeting: ${String(a.title ?? "").slice(0, 60)}`,
    run: async (a) => {
      const base = (process.env.OFFICE_BASE_URL ?? "http://127.0.0.1:3636").replace(/\/$/, "");
      const include = Array.isArray(a.include) ? (a.include as string[]).filter((x) => x === "clara") : [];
      const r = await fetch(`${base}/api/room`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: String(a.title ?? ""), topic: String(a.topic ?? ""), convenedBy: "friday", participants: ["friday", ...include] }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!r || !r.ok) return { ok: false, line: "convene_meeting: the Office isn't reachable — meeting not created." };
      const j = (await r.json()) as { room?: { id: string } };
      if (!j.room?.id) return { ok: false, line: "convene_meeting: the Office answered but no room came back." };
      // No hardcoded Office hostname (2026-10-28 audit; public-template rule): link only
      // when OFFICE_PUBLIC_URL is configured, otherwise name the room without a wrong URL.
      const officeBase = (process.env.OFFICE_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
      const link = officeBase ? ` — ${officeBase}/room` : "";
      const { notifyOwner } = await import("@/lib/friday/notify");
      await notifyOwner({ kind: "meeting.convened", text: `FRIDAY called a meeting: "${String(a.title ?? "")}"${link}`, subject: `Meeting: ${String(a.title ?? "")}` }).catch(() => {});
      return { ok: true, line: `convene_meeting: room "${String(a.title ?? "")}" is open and ${OWNER_FIRST}'s been pinged${link}` };
    },
  },
  {
    name: "run_subagent",
    description:
      `Hand ONE task to a member of your own department and return their report: builder (implementation), qa-e2e (verification/site health), devops-deploy (ships/rollbacks — still gated), reviewer (second opinions), project-manager (status/coordination), client-comms (gated client updates), docs-sop (documentation). Each runs with its own narrow tool set; anything irreversible inside their run still queues for ${OWNER_FIRST}.`,
    input_schema: {
      type: "object",
      properties: {
        subagent: { type: "string", enum: ["builder", "qa-e2e", "devops-deploy", "reviewer", "project-manager", "client-comms", "docs-sop"] },
        task: { type: "string", description: "The single task, fully stated — the specialist sees only this and its own tools." },
      },
      required: ["subagent", "task"],
    },
    actionClass: "other",
    reversible: true,
    speed: "slow",
    describe: (a) => `Run ${String(a.subagent ?? "")} sub-agent: ${String(a.task ?? "").slice(0, 80)}`,
    run: async (a, ctx) => {
      const task = String(a.task ?? "").trim();
      if (!task) return { ok: false, line: "run_subagent: no task given." };
      const { subAgentById, SOULS_DIR } = await import("@/lib/friday/subagents");
      const def = subAgentById(String(a.subagent ?? ""));
      if (!def) return { ok: false, line: `run_subagent: no such department member "${String(a.subagent ?? "")}".` };
      // OS settings for `friday.<id>`: status, model, tools, limits and persona for this member.
      const settings = await getAgentSettings({ maxWaitMs: SETTINGS_WAIT_MS });
      const refusal = refusalFor(settings, def.id);
      if (refusal) return { ok: false, line: `run_subagent: ${refusal}` };
      const { runSubAgent, loadSubAgentSoul } = await import("@autom8ionlab/agent-core");
      // Persona is per agent in the OS (never inherited), so only the member's own row applies to its soul.
      const soul = applyPersona(await loadSubAgentSoul(SOULS_DIR, def), settings?.subagents[agentKeyFor(def.id)] ?? null);
      const key = process.env.ANTHROPIC_API_KEY;
      const out = await runSubAgent(task, { ...ctx, deferSlow: undefined }, adapter(key, undefined, settings, def.id), def, soul);
      return { ok: !out.failed, line: `${def.name} reports:\n${out.reply.slice(0, 1200)}` };
    },
  },
  {
    name: "project_status",
    description:
      `What is happening across the agency right now: active projects, open tasks, running work, and anything awaiting ${OWNER_FIRST}'s approval. Use for 'what's going on', 'where are we', 'status', 'what's in flight'. Pass \`project\` for one project ('how is Globex going?') to get its stage, health, recent activity with provenance, blockers, next steps and anything waiting on ${OWNER_FIRST}.`,
    input_schema: {
      type: "object",
      properties: { project: { type: "string", description: "Project (or client) name or id for a single-project answer. Omit for the agency-wide view." } },
    },
    actionClass: "other",
    reversible: true,
    speed: "fast",
    describe: (a) => (s(a.project) ? `Read status of ${s(a.project)}` : "Read project status"),
    run: async (a, ctx) => {
      if (s(a.project)) {
        const { resolveStatusSubject, buildProjectStatus, renderStatusProse } = await import("@/lib/friday/statusReport");
        const r = await resolveStatusSubject({ type: "project", name: s(a.project) });
        if (!r) return { ok: false, line: `I don't have a project called "${s(a.project)}". Say list_projects to see the names.` };
        if ("candidates" in r) return { ok: false, line: `Which one — ${r.candidates.map((c) => c.name).join(" or ")}?` };
        const sr = await buildProjectStatus(r.project);
        const channel = ctx?.source === "sms" || ctx?.source === "voice" || ctx?.source === "email" ? ctx.source : "chat";
        return { ok: true, line: renderStatusProse(sr, { channel }) };
      }
      const [projects, tasks, runs, approvals] = await Promise.all([
        store.projects.all(), store.tasks.all(), store.runs.all(), store.approvals.all(),
      ]);
      const active = projects.filter((p) => p.status === "active");
      // "completed"/"delivered" are the terminal statuses in this schema — there is no "done".
      const open = tasks.filter((t) => t.status !== "completed" && t.status !== "delivered");
      const running = runs.filter((r) => r.status === "running");
      const pending = approvals.filter((a) => a.status === "pending");
      const lines = [
        `${active.length} active project(s), ${open.length} open task(s), ${running.length} run(s) in flight.`,
        pending.length ? `${pending.length} awaiting your OK — reply to the approval email, or say "approve the ${pending[0].action.slice(0, 40)}".` : "Nothing awaiting your approval.",
      ];
      if (active.length) {
        lines.push(...active.slice(0, 8).map((p) => {
          const mine = open.filter((t) => t.projectId === p.id).length;
          return `· ${p.name} — ${mine} open task(s)`;
        }));
      }
      return { ok: true, line: lines.join("\n") };
    },
  },
  {
    name: "list_projects",
    description: "List projects and their clients. Use to find a project's exact name or id before acting on it.",
    input_schema: {
      type: "object",
      properties: { search: { type: "string", description: "Filter by project or client name." } },
    },
    actionClass: "other",
    reversible: true,
    speed: "fast",
    describe: () => "List projects",
    run: async (a) => {
      const [projects, clients] = await Promise.all([store.projects.all(), store.clients.all()]);
      const byClient = new Map(clients.map((c) => [c.id, c.name]));
      const q = s(a.search).toLowerCase().trim();
      const rows = projects.filter((p) =>
        !q || p.name.toLowerCase().includes(q) || (byClient.get(p.clientId ?? "") ?? "").toLowerCase().includes(q));
      if (!rows.length) return { ok: true, line: q ? `No project matching "${q}".` : "No projects." };
      return {
        ok: true,
        line: `Projects (${rows.length}):\n` + rows.slice(0, 20).map((p) =>
          `· ${p.id.slice(0, 8)} — ${p.name}${p.clientId ? ` · ${byClient.get(p.clientId) ?? "?"}` : ""} · ${p.status}`).join("\n"),
      };
    },
  },
  {
    name: "site_health",
    description:
      "Are the client sites up, and is anything broken? Reads the uptime state and the per-client health report. Use for 'is anything down', 'is anything broken', 'are the sites ok'.",
    input_schema: { type: "object", properties: {} },
    actionClass: "other",
    reversible: true,
    speed: "slow",
    describe: () => "Check client site health",
    run: async () => {
      const { buildClientHealthReports } = await import("@/lib/friday/clientHealth");
      const out = await buildClientHealthReports();
      const down = out.reports.filter((r) => r.sections.uptime.status === "down");
      const head = down.length
        ? `⚠️ ${down.length} site(s) DOWN: ${down.map((r) => r.clientName).join(", ")}.`
        : `All monitored sites responding (${out.reports.length} client report(s)).`;
      return { ok: true, line: `${head}\n${out.ownerSummary ?? ""}`.trim().slice(0, 1500) };
    },
  },
  {
    name: "client_health",
    description: "The per-client health detail — tasks, deliverables, uptime and deploy state for each active client.",
    input_schema: {
      type: "object",
      properties: { client: { type: "string", description: "Filter to one client by name." } },
    },
    actionClass: "other",
    reversible: true,
    speed: "slow",
    describe: (a) => `Client health${s(a.client) ? ` for ${s(a.client)}` : ""}`,
    run: async (a) => {
      const { buildClientHealthReports } = await import("@/lib/friday/clientHealth");
      const out = await buildClientHealthReports();
      const q = s(a.client).toLowerCase().trim();
      const rows = q ? out.reports.filter((r) => r.clientName.toLowerCase().includes(q)) : out.reports;
      if (!rows.length) return { ok: true, line: q ? `No active client matching "${q}".` : "No active clients." };
      return { ok: true, line: rows.slice(0, 10).map((r) => r.text).join("\n").slice(0, 1500) };
    },
  },
  {
    name: "dep_sweep",
    description:
      "Check the client repos for outdated or vulnerable dependencies. Runs in preview mode by default and changes nothing.",
    input_schema: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", description: "Default true. Preview only." },
        max: { type: "number", description: "How many repos to check." },
      },
    },
    actionClass: "other",
    reversible: true,
    speed: "slow",
    describe: (a) => `Dependency sweep${a.dry_run === false ? "" : " (preview)"}`,
    run: async (a) => {
      const { runDepSweep, summarizeDepSweep } = await import("@/lib/friday/depSweep");
      // Defaults to a DRY RUN. Asking "are the deps ok" should never open pull requests as a
      // side effect of the question.
      const rs = await runDepSweep({ dryRun: a.dry_run !== false, max: n(a.max, 10) });
      return { ok: true, line: summarizeDepSweep(rs).slice(0, 1500) };
    },
  },
  {
    name: "dispatch_task",
    description:
      `Put a new piece of work into the system for an agent to pick up. Use when ${OWNER_FIRST} describes something they want done rather than asking a question.`,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: { type: "string" },
        project: { type: "string", description: "Project name or id. Call list_projects if unsure." },
      },
      required: ["title"],
    },
    actionClass: "task_dispatch",
    // Creating a task is internal and undoable — it dispatches an agent, it does not ship anything.
    // The agent's OWN run is separately gated by the authority model when it tries to act.
    reversible: true,
    speed: "fast",
    describe: (a) => `Dispatch task: ${s(a.title)}`,
    run: async (a, ctx) => {
      const title = s(a.title).trim();
      if (!title) return { ok: false, line: "Dispatch: no title given, so I created nothing." };
      const projects = await store.projects.all();
      const { resolveDispatchProject } = await import("@/lib/friday/dispatchProject");
      const project = resolveDispatchProject(projects, s(a.project), ctx.project?.id);
      if (!project) return { ok: false, line: `Dispatch: I couldn't find a project matching "${s(a.project)}", so nothing was created.` };
      const { createTask } = await import("@/lib/friday/repo");
      // `origin` records the CHANNEL the request arrived on, not who asked. FRIDAY's Channel calls
      // the UI "web" where the router calls it "chat"; mapping here is better than widening its
      // type, which every existing Channel consumer would then have to handle.
      const origin = ctx.source === "chat" ? "web" : ctx.source;
      const task = await createTask({ projectId: project.id, title, description: s(a.detail) || title, origin, requestOrigin: ctx.principal === "clara" ? "clara" : "owner" });
      return { ok: true, line: `Created "${title}" on ${project.name} (task ${task.id.slice(0, 8)}).` };
    },
  },
  {
    name: "create_task_from_meeting",
    description:
      `Turn a closed War Room meeting into committed work: reads the archived transcript from the office vault, pulls out the action items assigned to FRIDAY, and files each as a real task. Use after a meeting — 'file my action items from the standup', 'pick up what I owe from that war room' — or when ${OWNER_FIRST} says items from a meeting should be on the board. Names the meeting loosely (title words or date); no name = the most recent one. Creates internal task rows only — nothing ships, nothing reaches a client.`,
    input_schema: {
      type: "object",
      properties: {
        meeting: { type: "string", description: "Which meeting — title words, slug, or date (e.g. 'war room', '2026-08-13'). Omit for the latest." },
        project: { type: "string", description: "Project to file the tasks on. Call list_projects if unsure; omit for the active project." },
      },
    },
    actionClass: "task_dispatch",
    // Same footing as dispatch_task: task rows are internal and undoable (delete or complete
    // them) — that's the reverse gear. Anything an agent then DOES with a task is gated on its
    // own run, not here.
    reversible: true,
    speed: "slow",
    describe: (a) => `File FRIDAY's action items from ${s(a.meeting) ? `meeting "${s(a.meeting).slice(0, 50)}"` : "the latest meeting"}`,
    run: async (a, ctx) => {
      const { createTasksFromMeeting } = await import("@/lib/friday/meetingTasks");
      // Same channel mapping dispatch_task uses: the router's "chat" is the store's "web".
      const origin = ctx.source === "chat" ? "web" : ctx.source;
      const out = await createTasksFromMeeting({ meeting: s(a.meeting) || undefined, project: s(a.project) || undefined, origin });
      return { ok: out.ok, line: out.line.slice(0, 1500) };
    },
  },
  {
    name: "read_deploys",
    description:
      "Recent Netlify deploys for a project — state, branch, timing, and the error message when one failed. THE read for 'did the deploy go out', 'why did the deploy fail', 'what's live right now'. Read-only, safe anytime.",
    input_schema: {
      type: "object",
      properties: { project: { type: "string", description: "Project name, id, or site/domain." } },
      required: ["project"],
    },
    actionClass: "other",
    reversible: true,
    speed: "fast",
    describe: (a) => `Read recent deploys for ${s(a.project)}`,
    run: async (a) => {
      const projects = await store.projects.all();
      const q = s(a.project).toLowerCase().trim();
      const project = projects.find((p) => p.id === s(a.project) || p.name.toLowerCase().includes(q));
      const { findNetlifySite, listNetlifyDeploys } = await import("@/lib/friday/workspace");
      const site = await findNetlifySite(project?.netlifySiteId || project?.deployUrl || project?.name || s(a.project));
      if (!site) return { ok: false, line: `read_deploys: couldn't resolve a Netlify site for "${s(a.project)}".` };
      const res = await listNetlifyDeploys(site.id, 5);
      if (!res.ok) return { ok: false, line: `read_deploys: ${res.error}` };
      if (!res.deploys.length) return { ok: true, line: `${site.name}: no deploys on record.` };
      const lines = res.deploys.map((d) => {
        const when = d.createdAt ? d.createdAt.replace("T", " ").slice(0, 16) : "?";
        const took = d.deployTimeSec ? ` in ${d.deployTimeSec}s` : "";
        const err = d.state === "error" && d.errorMessage ? ` — ${d.errorMessage.slice(0, 160)}` : "";
        return `· ${when} [${d.state}] ${d.branch ?? ""}${d.commitRef ? `@${d.commitRef}` : ""}${took}${err} (deploy ${d.id.slice(0, 8)})`;
      });
      return { ok: true, line: `${site.name} — last ${res.deploys.length} deploys:\n${lines.join("\n")}` };
    },
  },
  {
    name: "rollback_deploy",
    description:
      `Publish a PREVIOUS Netlify deploy again — the undo for a bad production deploy (site serves the old build immediately). Changes what the client's site serves, so it always needs ${OWNER_FIRST}'s approval. Use read_deploys first to pick the deploy id.`,
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name, id, or site/domain." },
        deploy_id: { type: "string", description: "The deploy to restore (from read_deploys). Omit to restore the most recent 'ready' deploy before the current one." },
      },
      required: ["project"],
    },
    actionClass: "deploy",
    // Changes production, same floor as deploy itself: always queued, never auto-run.
    reversible: false,
    speed: "fast",
    describe: (a) => `Roll back ${s(a.project)} to ${s(a.deploy_id) ? `deploy ${s(a.deploy_id).slice(0, 8)}` : "the previous good deploy"}`,
    run: async (a) => {
      // Only reachable via the approval executor — the router queues this rather than running it.
      const projects = await store.projects.all();
      const q = s(a.project).toLowerCase().trim();
      const project = projects.find((p) => p.id === s(a.project) || p.name.toLowerCase().includes(q));
      const { findNetlifySite, listNetlifyDeploys, restoreNetlifyDeploy } = await import("@/lib/friday/workspace");
      const site = await findNetlifySite(project?.netlifySiteId || project?.deployUrl || project?.name || s(a.project));
      if (!site) return { ok: false, line: `Rollback: couldn't resolve a Netlify site for "${s(a.project)}". Nothing changed.` };
      let deployId = s(a.deploy_id).trim();
      if (!deployId) {
        const res = await listNetlifyDeploys(site.id, 10);
        // [0] is the current (or failed) deploy; the target is the next older one that was ready.
        const prev = res.deploys.slice(1).find((d) => d.state === "ready");
        if (!prev) return { ok: false, line: `Rollback: no previous 'ready' deploy found for ${site.name}. Nothing changed.` };
        deployId = prev.id;
      }
      const r = await restoreNetlifyDeploy(site.id, deployId);
      return r.ok
        ? { ok: true, line: `Rolled ${site.name} back to deploy ${deployId.slice(0, 8)} — the site serves that build now.` }
        : { ok: false, line: `Rollback FAILED for ${site.name}: ${r.error}. The site is unchanged.` };
    },
  },
  {
    name: "deploy",
    description:
      `Ship a project to production on Netlify. This goes live on the client's site. ALWAYS requires ${OWNER_FIRST}'s explicit approval — never assume it.`,
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name or id." },
        clear_cache: { type: "boolean" },
      },
      required: ["project"],
    },
    actionClass: "deploy",
    // Hard irreversible. classifyActionTier already floors deploy at Tier 3 for every profile; this
    // flag means that floor cannot be undone even if the authority table is ever loosened.
    reversible: false,
    speed: "slow",
    describe: (a) => `Deploy ${s(a.project)} to production${a.clear_cache ? " (clear cache)" : ""}`,
    run: async (a) => {
      // Only reachable via the approval executor — the router queues this rather than running it.
      const projects = await store.projects.all();
      const q = s(a.project).toLowerCase().trim();
      const project = projects.find((p) => p.id === s(a.project) || p.name.toLowerCase().includes(q));
      if (!project) return { ok: false, line: `Deploy: no project matching "${s(a.project)}". Nothing shipped.` };
      const { deployNetlify } = await import("@/lib/friday/orchestrator");
      const res = await deployNetlify(project, { clearCache: a.clear_cache === true });
      return { ok: !!res.handled, line: res.message || `Triggered the deploy for ${project.name}.` };
    },
  },
  {
    name: "qa_check_deploy",
    description:
      "Verify a deployed site after (or before) a ship: fetches the production URL plus any per-project QA URLs, checks HTTP status, latency, and expected page content, and reads the TLS certificate's expiry. THE follow-up to deploy and rollback_deploy — 'did the deploy actually work', 'is the site serving right', 'check the cert'. HTTP-level only (no browser), read-only, safe anytime.",
    input_schema: {
      type: "object",
      properties: { project: { type: "string", description: "Project name, id, or a bare domain/URL to check directly." } },
      required: ["project"],
    },
    actionClass: "other",
    reversible: true,
    speed: "slow",
    describe: (a) => `Post-deploy QA check on ${s(a.project)}`,
    run: async (a) => {
      const projects = await store.projects.all();
      const q = s(a.project).toLowerCase().trim();
      const project = projects.find((p) => p.id === s(a.project) || p.name.toLowerCase().includes(q));
      const { qaCheckDeploy, summarizeQaReport } = await import("@/lib/friday/qaDeploy");
      // No project row but the argument looks like an address? Check it directly — "qa check
      // example.com" shouldn't fail on bookkeeping.
      const target = project ?? (/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(s(a.project).trim())
        ? { id: "", name: s(a.project).trim(), deployUrl: s(a.project).trim() }
        : null);
      if (!target) return { ok: false, line: `qa_check_deploy: no project matching "${s(a.project)}" and it doesn't look like a URL. Call list_projects.` };
      const out = await qaCheckDeploy(target);
      if (!out.report) return { ok: false, line: `qa_check_deploy: ${out.error}` };
      return { ok: out.ok, line: summarizeQaReport(out.report).slice(0, 2000) };
    },
  },
  {
    name: "tail_logs",
    description:
      "Read the last N lines of one of FRIDAY's own logs: 'app' (the server's stdout), 'service' (the supervisor loop), 'watchdog', 'backup', 'orchestration' (her event log — runs, approvals, failures), or 'telemetry' (per-tool call records). THE read for 'why did you crash', 'what happened overnight', 'show me the log'. These are FRIDAY's logs, not client-site logs — deploys are read_deploys, sites are site_health. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        log: { type: "string", enum: ["app", "service", "watchdog", "backup", "orchestration", "telemetry"], description: "Which log." },
        lines: { type: "number", description: "How many lines from the end. Default 40, max 200." },
      },
      required: ["log"],
    },
    actionClass: "other",
    reversible: true,
    speed: "fast",
    describe: (a) => `Tail the last ${n(a.lines, 40)} line(s) of the ${s(a.log)} log`,
    run: async (a) => {
      const { tailLog } = await import("@/lib/friday/opsLogs");
      const out = await tailLog(s(a.log), n(a.lines, 40));
      return { ok: out.ok, line: out.text };
    },
  },
  {
    name: "error_rate",
    description:
      "How often FRIDAY's own machinery has been failing: error/warn counts from her event log and per-tool failure rates from telemetry, over a window (default 24h). Use for 'are you healthy', 'anything failing', 'what's your error rate', and as the error-rate step after a deploy. Honest scope: FRIDAY's own logs, NOT client-site errors — those are site_health/read_deploys. Read-only.",
    input_schema: {
      type: "object",
      properties: { window_hours: { type: "number", description: "Look-back window in hours. Default 24, max 336." } },
    },
    actionClass: "other",
    reversible: true,
    speed: "fast",
    describe: (a) => `Error rate over the last ${n(a.window_hours, 24)}h`,
    run: async (a) => {
      const { errorRate, summarizeErrorRate } = await import("@/lib/friday/opsLogs");
      const report = await errorRate(n(a.window_hours, 24));
      return { ok: true, line: summarizeErrorRate(report).slice(0, 1500) };
    },
  },
  {
    name: "weekly_update",
    description:
      `Send the weekly progress update to clients. This is client-facing — it always needs ${OWNER_FIRST}'s approval.`,
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "One client, or omit for all due." },
        dry_run: { type: "boolean", description: "Compose without sending." },
      },
    },
    actionClass: "weekly_update",
    reversible: false, // reaches clients
    speed: "slow",
    describe: (a) => `Weekly update${s(a.client) ? ` for ${s(a.client)}` : " for all due clients"}`,
    run: async (a) => {
      const { runWeeklyUpdates, runWeeklyUpdateForClient, summarizeResults } = await import("@/lib/friday/weeklyUpdate");
      const dryRun = a.dry_run === true;
      const q = s(a.client).toLowerCase().trim();
      if (q) {
        const client = (await store.clients.all()).find((c) => c.name.toLowerCase().includes(q));
        if (!client) return { ok: false, line: `Weekly update: no client matching "${q}". Nothing sent.` };
        return { ok: true, line: summarizeResults([await runWeeklyUpdateForClient(client, { dryRun })]).slice(0, 1200) };
      }
      return { ok: true, line: summarizeResults(await runWeeklyUpdates({ dryRun })).slice(0, 1200) };
    },
  },
  {
    name: "provision_workspace",
    description:
      `Create a new GitHub repo and Netlify site for a project. Creates real remote resources, so it needs ${OWNER_FIRST}'s approval.`,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repo/site name, kebab-case." },
        private: { type: "boolean" },
      },
      required: ["name"],
    },
    actionClass: "other",
    reversible: false, // creates resources on someone else's platform
    speed: "slow",
    describe: (a) => `Provision GitHub repo + Netlify site "${s(a.name)}"`,
    run: async (a) => {
      const { createGithubRepo, createNetlifySite } = await import("@/lib/friday/workspace");
      const name = s(a.name).trim();
      if (!name) return { ok: false, line: "Provision: no name given, so nothing was created." };
      const repo = await createGithubRepo(name, { private: a.private !== false });
      const site = await createNetlifySite(name);
      // Report BOTH outcomes explicitly. A half-provisioned workspace reported as success is how
      // someone spends an afternoon looking for a site that was never created.
      return {
        ok: repo.ok && site.ok,
        line: `Provision "${name}": repo ${repo.ok ? `OK (${repo.url})` : `FAILED — ${repo.error}`}; Netlify ${site.ok ? `OK (${site.url})` : `FAILED — ${site.error}`}.`,
      };
    },
  },

  // ── Google Workspace ──────────────────────────────────────────────────────────────────────────
  //
  // THE OWNER'S MAILBOX AND CALENDAR ARE NOT HERE, AND MUST NOT COME BACK. CLARA is the only agent that
  // manages their email, contacts and calendar. search_mail, read_email_thread, list_calendar and
  // find_free_slot lived here until 2026-08-05 and were removed for that reason — not because they
  // were broken. They were reachable for the first time the moment intentCli.ts made this router
  // actually execute, which is what surfaced the conflict. Route those asks to CLARA instead.
  //
  // What remains is what FRIDAY needs to DELIVER: Drive to find assets, Docs to write them, Meet
  // transcripts to turn a call into work, and Contacts to address a client. Contacts is a
  // deliberate carve-out from the rule above — reading a client's address to send them a
  // deliverable is not managing the owner's address book.
  //
  // The libraries themselves (google/gmail.ts, google/calendar.ts) are UNCHANGED and still used
  // heavily by scheduled automation — emailAgent, approvalEmail, clientNotify, meetingPrep. FRIDAY
  // reading the inbox on a timer to triage CLIENT threads is her job; answering "what's on my
  // calendar" is not. Removing a tool here does not remove a capability there.
  //
  // All read-only. Sending on FRIDAY's behalf already has its own governed paths (approvalEmail,
  // weeklyUpdate) and is deliberately NOT re-exposed here as a raw send.
  {
    // google/docs.ts createDoc has only ever been reachable through the orchestrator's deliverable
    // pipeline — there was no way to ASK for a doc conversationally. Deliberately does NOT share:
    // createDoc's sibling shareDoc reaches a client, and that stays in the approval path. This makes
    // the document and hands back the link; sending it is a separate, gated decision.
    name: "create_doc",
    description:
      "Write content into a new Google Doc and return the link — proposals, SOWs, briefs, recaps, meeting notes. Creates a private doc; it does NOT share or send it to anyone.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Document title." },
        content: { type: "string", description: "Full body text of the document." },
      },
      required: ["title", "content"],
    },
    actionClass: "other",
    reversible: true,
    speed: "slow",
    describe: (a) => `Create a Google Doc: "${s(a.title)}"`,
    run: async (a) => {
      const { createDoc } = await import("@/lib/friday/google/docs");
      const title = s(a.title).trim();
      const content = s(a.content);
      if (!title) return { ok: false, line: "Docs: no title given, so I didn't create anything." };
      if (!content.trim()) return { ok: false, line: "Docs: no content given, so I didn't create an empty doc." };
      // FRIDAY's own account, not the owner's — a doc she was asked to write lives in her Drive.
      const res = await createDoc(title, content, "friday");
      return res.ok
        ? { ok: true, line: `Docs: created "${title}" in FRIDAY's Drive (private — not shared with anyone yet).\n${res.url ?? ""}` }
        : { ok: false, line: `Docs: create FAILED — ${res.error ?? "unknown error"}` };
    },
  },
  {
    // The gated half create_doc's comment promised: sharing REACHES a person outside the system,
    // so it sits behind the same approval queue as deploy and weekly_update — never auto-run.
    // This is also the Phase 5 validation case for the approval scaffold: a brand-new gated write
    // exercising queue → decide → execute end to end, rather than a migrated one.
    name: "share_doc",
    description:
      `Give a named email address access to a Google Doc or Drive file — the doc becomes visible to them the moment this runs. Client-facing, so it ALWAYS queues for ${OWNER_FIRST}'s approval; never assume it went through. Use after create_doc or drive_search when ${OWNER_FIRST} says to share/send a doc to someone. The undo is unshare_doc.`,
    input_schema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "The doc/file id, or its full Docs/Drive URL." },
        email: { type: "string", description: "Who gets access. A real address — from find_contact if you only have a name." },
        role: { type: "string", enum: ["reader", "commenter", "writer"], description: "Access level. Default reader." },
      },
      required: ["doc", "email"],
    },
    actionClass: "client_notify",
    // Reaches a person outside the system the moment it runs — the receiving side can read (and
    // copy) immediately, so treat it like a send. unshare_doc is the reverse gear (§7.4), and it
    // reverses ACCESS, not exposure: what was already seen stays seen.
    reversible: false,
    speed: "fast",
    describe: (a) => `Share doc ${s(a.doc).slice(0, 40)} with ${s(a.email)} as ${s(a.role) || "reader"}`,
    run: async (a) => {
      // Only reachable via the approval executor — the router queues this rather than running it.
      const id = (s(a.doc).match(/\/d\/([A-Za-z0-9_-]{10,})/)?.[1] ?? s(a.doc)).trim();
      const email = s(a.email).trim();
      if (!id) return { ok: false, line: "share_doc: no doc id or link given. Nothing shared." };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, line: `share_doc: "${email}" isn't an email address. Nothing shared.` };
      const role = s(a.role) === "writer" ? "writer" as const : s(a.role) === "commenter" ? "commenter" as const : "reader" as const;
      const { shareDoc } = await import("@/lib/friday/google/docs");
      // The doc may live in FRIDAY's Drive (create_doc) or the owner's (deliverable pipeline) — try
      // hers first, fall back to theirs. Only the owning account can grant access.
      const viaFriday = await shareDoc(id, email, role, "friday");
      if (viaFriday.ok) return { ok: true, line: `Shared doc ${id.slice(0, 12)}… with ${email} as ${role} (from FRIDAY's Drive). Undo: unshare_doc.` };
      const viaOwner = await shareDoc(id, email, role, "owner");
      if (viaOwner.ok) return { ok: true, line: `Shared doc ${id.slice(0, 12)}… with ${email} as ${role} (from ${OWNER_FIRST}'s Drive). Undo: unshare_doc.` };
      return { ok: false, line: `share_doc FAILED — FRIDAY's account: ${viaFriday.error}; ${OWNER_FIRST}'s account: ${viaOwner.error}. Nothing shared.` };
    },
  },
  {
    // Reverse gear for share_doc (§7.4). Gated the same way rollback_deploy is: undoing a
    // client-visible action is itself client-visible, so the owner releases it.
    name: "unshare_doc",
    description:
      `Take a person's access to a Google Doc or Drive file away again — the undo for share_doc. Use when a doc was shared with the wrong person, the wrong version went out, or access should end. Changes what a client can see, so it queues for ${OWNER_FIRST}'s approval. Note what it can't undo: anything they already read or copied.`,
    input_schema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "The doc/file id, or its full Docs/Drive URL." },
        email: { type: "string", description: "Whose access to remove." },
      },
      required: ["doc", "email"],
    },
    actionClass: "client_notify",
    reversible: false,
    speed: "fast",
    describe: (a) => `Remove ${s(a.email)}'s access to doc ${s(a.doc).slice(0, 40)}`,
    run: async (a) => {
      // Only reachable via the approval executor — the router queues this rather than running it.
      const id = (s(a.doc).match(/\/d\/([A-Za-z0-9_-]{10,})/)?.[1] ?? s(a.doc)).trim();
      const email = s(a.email).trim();
      if (!id || !email) return { ok: false, line: "unshare_doc: need both the doc and the email. Nothing changed." };
      const { unshareDoc } = await import("@/lib/friday/google/docs");
      const viaFriday = await unshareDoc(id, email, "friday");
      if (viaFriday.ok) return { ok: true, line: `Removed ${email}'s access to doc ${id.slice(0, 12)}…. Re-sharing would need a fresh share_doc approval.` };
      const viaOwner = await unshareDoc(id, email, "owner");
      if (viaOwner.ok) return { ok: true, line: `Removed ${email}'s access to doc ${id.slice(0, 12)}…. Re-sharing would need a fresh share_doc approval.` };
      return { ok: false, line: `unshare_doc FAILED — FRIDAY's account: ${viaFriday.error}; ${OWNER_FIRST}'s account: ${viaOwner.error}. Their access is unchanged.` };
    },
  },
  {
    name: "drive_search",
    description:
      `Search ${OWNER_FIRST}'s Google Drive for files and folders — deliverables, briefs, assets, exports. Use for 'find the file about X', 'where is the proposal for Y'. Read-only.`,
    input_schema: {
      type: "object",
      properties: {
        name_contains: { type: "string", description: "Text in the file name." },
        max: { type: "number", description: "How many files. Default 15." },
      },
      required: ["name_contains"],
    },
    actionClass: "other",
    reversible: true,
    speed: "slow",
    describe: (a) => `Search Drive for "${s(a.name_contains)}"`,
    run: async (a) => {
      const { listFiles } = await import("@/lib/friday/google/drive");
      const term = s(a.name_contains).trim();
      if (!term) return { ok: false, line: "Drive: no search term given." };
      // Escaped for Drive's query grammar — a stray apostrophe otherwise breaks the whole query.
      const q = `name contains '${term.replace(/'/g, "\\'")}' and trashed = false`;
      const files = await listFiles(q, Math.min(Math.max(n(a.max, 15), 1), 50));
      if (!files.length) return { ok: true, line: `Drive: nothing matching "${term}".` };
      const lines = files.map((f) => `· ${f.name}${f.modifiedTime ? ` · modified ${f.modifiedTime.slice(0, 10)}` : ""}${f.webViewLink ? `\n  ${f.webViewLink}` : ""}`);
      return { ok: true, line: `Drive (${files.length}) matching "${term}":\n${lines.join("\n")}` };
    },
  },
  {
    name: "recent_meetings",
    description:
      "List recent Google Meet calls with their transcripts — who was on, and what was said. Use for 'what did we agree on the call', 'recap my last meeting with X'.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How far back. Default 7." },
        max: { type: "number", description: "How many meetings. Default 5." },
      },
    },
    actionClass: "other",
    reversible: true,
    speed: "slow",
    describe: (a) => `Read the last ${n(a.max, 5)} meeting transcript(s)`,
    run: async (a) => {
      const { listRecentMeetings } = await import("@/lib/friday/google/meet");
      const meetings = await listRecentMeetings(
        Math.min(Math.max(n(a.days, 7), 1), 60),
        Math.min(Math.max(n(a.max, 5), 1), 10),
      );
      if (!meetings.length) return { ok: true, line: "Meet: no transcribed meetings in that window." };
      const lines = meetings.map((m) =>
        `── ${m.startTime}${m.participants.length ? ` · ${m.participants.join(", ")}` : ""}\n${m.text.slice(0, 900)}`);
      return { ok: true, line: `Meetings (${meetings.length}):\n${lines.join("\n\n")}` };
    },
  },
  {
    name: "find_contact",
    description:
      `Look someone up in ${OWNER_FIRST}'s Google Contacts, including people they have only ever emailed. Returns name, email, phone, company. Use for 'what's X's email', 'who is Y', or to fill in a client's details.`,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Name, email, or company." } },
      required: ["query"],
    },
    actionClass: "other",
    reversible: true,
    speed: "slow",
    describe: (a) => `Look up contact "${s(a.query)}"`,
    run: async (a) => {
      const { searchContacts } = await import("@/lib/friday/google/people");
      const hits = await searchContacts(s(a.query), 8);
      if (!hits.length) return { ok: true, line: `Contacts: nobody matching "${s(a.query)}".` };
      const lines = hits.map((c) => {
        const bits = [c.email, c.phone, c.company, c.jobTitle].filter(Boolean);
        return `· ${c.name}${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
      });
      return { ok: true, line: `Contacts (${hits.length}) for "${s(a.query)}":\n${lines.join("\n")}` };
    },
  },
  {
    name: "delegate_to_agent",
    description:
      `Hand a piece of work to CLARA (${OWNER_FIRST}'s calendar, inbox, contacts, scheduling, personal matters — she is the ONLY agent with that access). Use whenever a request is clearly hers rather than FRIDAY's — e.g. 'schedule a call with the client'. Reports what actually came back, so the handoff is provable.`,
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["clara"] },
        task: { type: "string", description: "The request, in plain words, with enough context to act on." },
      },
      required: ["agent", "task"],
    },
    actionClass: "other",
    // reversible: sending the ASK changes nothing on its own — anything client-facing or
    // irreversible still queues for approval on the RECEIVING agent's side. Delegation never
    // launders authority (same reasoning as CLARA's own delegate_to_agent).
    reversible: true,
    speed: "slow",
    describe: (a) => `Delegate to ${s(a.agent).toUpperCase()}: ${s(a.task).slice(0, 80)}`,
    run: async (a) => {
      const { delegateFromFriday } = await import("@/lib/friday/delegateBridge");
      const agent = "clara" as const;
      const name = agent.toUpperCase();
      const r = await delegateFromFriday(agent, s(a.task));
      if (!r.ok) {
        // Same nuance CLARA's tool carries, for the same incident-driven reason: a timeout is NOT
        // "nothing happened" — claiming so invites assigning the same work twice.
        if (r.indeterminate) {
          return {
            ok: false,
            line: `${name} didn't answer in time, so I can't tell you whether it landed — it may be queued and running on her side. Check with her before re-sending; a duplicate ask means duplicate work.`,
          };
        }
        return { ok: false, line: `${name} couldn't be reached — ${r.error ?? "unknown error"}. Nothing was handed over.` };
      }
      const reply = String(r.reply ?? "(no reply)").slice(0, 900);
      const ids = r.taskIds ?? [];
      if (ids.length) {
        const shown = ids.slice(0, 5).map((id) => id.slice(0, 8)).join(", ");
        return { ok: true, line: `${name} took it — ${ids.length} task(s) queued: ${shown}.\n${reply}` };
      }
      // A reply is not a receipt — but no receipt is not proof of no work either. Report what is
      // known and let her reply speak.
      return { ok: true, line: `${name} answered (no task id handed back, so nothing is confirmed queued). Her reply:\n${reply}` };
    },
  },
  {
    name: "recall_sessions",
    description:
      "Search past conversations — full-text over every prior chat session (owner and client channels), months back. Use when a request references something discussed before: 'what did we decide about X', 'didn't we cover this already', 'find that thing the client asked for last month', or when today's ask clearly continues earlier work you don't have in context. Returns matching moments with their session date and topic. Read-only; searches only your own history.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for — plain keywords work best (e.g. 'staging rollout plan')." },
        limit: { type: "number", description: "Max matches to return (default 8)." },
      },
      required: ["query"],
    },
    actionClass: "other",
    reversible: true,
    speed: "fast",
    describe: (a) => `Recall past sessions: ${s(a.query).slice(0, 60)}`,
    run: async (a) => {
      const query = s(a.query).trim();
      if (!query) return { ok: false, line: "recall_sessions: nothing to search for." };
      const { searchRecall } = await import("@/lib/friday/recall");
      const out = await searchRecall(query, Math.min(Math.max(n(a.limit, 8), 1), 20));
      return { ok: true, line: `Recall for "${query}":\n${out}` };
    },
  },
  {
    name: "orchestrator_review",
    description:
      "Run the read-only multi-engine review orchestrator against a client project checkout on this machine (Claude code review + test run + git/GitHub check, plus Codex and Antigravity second opinions), or read back the latest report. Use for 'run an orchestrator review on X', 'audit X with all the engines', 'review the FRIDAY repo', 'show me the latest orchestrator report'. Runs in the background (5-10 min) and writes to the orchestrator's reports/<project>/ folder; nothing in the project is modified. NOT for deploying, fixing, or dispatching work — it only reports.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["run", "latest"], description: "run = start a fresh review; latest = summarize the newest report." },
        project: { type: "string", description: "Folder under the client-projects root (e.g. FRIDAY, Clients/Globex, GitHub/globex-fl) or a registered project name. Default FRIDAY." },
      },
      required: ["action"],
    },
    actionClass: "other",
    // Reversible by construction: every agent is read-only and the only output is a report file
    // outside the project. Starting a run changes nothing in the client's code or deploys.
    reversible: true,
    speed: "slow",
    describe: (a) => `Orchestrator review (${s(a.action) || "run"}): ${s(a.project) || "FRIDAY"}`,
    run: async (a) => {
      const { resolveProject, startOrchestratorReview, latestReport, PROJECTS_ROOT } = await import("@/lib/friday/orchestratorBridge");
      const asked = s(a.project).trim() || "FRIDAY";
      const project = await resolveProject(asked);
      if (!project) return { ok: false, line: `orchestrator_review: no project folder or registered project matching "${asked}" under ${PROJECTS_ROOT}.` };
      if (s(a.action) === "latest") {
        const r = await latestReport(project);
        return r
          ? { ok: true, line: `Latest orchestrator report for ${project} (${r.when}):\n${r.summary}` }
          : { ok: false, line: `No orchestrator reports yet for ${project} — say "run an orchestrator review on ${project}" to start one.` };
      }
      return startOrchestratorReview(project);
    },
  },
];

// ── Router ──────────────────────────────────────────────────────────────────────────────────────

function systemPrompt(ctx: IntentContext): string {
  return `You are FRIDAY, the orchestration intelligence for ${AGENCY} — ${OWNER_FIRST}'s dev, infrastructure and delivery agent.

You are handling a request from ${OWNER_FIRST} over ${ctx.source}.
${ctx.project ? `\nThis conversation is about the project "${ctx.project.name}" (id ${ctx.project.id}). "This project", "the project", or no project named at all mean it — use it; do not ask which project.\n` : ""}
HOW YOU ACT. You have tools. Calling a tool is the ONLY way you can affect anything. You cannot
deploy, dispatch work, or check a site by describing it — if you did not call the tool, it did not
happen, and saying otherwise is the worst thing you can do here.

Therefore:
- If the request maps to a tool, CALL IT. Don't ask permission for reads and internal work; just do
  them and report. Anything that ships or reaches a client will be held for their approval
  automatically — you do not need to ask first, and you must not claim it went out.
- If anything you need to do it correctly is missing or ambiguous — which project, which client, what
  exactly — ASK before acting: every question you need, together in one message, so the work comes out
  exactly as intended. Once they've answered, do it. Never ask them to approve work they asked for.
- If nothing fits, say plainly that you can't do it yet. Never imply it's done.
- NEVER write a sentence claiming you completed something unless a tool returned success for it.

NOT YOURS: ${OWNER_FIRST}'s email, their calendar, and their scheduling. CLARA handles all three and you have no
direct tool for any of them — but you now have delegate_to_agent, so DO NOT just say "ask CLARA":
HAND IT TO HER. "Schedule a call with the client", "when is ${OWNER_FIRST} free", "did X email back" — these
go through delegate_to_agent(agent: "clara") and you report back what she actually said. SEO of every
kind (on-site, off-site, local/GBP) is YOURS. Paid ads and marketing campaigns are out of scope —
say so if asked; there is no other agent to hand it to. Do NOT answer calendar/inbox questions from
memory, from a transcript, or from anything else you happen to know: an answer that did not come
from CLARA reading them is a guess wearing the clothes of a fact. You DO still have Drive, Docs,
Meet transcripts and Contacts — those are yours, for building and addressing client deliverables.

Interpret intent, not keywords. "is anything broken", "what's in flight", "ship the marketing site",
"are the deps rotting" — these are all requests for specific tools. Read what they mean.

You're dry, direct and a bit sharp with ${OWNER_FIRST}. Never with clients.

${ctx.source === "sms" ? "Keep it under 300 characters. This is a text message." : "Be brief."}`;
}

// Per-tool telemetry — wrapped once at registration so no tool can exist uninstrumented.
// Records call/success/latency to <FRIDAY_DATA_DIR>/tool-telemetry.jsonl; never throws.
const TELEMETRY = new ToolTelemetry({ dataDir: FRIDAY_DATA_DIR, agent: "friday" });
const INSTRUMENTED_TOOLS: ToolDef[] = TOOLS.map((t) => ({ ...t, run: TELEMETRY.wrap(t.name, t.run) }));

/**
 * The router adapter. `settings` is the OS snapshot (null = built-in defaults everywhere); `subId`
 * selects a department member's row for model, tools and limits (FRIDAY's own row otherwise). The
 * system prompt always carries FRIDAY's root persona — a member's persona goes on its soul instead
 * (run_subagent), and agent-core's subAgentAdapter wraps this prompt.
 */
function adapter(
  key: string | undefined,
  onToken?: (text: string) => void,
  settings: AgentSettingsSnapshot | null = null,
  subId?: string,
): IntentAdapter<IntentContext, ToolDef> {
  const entry = settingsFor(settings, subId);
  const rootEntry = settingsFor(settings);
  const limits = entry?.limits;
  const agentKey = agentKeyFor(subId);
  // 2026-09-13 owner directive: LM Studio is retired. The intent loop needs an API-style tool-calling
  // caller: the OS-selected model when one is set and runnable (routerModel.ts), else Claude — the API
  // when a key is configured, else the CLI on the owner's subscription (intentCli.ts).
  const callModel = routerCallModel({
    agentKey,
    candidates: modelCandidates(entry),
    anthropicKey: key,
    geminiKey: geminiApiKey(),
    onToken,
    defaultModel: MODEL,
    anthropicMaxTokens: narrowCap(ROUTER_MAX_TOKENS, limits?.max_tokens, { min: 1, integer: true }),
    geminiMaxTokens: narrowCap(geminiMaxOutput(), limits?.max_tokens, { min: 1, integer: true }),
    rateLimitPerMinute: osOnlyCap(limits?.rate_limit_per_minute),
    geminiTools: geminiToolsEnabled(),
    log: (what, meta) => logEvent(`intent.router.${what}`, meta ?? {}, { level: "warn" }).catch(() => {}),
    recordUsage: ({ provider, model, usage, agentKey: k }) => {
      void store.modelCalls.insert({
        id: newId(), ts: nowISO(), engine: "gemini-api", model, provider, authType: "api_key",
        agentRole: k === "friday" ? "router" : k.slice("friday.".length),
        tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, tokensTotal: usage.totalTokens,
      }).catch(() => {});
    },
    make: { cli: () => cliCaller() as unknown as Caller },
  });
  return {
    agent: "friday",
    // OS tools: code catalog ∩ allowed − denied (never widens).
    tools: filterTools(INSTRUMENTED_TOOLS, (t) => t.name, entry),
    maxTurns: narrowCap(ROUTER_MAX_TURNS, limits?.max_turns, { min: 1, integer: true }),
    callModel: async (input) => callModel(input as Parameters<Caller>[0]) as ReturnType<IntentAdapter<IntentContext, ToolDef>["callModel"]>,
    // Soul-prefixed (constitution → persona → learned, from the souls tree at ORION_SOULS_DIR,
    // owner-authored) ahead of the operational prompt. Resilient: a missing souls tree costs voice,
    // not truth — the tool-honesty rules are also enforced structurally by the loop itself.
    // The OS persona (append|replace) applies to the soul only; the operational prompt always stays.
    systemPrompt: async (ctx) => {
      let soul = "";
      try {
        const { soulPrompt } = await import("@autom8ionlab/agent-core");
        const { SOULS_DIR } = await import("@/lib/friday/subagents");
        soul = await soulPrompt(SOULS_DIR, "friday");
      } catch { /* missing souls tree — persona override (if any) still applies below */ }
      const persona = applyPersona(soul, rootEntry);
      return persona.trim() ? `${persona}\n\n---\n\n${systemPrompt(ctx)}` : systemPrompt(ctx);
    },
    gate: async (tool, ctx): Promise<IntentGate> => {
      // Reversible tools READ; they change nothing and nothing about them can be un-done because
      // nothing was done. The authority POLICY floors every class except task_dispatch at tier 3,
      // which is right for the actions it was written for — and wrong here, because it also queued
      // "what's on my calendar" behind an approval the owner would have to reply to before they could be
      // told the answer. That went unnoticed only because the router never ran (see runIntent).
      // The owner's standing rule, the same one CLARA is built on: act on reversible, confirm outbound
      // or irreversible.
      if (tool.reversible) return { decision: "run" };
      // OS require_approval: the authority model may not waive an irreversible tool for this agent.
      if (entry?.require_approval) return { decision: "approve" };

      const { evaluateAuthority } = await import("@/lib/friday/authority");
      // risk "high" for anything irreversible so the authority stamp on the queued row matches how
      // the row is actually being treated. Origin: the router only ever serves the owner (UI/SMS)
      // or CLARA's verified bridge — never a client — so the origin gate is owner-tier here and the
      // floors that remain are critical risk (never "high") and money, which the loop's own text
      // scan does not see; the tool catalog carries no money-moving tool by construction.
      const decision = await evaluateAuthority({
        actionClass: tool.actionClass,
        risk: "high",
        origin: ctx.principal === "clara" ? "clara" : "owner",
      });
      // Tier 3 = the owner decides, always. Tier 1/2 under an ACTIVE mode proceed — with `force`,
      // because agent-core's loop still queues a plain "run" on an irreversible tool; force is the
      // adapter vouching that its own authority model waived the row (logged as gate.force). Shadow
      // mode means the policy is being evaluated but not yet trusted to act, so it still queues.
      if (decision.tier >= 3) return { decision: "approve" };
      if (decision.mode !== "active") return { decision: "approve" };
      return { decision: "run", force: true };
    },
    queueApproval: async (tool, args, ctx, requestText) => {
      const { evaluateAuthority } = await import("@/lib/friday/authority");
      const requestOrigin = ctx.principal === "clara" ? "clara" as const : "owner" as const;
      const authority = await evaluateAuthority({
        actionClass: tool.actionClass,
        risk: tool.reversible ? "low" : "high",
        origin: requestOrigin,
      });
      const approval: Approval = {
        id: newId(),
        action: tool.describe(args).slice(0, 140),
        detail: `Asked over ${ctx.source}: "${requestText.slice(0, 200)}". Approving runs ${tool.name}.`,
        risk: tool.reversible ? "medium" : "high",
        status: "pending",
        requestedAt: nowISO(),
        // The pair that makes this executable — see decideApprovalInner. Without them the row
        // would approve and silently do nothing.
        intentTool: tool.name,
        intentArgs: args,
        authorityTier: authority.mode === "off" ? undefined : authority.tier,
        authorityMode: authority.mode === "off" ? undefined : authority.mode,
        authorityReason: authority.mode === "off" ? undefined : authority.reason,
        requestOrigin,
      };
      await store.approvals.insert(approval);
      await logEvent("approval.queued", { intentTool: tool.name, via: ctx.source, requestOrigin });
      // Raise in the OS approval queue — the only authority (contract §3); the OS notifies once.
      await (await import("@/lib/friday/osApprovalsBridge")).raiseApproval(approval);
      return { code: shortCode(approval.id) };
    },
    log: async (what, meta) => {
      await logEvent("intent.router", { what, ...(meta ?? {}) }, { level: "warn" }).catch(() => {});
    },
  };
}

/**
 * Route one request.
 *
 * Never throws. A failure returns `failed: true` with an honest message — a router that cannot run
 * must not degrade into free prose, because free prose is exactly what invents completions.
 */
export async function runIntent(text: string, ctx: IntentContext): Promise<IntentOutcome> {
  // FRIDAY runs on the Claude CLI (the owner's subscription), not an API key — so the CLI caller is the
  // normal path here, not a fallback. Requiring ANTHROPIC_API_KEY is what silently disabled this
  // router entirely: every call returned failed:true and fell through to the planner. An API key is
  // still honoured when one is set, since it needs no subprocess and is the cheaper call.
  const key = process.env.ANTHROPIC_API_KEY;
  // OS per-agent settings (cached; a cold fetch waits ≤3s, then last-good/defaults — never blocks).
  // Paused/disabled in the OS → refuse and say so. `clarifying` makes both callers (chat, SMS) send
  // this reply rather than fall through to the planner, which would otherwise start the work anyway.
  const settings = await getAgentSettings({ maxWaitMs: SETTINGS_WAIT_MS });
  const refusal = refusalFor(settings);
  if (refusal) {
    await logEvent("intent.router.refused_paused", { status: settings?.root.status, via: ctx.source }, { level: "warn" }).catch(() => {});
    return { reply: refusal, calls: [], failed: false, clarifying: true };
  }
  return runIntentLoop<IntentContext, ToolDef>(text, ctx, adapter(key, ctx.onToken, settings));
}
