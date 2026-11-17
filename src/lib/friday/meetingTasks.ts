// War Room meeting → FRIDAY's own task list (Phase 5 FRIDAY tranche).
//
// When the owner closes a meeting in the Office, the transcript is archived to the Obsidian vault
// (VaultWriter, section "meetings", <vault>/meetings/YYYY-MM/YYYY-MM-DD <slug>.md) and the close
// route hands each agent its action items as a chat message. This module is the durable half of
// that handoff: read the archived transcript back, pull out the items that are FRIDAY's, and file
// them as real Task rows in her store — committed work the board can see, not just a chat line
// that scrolled away.
//
// Extraction is two-tier: the close route already writes an attributed action-item block as the
// final system turn ("- FRIDAY: …"), so that's parsed directly — deterministic, no model call.
// Only a transcript WITHOUT that block (closed before extraction existed, or extraction came back
// empty) falls back to an LLM read of the turns.
//
// READ-ONLY against the vault — this never writes or edits a transcript. The only writes are task
// inserts into FRIDAY's own store, which are internal and undoable (delete/complete the task).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { store } from "@/lib/persistence/store";
import { createTask } from "@/lib/friday/repo";
import type { Channel } from "@/lib/friday/types";

// Same default the Office's close route uses — one convention, two readers.
// The Office archives War Room / meeting transcripts under the office repo's vault.
// OFFICE_VAULT_PATH wins when set (blank = unset); the default is ~/office/office/vault.
export const DEFAULT_OFFICE_VAULT_PATH = path.join(os.homedir(), "office", "office", "vault");
export function officeVaultPath(env: Record<string, string | undefined> = process.env): string {
  const v = (env.OFFICE_VAULT_PATH ?? "").trim();
  return v || DEFAULT_OFFICE_VAULT_PATH;
}
const VAULT_PATH = officeVaultPath();
let warnedMissingVault = false;
async function vaultExists(): Promise<boolean> {
  try { return (await fs.stat(VAULT_PATH)).isDirectory(); } catch {
    if (!warnedMissingVault) { warnedMissingVault = true; console.warn(`[friday/meetingTasks] Office vault not found at ${VAULT_PATH} — set OFFICE_VAULT_PATH`); }
    return false;
  }
}
const MEETINGS_DIR = path.join(VAULT_PATH, "meetings");

export interface VaultMeeting {
  file: string;      // absolute path
  name: string;      // "2026-08-13 war-room.md"
  title: string;     // frontmatter title, or the slug
  body: string;
}

// List archived meetings, newest first. Jailed to the meetings section: only *.md directly under
// <vault>/meetings/YYYY-MM/ is ever read — no caller-supplied paths.
export async function listVaultMeetings(): Promise<Array<{ file: string; name: string }>> {
  if (!(await vaultExists())) return [];
  try {
    const months = (await fs.readdir(MEETINGS_DIR)).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort().reverse();
    const out: Array<{ file: string; name: string }> = [];
    for (const month of months) {
      const files = (await fs.readdir(path.join(MEETINGS_DIR, month)))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      out.push(...files.map((f) => ({ file: path.join(MEETINGS_DIR, month, f), name: f })));
      if (out.length >= 40) break; // plenty for any "that meeting last week" reference
    }
    return out;
  } catch {
    return []; // no vault on this box, or no meetings yet
  }
}

/** Find one meeting by a loose reference (title words, slug, or date); no reference = latest. */
export async function findVaultMeeting(ref?: string): Promise<VaultMeeting | null> {
  const all = await listVaultMeetings();
  if (!all.length) return null;
  const q = (ref ?? "").toLowerCase().trim();
  const hit = q
    ? all.find((m) => m.name.toLowerCase().includes(q) || m.name.toLowerCase().includes(q.replace(/\s+/g, "-")))
    : all[0];
  if (!hit) return null;
  try {
    const body = await fs.readFile(hit.file, "utf8");
    const title = body.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1] ?? hit.name.replace(/\.md$/, "");
    return { file: hit.file, name: hit.name, title, body };
  } catch {
    return null;
  }
}

