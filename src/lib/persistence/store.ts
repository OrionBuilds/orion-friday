// FRIDAY persistence — local-first store.
//
// A tiny, dependency-free document store: one JSON file per collection under
// %USERPROFILE%\.agentic-os\friday\ (cross-platform via os.homedir()), plus JSONL
// append files for high-volume streams (logs, messages). Everything goes through the
// `Store` interface below so a Supabase-backed implementation can replace it later
// WITHOUT touching callers — the entity shapes already mirror the planned SQL tables.
//
// Concurrency model: single-user local app. Reads are cached in-memory; writes are
// write-through with an atomic temp-file rename. The generic Collection/Stream engine
// (including the Windows-hardened atomic write) lives in the shared package —
// @autom8ionlab/agent-core/store. FRIDAY doesn't need the cross-process lock
// (single-process app), so it's off here.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Collection, Stream } from "@autom8ionlab/agent-core";
import { RecallingStream } from "@/lib/friday/recall";

export const FRIDAY_DATA_DIR =
  process.env.AGENTIC_OS_FRIDAY_DATA ?? path.join(os.homedir(), ".agentic-os", "friday");

if (!existsSync(FRIDAY_DATA_DIR)) mkdirSync(FRIDAY_DATA_DIR, { recursive: true });

export function newId(): string {
  return randomUUID();
}

export function nowISO(): string {
  return new Date().toISOString();
}

// ── Typed store surface ──────────────────────────────────────────────────
import type {
  Client, ClientDoc, Project, Task, Agent, Skill, AgentRun, Message, OrchestrationLog, Approval, Schedule, Request, Escalation, OutboundRecord, ModelCall, FormatGrant, TicketClarify,
} from "@/lib/friday/types";

// Run-lifecycle hook (audit 2026-10-28 gap 6): every code run's start and finish is reported to the
// OS (agent_code_runs_report — see lib/friday/codeRunsReport.ts). Run state is written from ~20
// places (orchestrator, detachedRun, the restart-orphan sweep, …), so the hook sits on the one
// thing they all share — the runs collection — instead of on each call site. The listener is
// fire-and-forget: it must never slow, fail or reorder a run write.
export type RunChangeListener = (run: AgentRun, change: { inserted: boolean; patch?: Partial<AgentRun> }) => void;
let runChangeListener: RunChangeListener | null = null;
export function setRunChangeListener(fn: RunChangeListener | null): void {
  runChangeListener = fn;
}
class RunsCollection extends Collection<AgentRun> {
  override async insert(row: AgentRun): Promise<AgentRun> {
    const out = await super.insert(row);
    try { runChangeListener?.(out, { inserted: true }); } catch { /* never break a run write */ }
    return out;
  }
  override async update(id: string, patch: Partial<AgentRun>, opts?: { onlyIf?: (row: AgentRun) => boolean }): Promise<AgentRun | null> {
    const out = await super.update(id, patch, opts);
    if (out) { try { runChangeListener?.(out, { inserted: false, patch }); } catch { /* never break a run write */ } }
    return out;
  }
}

export interface Store {
  clients: Collection<Client>;
  docs: Collection<ClientDoc>;
  projects: Collection<Project>;
  tasks: Collection<Task>;
  agents: Collection<Agent>;
  skills: Collection<Skill>;
  runs: Collection<AgentRun>;
  approvals: Collection<Approval>;
  requests: Collection<Request>;
  escalations: Collection<Escalation>;
  outbound: Collection<OutboundRecord>;
  modelCalls: Collection<ModelCall>;
  schedules: Collection<Schedule>;
  formatGrants: Collection<FormatGrant>; // first-of-kind-then-auto client-format grants (Wave-2 Track B)
  ticketClarifications: Collection<TicketClarify>; // portal ticket/CR clarify-before-route rounds
  messages: Stream<Message>;
  logs: Stream<OrchestrationLog>;
}

export const store: Store = {
  clients: new Collection<Client>(FRIDAY_DATA_DIR, "clients"),
  docs: new Collection<ClientDoc>(FRIDAY_DATA_DIR, "docs"),
  projects: new Collection<Project>(FRIDAY_DATA_DIR, "projects"),
  tasks: new Collection<Task>(FRIDAY_DATA_DIR, "tasks"),
  agents: new Collection<Agent>(FRIDAY_DATA_DIR, "agents"),
  skills: new Collection<Skill>(FRIDAY_DATA_DIR, "skills"),
  runs: new RunsCollection(FRIDAY_DATA_DIR, "runs"),
  approvals: new Collection<Approval>(FRIDAY_DATA_DIR, "approvals"),
  requests: new Collection<Request>(FRIDAY_DATA_DIR, "requests"),
  escalations: new Collection<Escalation>(FRIDAY_DATA_DIR, "escalations"),
  outbound: new Collection<OutboundRecord>(FRIDAY_DATA_DIR, "outbound"),
  modelCalls: new Collection<ModelCall>(FRIDAY_DATA_DIR, "modelCalls"),
  schedules: new Collection<Schedule>(FRIDAY_DATA_DIR, "schedules"),
  formatGrants: new Collection<FormatGrant>(FRIDAY_DATA_DIR, "format_grants"),
  ticketClarifications: new Collection<TicketClarify>(FRIDAY_DATA_DIR, "ticket_clarifications"),
  // RecallingStream = the same JSONL stream, mirrored into the cross-session recall index
  // (lib/friday/recall.ts) so past conversations stay searchable months later.
  messages: new RecallingStream(FRIDAY_DATA_DIR, "messages"),
  logs: new Stream<OrchestrationLog>(FRIDAY_DATA_DIR, "logs"),
};

// Convenience log helper used across the orchestrator.
export async function logEvent(
  event: string,
  data?: Record<string, unknown>,
  opts: { level?: "info" | "warn" | "error"; runId?: string; projectId?: string } = {},
): Promise<void> {
  await store.logs.append({
    id: newId(),
    ts: nowISO(),
    level: opts.level ?? "info",
    event,
    runId: opts.runId,
    projectId: opts.projectId,
    data,
  });
}
