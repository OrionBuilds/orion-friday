// Mirror client requests into the OS (2026-10-05, owner rule: "all change requests and support
// tickets are visible in the OS and the client portal").
//
// Portal-born tickets/CRs already live in the OS. Asks that arrive by email, SMS or voice go through
// createClientRequestTask and, before this, only ever became FRIDAY-local tasks — the OS project's
// Change Requests / Support Tickets tabs and the client's portal showed nothing.
//
// Each mirrored row is created already `in_progress`: intake has done the clarify / scope / approval
// work, so the osTickets sweeps must not re-run it (a second clarify question or scope park on an ask
// we're already working). What they SHOULD still do — post the completion notice and text the owner when
// the linked task finishes — keys off the `[os-cr:<id>]` / `[os-ticket:<id>]` marker stamped into
// task.details here, the same marker portal-born rows use.

import type { Project, Task } from "@/lib/friday/types";

export type IntakeKind = "bug" | "feature" | "change" | "other";

/** QA / fix / review / rebase rounds are pipeline mechanics, never client asks. */
export const ROUND_TITLE = /^\s*\[(qa|fix|review|rebase)\b/i;
const MARKER = /\[os-(cr|ticket):[^\]\s]+\]/;

export function hasOsMarker(t: Pick<Task, "details" | "description">): boolean {
  return MARKER.test(t.details ?? "") || MARKER.test(t.description ?? "");
}

/** bug → support ticket; everything else → change request. Pure. */
export function osTargetFor(kind: IntakeKind | undefined): { table: "ticket"; requestType: "bug_report" } | { table: "cr"; requestType: "feature" | "scope" | "other" } {
  if (kind === "bug") return { table: "ticket", requestType: "bug_report" };
  if (kind === "feature") return { table: "cr", requestType: "feature" };
  if (kind === "change") return { table: "cr", requestType: "scope" };
  return { table: "cr", requestType: "other" };
}

/** Lower-case, strip leading [tags], collapse punctuation — for de-duping near-identical titles. Pure. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/^\s*(\[[^\]]*\]\s*)+/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export interface MirrorDeps {
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  osProjectId: (localProjectId: string) => Promise<string | null>;
  updateTask: (id: string, patch: Partial<Task>) => Promise<unknown>;
}

async function defaultDeps(): Promise<MirrorDeps> {
  const { osClient, osEnabled } = await import("@/lib/friday/osClient");
  const { osProjectMap } = await import("@/lib/friday/portalUpdates");
  const { updateTask } = await import("@/lib/friday/repo");
  let map: Map<string, string> | null = null;
  return {
    callTool: (name, args) => osClient.callTool(name, args),
    osProjectId: async (localId) => {
      if (!osEnabled()) return null;
      map ??= await osProjectMap().catch(() => new Map<string, string>());
      return map.get(localId) ?? null;
    },
    updateTask: (id, patch) => updateTask(id, patch),
  };
}

function firstRow(raw: unknown): Record<string, unknown> | null {
  let v: unknown = raw;
  if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "text" in (v[0] as object)) {
    try { v = JSON.parse((v[0] as { text: string }).text); } catch { return null; }
  }
  if (Array.isArray(v)) v = v[0];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

export interface MirrorInput {
  task: Pick<Task, "id" | "title" | "details" | "description" | "origin">;
  project: Pick<Project, "id" | "name">;
  kind?: IntakeKind;
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  priority?: "low" | "medium" | "high" | "critical";
}

export type MirrorResult = { ok: true; marker: string; osId: string; table: "cr" | "ticket" } | { ok: false; skipped: string };

/**
 * Create the OS change request / support ticket for one client-request task and stamp its marker
 * into task.details. Best-effort by contract: never throws — intake must not fail on the OS.
 */
export async function mirrorTaskToOs(input: MirrorInput, deps?: Partial<MirrorDeps>): Promise<MirrorResult> {
  try {
    const { task, project } = input;
    if (ROUND_TITLE.test(task.title)) return { ok: false, skipped: "round task" };
    if (hasOsMarker(task)) return { ok: false, skipped: "already linked" };
    if (task.origin === "os_ticket") return { ok: false, skipped: "portal-born" };
    const d = { ...(await defaultDeps()), ...(deps ?? {}) };
    const osId = await d.osProjectId(project.id);
    if (!osId) return { ok: false, skipped: "no OS project" };
    const target = osTargetFor(input.kind);
    const description = (task.details || task.description || task.title).slice(0, 8000);
    const common = {
      project_id: osId,
      title: task.title.slice(0, 200),
      description,
      priority: input.priority ?? "medium",
      ...(input.clientName ? { client_name: input.clientName } : {}),
      ...(input.clientEmail ? { client_email: input.clientEmail } : {}),
      ...(input.clientPhone ? { client_phone: input.clientPhone } : {}),
      status: "in_progress",
    };
    const raw = target.table === "ticket"
      ? await d.callTool("project_support_tickets_create", {
        ...common, request_type: target.requestType, source: task.origin === "email" ? "email" : "internal",
      })
      : await d.callTool("project_change_requests_create", {
        ...common, request_type: target.requestType,
        internal_summary: `Mirrored by FRIDAY from a client request (${task.origin ?? "intake"}); work is tracked on FRIDAY task ${task.id}.`,
      });
    const row = firstRow(raw);
    const id = typeof row?.id === "string" ? row.id : null;
    if (!id) return { ok: false, skipped: "OS create returned no id" };
    const marker = target.table === "ticket" ? `[os-ticket:${id}]` : `[os-cr:${id}]`;
    await d.updateTask(task.id, { details: `${task.details || task.title}\n\n${marker}` });
    return { ok: true, marker, osId: id, table: target.table };
  } catch (e) {
    return { ok: false, skipped: `error: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }
}
