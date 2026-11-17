// FRIDAY → Obsidian mirror.
//
// Everything FRIDAY does is mirrored into the vault as human-readable markdown so the
// operator can read/search it in Obsidian and nothing is ever locked inside an app db.
// Layout under <vault>/Agentic OS/:
//   FRIDAY/YYYY-MM-DD.md          — daily orchestration log (one file per day)
//   Clients/<slug>/_client.md     — client overview
//   Projects/<slug>/_project.md   — project overview + live task board snapshot
//   Projects/<slug>/log/YYYY-MM-DD.md — per-project daily activity
//
// Writes are best-effort: a missing/!available vault never breaks the app (returns ok:false).

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { nowHM, todayISO } from "@/lib/vaultWriter";
import type { Client, Project, Task } from "@/lib/friday/types";
import { projectRepos } from "@/lib/friday/types";
import { TASK_STAGES, isClosed } from "@/lib/friday/stages";

const VAULT = config.vaultRoot ?? "";
const AGENTIC = VAULT ? path.join(VAULT, "Agentic OS") : "";
export const VAULT_AVAILABLE = Boolean(VAULT);

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

// One per-path lock for every read-modify-write on a vault note, shared with vaultMemory.ts, so two
// writers of the same file (e.g. the client profile and the client status section) never lose each
// other's update. Keys are resolved absolute paths.
const fileLocks = new Map<string, Promise<unknown>>();
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  fileLocks.set(key, tail);
  // Drop the entry once this queue settles, unless newer work has queued behind it.
  void tail.then(() => { if (fileLocks.get(key) === tail) fileLocks.delete(key); });
  return next;
}
/** Write via a temp file + rename so a reader never sees a half-written note. The temp file is
 *  created owner-only (or with the replaced note's mode) and removed if the write or rename fails. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = (await fs.stat(file)).mode & 0o777; } catch { /* new note */ }
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  let renamed = false;
  try {
    await fs.writeFile(tmp, content, { encoding: "utf8", mode });
    await fs.chmod(tmp, mode); // writeFile's mode is filtered by the umask
    await fs.rename(tmp, file);
    renamed = true;
  } finally {
    if (!renamed) await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function writeFileSafe(file: string, content: string): Promise<{ ok: boolean; path?: string }> {
  if (!AGENTIC) return { ok: false };
  try {
    await ensureDir(path.dirname(file));
    await fs.writeFile(file, content, "utf8");
    return { ok: true, path: path.relative(VAULT, file) };
  } catch {
    return { ok: false };
  }
}

async function appendFileSafe(file: string, header: string, block: string): Promise<{ ok: boolean; path?: string }> {
  if (!AGENTIC) return { ok: false };
  try {
    await ensureDir(path.dirname(file));
    let existing = "";
    try { existing = await fs.readFile(file, "utf8"); } catch { /* new file */ }
    await fs.writeFile(file, existing ? existing + block : header + block, "utf8");
    return { ok: true, path: path.relative(VAULT, file) };
  } catch {
    return { ok: false };
  }
}

// ── Daily FRIDAY log (one file per day) ──────────────────────────────────
export async function appendFridayLog(entry: {
  kind: "chat" | "plan" | "dispatch" | "approval" | "result" | "note";
  actor?: string;      // "You" | "FRIDAY" | agent name
  text: string;
}): Promise<{ ok: boolean; path?: string }> {
  const day = todayISO();
  const file = path.join(AGENTIC, "FRIDAY", `${day}.md`);
  const header = `---\ntags: [friday, agentic-os, ${day}]\ndate: ${day}\n---\n\n# 🛰️ FRIDAY — ${day}\n\n`;
  const actor = entry.actor ?? "FRIDAY";
  const block = `### ${nowHM()} · ${actor} · ${entry.kind}\n${entry.text.trim()}\n\n`;
  return appendFileSafe(file, header, block);
}

// ── Client note ──────────────────────────────────────────────────────────
/** The profile part of Clients/<client>/_client.md (everything above "## Where things stand"). Pure. */
export function renderClientProfile(client: Client): string {
  return `---\ntags: [client, agentic-os]\nstatus: ${client.status}\nid: ${client.id}\n---\n\n` +
    `# 👤 ${client.name}\n\n` +
    (client.jobTitle ? `**Title:** ${client.jobTitle}\n` : "") +
    (client.company ? `**Company:** ${client.company}\n` : "") +
    (client.email ? `**Email:** ${client.email}\n` : "") +
    (client.phone ? `**Phone:** ${client.phone}\n` : "") +
    ((client.addressLine || client.city || client.state || client.postalCode)
      ? `**Address:** ${[client.addressLine, client.city, client.state, client.postalCode].filter(Boolean).join(", ")}\n` : "") +
    `**Status:** ${client.status}\n` +
    (client.tags?.length ? `**Tags:** ${client.tags.join(", ")}\n` : "") +
    `\n${client.notes ? client.notes + "\n" : ""}`;
}

/** Markers around the generated "Where things stand" section, so a heading of the same name inside
 *  the client's own notes can never be mistaken for it. */
export const CLIENT_STATUS_START = "<!-- friday:client-status:start -->";
export const CLIENT_STATUS_END = "<!-- friday:client-status:end -->";

/** The generated status section of an existing client note, markers included ("" when absent — a
 *  note written before the markers existed is regenerated by vault memory on its next write). Pure. */
export function clientStatusSection(md: string): string {
  const start = md.lastIndexOf(CLIENT_STATUS_START);
  if (start < 0) return "";
  const end = md.indexOf(CLIENT_STATUS_END, start);
  if (end < 0) return "";
  return "\n" + md.slice(start, end + CLIENT_STATUS_END.length) + "\n";
}

export function clientNotePath(client: Pick<Client, "name">): string {
  return path.join(AGENTIC, "Clients", slugify(client.name), "_client.md");
}

export async function writeClientNote(client: Client): Promise<{ ok: boolean; path?: string }> {
  if (!AGENTIC) return { ok: false };
  const file = clientNotePath(client);
  try {
    // Same lock as vault memory's client-status write: the whole read-modify-write is serialized, and
    // only the marked status section is carried over, never the client's own notes.
    await withFileLock(file, async () => {
      let status = "";
      try { status = clientStatusSection(await fs.readFile(file, "utf8")); } catch { /* new note */ }
      await writeFileAtomic(file, renderClientProfile(client) + status + `\n*Updated ${client.updatedAt}*\n`);
    });
    return { ok: true, path: path.relative(VAULT, file) };
  } catch {
    return { ok: false };
  }
}

// ── Project note + task board snapshot ───────────────────────────────────
export async function writeProjectNote(
  project: Project,
  client: Client | null,
  tasks: Task[] = [],
): Promise<{ ok: boolean; path?: string }> {
  const file = path.join(AGENTIC, "Projects", slugify(project.name), "_project.md");
  const board = TASK_STAGES
    .map(({ key, label }) => {
      const items = tasks.filter((t) => t.status === key);
      if (!items.length) return "";
      const rows = items.map((t) => `- [${isClosed(t.status) ? "x" : " "}] ${t.title}  _(${t.assignee}, ${t.risk})_`).join("\n");
      return `### ${label}\n${rows}\n`;
    })
    .filter(Boolean)
    .join("\n");
  const md =
    `---\ntags: [project, agentic-os]\nstatus: ${project.status}\nid: ${project.id}\nclient: ${client?.name ?? ""}\n---\n\n` +
    `# 📦 ${project.name}\n\n` +
    (client ? `**Client:** [[Clients/${slugify(client.name)}/_client|${client.name}]]\n` : "") +
    (project.description ? `\n${project.description}\n` : "") +
    `\n**Status:** ${project.status}\n` +
    (project.stack ? `**Stack:** ${project.stack}\n` : "") +
    (project.workspaceDir ? `**Local folder:** \`${project.workspaceDir}\`\n` : "") +
    (projectRepos(project).length ? `**Repos:**\n${projectRepos(project).map((u) => `- ${u}`).join("\n")}\n` : "") +
    (project.deployUrl ? `**Deploy:** ${project.deployUrl}\n` : "") +
    `\n## 🗂️ Task board\n\n${board || "_No tasks yet._"}\n` +
    `\n*Updated ${project.updatedAt}*\n`;
  return writeFileSafe(file, md);
}

// ── Per-project daily activity log ───────────────────────────────────────
export async function appendProjectLog(
  project: Project,
  entry: { actor?: string; kind: string; text: string },
): Promise<{ ok: boolean; path?: string }> {
  const day = todayISO();
  const file = path.join(AGENTIC, "Projects", slugify(project.name), "log", `${day}.md`);
  const header = `---\ntags: [project-log, agentic-os, ${day}]\ndate: ${day}\nproject: ${project.name}\n---\n\n# 📓 ${project.name} — ${day}\n\n`;
  const block = `### ${nowHM()} · ${entry.actor ?? "FRIDAY"} · ${entry.kind}\n${entry.text.trim()}\n\n`;
  return appendFileSafe(file, header, block);
}