// Tier 1: the close route's own attributed block — "- FRIDAY: item" lines. Deterministic.
function itemsFromActionBlock(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/^-\s*FRIDAY:\s*(.+?)\s*$/gim)) out.push(m[1]);
  return out;
}

// Tier 2: LLM read of the transcript, FRIDAY-owned items only. Empty on any failure — a meeting
// that yields no items is a meeting, not an error.
async function itemsFromTranscript(body: string): Promise<string[]> {
  try {
    const { completeJSON, defaultEngine } = await import("@/lib/friday/engines");
    const items = await completeJSON<string[]>({
      engine: defaultEngine(),
      system:
        'This is an archived meeting transcript. Extract ONLY the action items that belong to FRIDAY (the dev/infrastructure/delivery agent) — work she committed to or was assigned. Not CLARA\'s, not the owner\'s, not observations. Reply with ONLY a JSON array of strings, e.g. ["fix the staging redirect"]. Empty array if none.',
      prompt: body.slice(0, 16_000),
      timeoutMs: 90_000,
    });
    return Array.isArray(items) ? items.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 12) : [];
  } catch {
    return [];
  }
}

export interface MeetingTasksResult {
  ok: boolean;
  line: string;
  created: Array<{ id: string; title: string }>;
}

/** Create task rows from a vault meeting's FRIDAY-owned action items. */
export async function createTasksFromMeeting(input: { meeting?: string; project?: string; origin: Channel }): Promise<MeetingTasksResult> {
  const meeting = await findVaultMeeting(input.meeting);
  if (!meeting) {
    return {
      ok: false, created: [],
      line: input.meeting
        ? `create_task_from_meeting: no archived meeting matching "${input.meeting}" in the vault (${MEETINGS_DIR}). Nothing created.`
        : `create_task_from_meeting: no archived meetings in the vault (${MEETINGS_DIR}). Nothing created.`,
    };
  }

  let items = itemsFromActionBlock(meeting.body);
  const via = items.length ? "from the meeting's action-item record" : "extracted from the transcript";
  if (!items.length) items = await itemsFromTranscript(meeting.body);
  if (!items.length) {
    return { ok: true, created: [], line: `"${meeting.title}" (${meeting.name}): no action items assigned to FRIDAY — nothing to file.` };
  }

  // Project: the named one, else the first active — same resolution dispatch_task uses.
  const projects = await store.projects.all();
  const q = (input.project ?? "").toLowerCase().trim();
  const project = q
    ? projects.find((p) => p.id === input.project || p.name.toLowerCase().includes(q))
    : projects.find((p) => p.status === "active");
  if (!project) {
    return { ok: false, created: [], line: `create_task_from_meeting: ${q ? `no project matching "${input.project}"` : "no active project to file against"} — found ${items.length} item(s) but created nothing. Say which project.` };
  }

  // Dedupe against re-runs: an open task with the same title on the same project is the same item.
  const existing = await store.tasks.find((t) => t.projectId === project.id && t.status !== "completed" && t.status !== "delivered");
  const existingTitles = new Set(existing.map((t) => t.title.toLowerCase()));

  const created: Array<{ id: string; title: string }> = [];
  let skipped = 0;
  for (const item of items) {
    const title = item.trim().slice(0, 200);
    if (existingTitles.has(title.toLowerCase())) { skipped++; continue; }
    const task = await createTask({
      projectId: project.id,
      title,
      description: `Action item ${via} "${meeting.title}" (vault: meetings/${path.basename(path.dirname(meeting.file))}/${meeting.name}).`,
      origin: input.origin,
    });
    created.push({ id: task.id, title });
  }

  const head = `"${meeting.title}" → ${created.length} task(s) on ${project.name} (${via})${skipped ? `, ${skipped} already on the board` : ""}.`;
  const rows = created.map((t) => `· ${t.title} (task ${t.id.slice(0, 8)})`);
  return { ok: true, created, line: [head, ...rows].join("\n") };
}
