// FRIDAY — vault memory (memory contract v1, shared with CLARA).
//
// Owner rule (2026-09-25): after every task, code review, code edit or any other completion the
// result is stored in the agent's Obsidian vault, and the agent reads that memory BEFORE acting so it
// knows what was previously done and where things were left off. The old vault mirror was write-only
// and lossy (a one-line summary per run, nothing for failures, shepherd outcomes, review rounds or
// ticket actions), and no prompt ever read it back.
//
// Layout under <vault>/Agentic OS/:
//   Projects/<project>/work/<thread>.md   one file per feature thread (the ROOT task of a lineage:
//                                         build → [QA] → [Fix]/[Review]/[Rebase] rounds → merge)
//   Projects/<project>/memory.md          project "Where it stands" + the last 30 events
//   Clients/<client>/_client.md           the client's "Where things stand" across projects
//
// Thread file: YAML frontmatter (thread, project, client, root_task, prs, tickets, status, updated),
// then `## Where it stands` (rewritten on every write) and an append-only `## History` of entries:
//   ### YYYY-MM-DD HH:MM — <kind>: <title>
//   Outcome: … / What was done: … / Findings: … / Declined: … / Left off: … / Next: … / Links: …
// Times are America/New_York. Every write is best-effort: memory never breaks a run.

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";

export type MemoryOutcome = "done" | "failed" | "blocked" | "merged" | "deployed" | "declined" | "waiting" | "gave-up" | "info";

export interface OutcomeInput {
  project: { id: string; name: string; clientId?: string } | null | undefined;
  task?: { id: string; title: string; sourceTaskId?: string; prUrl?: string; prHeadRef?: string } | null;
  kind: string;          // build | qa | review-round | rebase | fix | plan | merge | deploy | ticket | approval | client-message | …
  title: string;
  outcome: MemoryOutcome;
  summary: string;
  findings?: string;
  declined?: string;
  leftOff?: string;
  next?: string;
  links?: Array<{ label: string; url: string }>;
  prUrl?: string;
  ticketId?: string;
  at?: Date;
}

// ── Paths & time ─────────────────────────────────────────────────────────────────────────────────

let rootOverride: string | null = null;
/** Tests point the store at a temp dir. */
export function setMemoryRootForTests(dir: string | null): void { rootOverride = dir; }
function agenticRoot(): string {
  if (rootOverride) return rootOverride;
  const vault = config.vaultRoot ?? "";
  return vault ? path.join(vault, "Agentic OS") : "";
}

export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";
}

const TZ = process.env.FRIDAY_TZ || "America/New_York";
export function localStamp(d = new Date()): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

export function threadSlug(root: { id: string; title: string }): string {
  return `${slugify(stripRoundPrefix(root.title)).slice(0, 50)}-${root.id.slice(0, 8)}`;
}
/** "[QA] [Fix R2] issues from QA — Add markers" → "Add markers" */
export function stripRoundPrefix(title: string): string {
  let t = title;
  for (let i = 0; i < 6; i++) {
    const n = t.replace(/^\s*\[(?:QA|Fix(?:\s*R\d+)?|Review(?:\s*R\d+)?|Rebase(?:\s*R\d+)?|Deps)\]\s*/i, "")
      .replace(/^(?:issues from QA|failing checks|review comments|merge conflicts)\s*—\s*/i, "");
    if (n === t) break;
    t = n;
  }
  return t.trim() || title;
}

// ── Pure document model ─────────────────────────────────────────────────────────────────────────

export interface ThreadMeta { thread: string; project: string; client: string; root_task: string; prs: string[]; tickets: string[]; status: string; updated: string }
export interface ThreadDoc { meta: ThreadMeta; title: string; whereItStands: string; history: string[] }

const cap = (s: string | undefined, n: number) => (s ?? "").replace(/\r/g, "").trim().slice(0, n);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function renderEntry(e: OutcomeInput, stamp = localStamp(e.at)): string {
  const lines = [`### ${stamp.date} ${stamp.time} — ${e.kind}: ${oneLine(e.title).slice(0, 140)}`, `Outcome: ${e.outcome}`];
  const add = (label: string, v: string | undefined, n: number) => { const c = cap(v, n); if (c) lines.push(`${label}: ${c}`); };
  add("What was done", e.summary, 1500);
  add("Findings", e.findings, 2500);
  add("Declined", e.declined, 1200);
  add("Left off", e.leftOff, 600);
  add("Next", e.next, 600);
  const links = (e.links ?? []).filter((l) => l.url).map((l) => `[${l.label}](${l.url})`);
  if (e.prUrl && !links.some((l) => l.includes(e.prUrl!))) links.unshift(`[pull request](${e.prUrl})`);
  if (links.length) lines.push(`Links: ${links.join(" · ")}`);
  return lines.join("\n");
}

const STATUS_OF: Record<MemoryOutcome, string> = {
  done: "in progress", failed: "failed — needs attention", blocked: "blocked", merged: "merged", deployed: "live",
  declined: "declined", waiting: "waiting", "gave-up": "stuck — handed to the owner", info: "in progress",
};

/** The thread status after an outcome. Bookkeeping never rewrites a meaningful state: `info` (a
 *  notification, a ticket reply, a PR closed) keeps whatever the thread was; `done`/`waiting` don't
 *  downgrade a thread that is already merged or live; failures, blocks, give-ups, merges and deploys
 *  always set it. Pure. */
export function nextThreadStatus(prev: string | undefined, outcome: MemoryOutcome): string {
  if (outcome === "info") return prev || STATUS_OF.info;
  if ((outcome === "done" || outcome === "waiting") && (prev === STATUS_OF.merged || prev === STATUS_OF.deployed)) return prev;
  return STATUS_OF[outcome];
}

export function renderWhereItStands(meta: ThreadMeta, e: OutcomeInput): string {
  const prs = meta.prs.length ? meta.prs.join(", ") : "none yet";
  const lines = [
    `Status: ${meta.status}`,
    `Latest: ${e.kind} — ${e.outcome}: ${oneLine(e.summary).slice(0, 240) || oneLine(e.title)}`,
    `Pull requests on this thread: ${prs}${meta.prs.length ? " (push follow-up work to the open one — never open a second PR for this thread)" : ""}`,
  ];
  if (e.leftOff) lines.push(`Left off: ${oneLine(e.leftOff).slice(0, 300)}`);
  if (e.next) lines.push(`Next: ${oneLine(e.next).slice(0, 300)}`);
  return lines.join("\n");
}

export function renderThread(doc: ThreadDoc): string {
  const m = doc.meta;
  const fm = [
    "---",
    `thread: ${m.thread}`,
    `project: ${JSON.stringify(m.project)}`,
    `client: ${JSON.stringify(m.client)}`,
    `root_task: ${m.root_task}`,
    `prs: [${m.prs.join(", ")}]`,
    `tickets: [${m.tickets.join(", ")}]`,
    `status: ${JSON.stringify(m.status)}`,
    `updated: ${m.updated}`,
    "tags: [agentic-os, memory, thread]",
    "---",
  ].join("\n");
  return `${fm}\n\n# ${doc.title}\n\n## Where it stands\n${doc.whereItStands}\n\n## History\n\n${doc.history.join("\n\n")}\n`;
}

export function parseThread(md: string): ThreadDoc | null {
  const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) return null;
  const get = (k: string) => fm[1].match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
  const unq = (v: string) => { try { return v.startsWith("\"") ? JSON.parse(v) as string : v; } catch { return v; } };
  const list = (v: string) => v.replace(/^\[|\]$/g, "").split(",").map((x) => x.trim()).filter(Boolean);
  const title = md.match(/^# (.+)$/m)?.[1]?.trim() ?? "";
  const where = md.match(/## Where it stands\n([\s\S]*?)\n\n## History/)?.[1]?.trim() ?? "";
  const histBody = md.split(/\n## History\n/)[1] ?? "";
  const history = histBody.split(/\n(?=### \d{4}-\d{2}-\d{2} )/).map((h) => h.trim()).filter((h) => h.startsWith("### "));
  return {
    meta: { thread: get("thread"), project: unq(get("project")), client: unq(get("client")), root_task: get("root_task"), prs: list(get("prs")), tickets: list(get("tickets")), status: unq(get("status")), updated: get("updated") },
    title, whereItStands: where, history,
  };
}

/** Apply one outcome to a thread (new or existing). Pure. */
export function applyOutcome(doc: ThreadDoc | null, init: { thread: string; project: string; client: string; rootTask: { id: string; title: string } }, e: OutcomeInput): ThreadDoc {
  const stamp = localStamp(e.at);
  const d: ThreadDoc = doc ?? {
    meta: { thread: init.thread, project: init.project, client: init.client, root_task: init.rootTask.id, prs: [], tickets: [], status: "in progress", updated: "" },
    title: stripRoundPrefix(init.rootTask.title),
    whereItStands: "",
    history: [],
  };
  const prs = new Set(d.meta.prs);
  const pr = e.prUrl ?? e.task?.prUrl;
  if (pr) prs.add(pr);
  const tickets = new Set(d.meta.tickets);
  if (e.ticketId) tickets.add(e.ticketId);
  const meta: ThreadMeta = { ...d.meta, prs: [...prs], tickets: [...tickets], status: nextThreadStatus(doc ? d.meta.status : undefined, e.outcome), updated: `${stamp.date} ${stamp.time}` };
  return { meta, title: d.title, whereItStands: renderWhereItStands(meta, e), history: [...d.history, renderEntry(e, stamp)] };
}

// ── Project memory ──────────────────────────────────────────────────────────────────────────────

export interface ProjectMemory { threads: Record<string, string>; events: string[] } // thread slug → one-line status
export function parseProjectMemory(md: string): ProjectMemory {
  const threads: Record<string, string> = {};
  const where = md.match(/## Where it stands\n([\s\S]*?)(?:\n## |$)/)?.[1] ?? "";
  for (const l of where.split("\n")) {
    const m = l.match(/^- \[\[work\/([^|\]]+)(?:\|[^\]]*)?\]\] — (.*)$/);
    if (m) threads[m[1]] = m[2];
  }
  const ev = md.match(/## Recent events\n([\s\S]*)$/)?.[1] ?? "";
  const events = ev.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  return { threads, events };
}
export function renderProjectMemory(projectName: string, pm: ProjectMemory): string {
  const rows = Object.entries(pm.threads).map(([slug, line]) => `- [[work/${slug}|${slug.replace(/-[0-9a-f]{8}$/, "")}]] — ${line}`);
  return `---\ntags: [agentic-os, memory, project]\nproject: ${JSON.stringify(projectName)}\n---\n\n# ${projectName} — memory\n\n## Where it stands\n${rows.join("\n") || "_No work recorded yet._"}\n\n## Recent events\n${pm.events.map((e) => `- ${e}`).join("\n")}\n`;
}
export function applyProjectEvent(pm: ProjectMemory, threadSlugValue: string | null, threadLine: string | null, event: string, keep = 30): ProjectMemory {
  const threads = { ...pm.threads };
  if (threadSlugValue && threadLine) threads[threadSlugValue] = threadLine;
  // Drop threads that finished long ago so the list stays about what's live.
  return { threads, events: [...pm.events, event].slice(-keep) };
}

// ── Store I/O ───────────────────────────────────────────────────────────────────────────────────

// The per-path lock is shared with obsidian.ts (writeClientNote) so both writers of a note serialize.
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const { withFileLock } = await import("@/lib/persistence/obsidian");
  return withFileLock(key, fn);
}
async function readText(p: string): Promise<string> { try { return await fs.readFile(p, "utf8"); } catch { return ""; } }
async function writeText(p: string, s: string): Promise<void> {
  const { writeFileAtomic } = await import("@/lib/persistence/obsidian");
  await writeFileAtomic(p, s);
}

type TaskLike = { id: string; title: string; sourceTaskId?: string; prUrl?: string };
/** The root task of a lineage (a [QA]/[Fix]/[Review]/[Rebase] round points at it via sourceTaskId). */
export async function rootTaskOf(task: TaskLike, getTask?: (id: string) => Promise<TaskLike | null>): Promise<TaskLike> {
  const load = getTask ?? (async (id: string) => {
    const { store } = await import("@/lib/persistence/store");
    return (await store.tasks.get(id)) as TaskLike | null;
  });
  let cur = task;
  for (let i = 0; i < 12 && cur.sourceTaskId && cur.sourceTaskId !== cur.id; i++) {
    const parent = await load(cur.sourceTaskId).catch(() => null);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

async function clientName(clientId?: string): Promise<string> {
  if (!clientId) return "";
  try { const { store } = await import("@/lib/persistence/store"); return (await store.clients.get(clientId))?.name ?? ""; } catch { return ""; }
}

/**
 * Record one completion in memory: the thread file (when a task is involved), the project memory,
 * the client note, and the existing daily project log. Never throws.
 */
export async function recordOutcome(e: OutcomeInput): Promise<{ ok: boolean; thread?: string }> {
  try {
    const root = agenticRoot();
    if (!root || !e.project) return { ok: false };
    const proj = e.project;
    const projDir = path.join(root, "Projects", slugify(proj.name));
    const client = await clientName(proj.clientId);
    let slug: string | null = null;
    let line: string | null = null;
    if (e.task) {
      const rootTask = await rootTaskOf(e.task);
      slug = threadSlug(rootTask);
      const file = path.join(projDir, "work", `${slug}.md`);
      const doc = await withLock(file, async () => {
        const next = applyOutcome(parseThread(await readText(file)), { thread: slug!, project: proj.name, client, rootTask }, e);
        await writeText(file, renderThread(next));
        return next;
      });
      line = `${doc.meta.status} · ${oneLine(e.kind)}: ${oneLine(e.summary || e.title).slice(0, 160)}${doc.meta.prs.length ? ` · ${doc.meta.prs[doc.meta.prs.length - 1]}` : ""} (${doc.meta.updated})`;
    }
    const stamp = localStamp(e.at);
    const event = `${stamp.date} ${stamp.time} ${e.kind} (${e.outcome}): ${oneLine(e.title).slice(0, 120)}${slug ? ` → [[work/${slug}]]` : ""}`;
    const pmFile = path.join(projDir, "memory.md");
    await withLock(pmFile, async () => {
      const pm = applyProjectEvent(parseProjectMemory(await readText(pmFile)), slug, line, event);
      await writeText(pmFile, renderProjectMemory(proj.name, pm));
    });
    if (client) await writeClientMemory(proj.clientId!, client).catch(() => {});
    // Keep the human-readable daily project log in step (it's what the owner browses). Skipped under
    // a test root so tests never write into the real vault.
    if (!rootOverride) try {
      const { appendProjectLog } = await import("@/lib/persistence/obsidian");
      await appendProjectLog(proj as never, { kind: e.kind, text: `**${oneLine(e.title)}** — ${e.outcome}${e.summary ? `\n\n${cap(e.summary, 600)}` : ""}` });
    } catch { /* optional */ }
    return { ok: true, thread: slug ?? undefined };
  } catch {
    return { ok: false };
  }
}

/** Clients/<client>/_client.md — who they are plus where things stand across their projects. */
export async function writeClientMemory(clientId: string, name: string): Promise<void> {
  const root = agenticRoot();
  if (!root) return;
  const { store } = await import("@/lib/persistence/store");
  const client = await store.clients.get(clientId).catch(() => null);
  const projects = await store.projects.find((p) => p.clientId === clientId).catch(() => []);
  const rows: string[] = [];
  for (const p of projects) {
    const pm = parseProjectMemory(await readText(path.join(root, "Projects", slugify(p.name), "memory.md")));
    const live = Object.entries(pm.threads).slice(-5).map(([s, l]) => `  - [[Projects/${slugify(p.name)}/work/${s}|${s.replace(/-[0-9a-f]{8}$/, "")}]] — ${l}`);
    rows.push(`- **[[Projects/${slugify(p.name)}/_project|${p.name}]]** (${p.status}) — [[Projects/${slugify(p.name)}/memory|memory]]${live.length ? `\n${live.join("\n")}` : ""}`);
  }
  // The full client profile (phone, title, address, tags, notes — same renderer as writeClientNote) so
  // this rewrite never erases fields that note owns; only the status section is ours.
  const { renderClientProfile, CLIENT_STATUS_START, CLIENT_STATUS_END } = await import("@/lib/persistence/obsidian");
  const profile = client
    ? renderClientProfile(client)
    : `---\ntags: [client, agentic-os]\nid: ${clientId}\n---\n\n# ${name}\n\n`;
  const md = profile + `\n${CLIENT_STATUS_START}\n## Where things stand\n${rows.join("\n") || "_No projects yet._"}\n${CLIENT_STATUS_END}\n\n*Updated ${localStamp().date} ${localStamp().time}*\n`;
  const file = path.join(root, "Clients", slugify(name), "_client.md");
  await withLock(file, () => writeText(file, md));
}

// ── Read before acting ──────────────────────────────────────────────────────────────────────────

const RECALL_MAX = 6000;
/**
 * What happened before, for a prompt: this thread's "Where it stands" + its last ~8 history entries,
 * sibling threads that touched the same PR/ticket, then the project's "Where it stands". Bounded to
 * ~6k chars. "" when memory is empty or unavailable.
 */
export async function recallFor(opts: { project: { name: string } | null | undefined; task?: TaskLike | null; prUrl?: string; ticketId?: string; maxChars?: number }): Promise<string> {
  try {
    const root = agenticRoot();
    if (!root || !opts.project) return "";
    const max = opts.maxChars ?? RECALL_MAX;
    const projDir = path.join(root, "Projects", slugify(opts.project.name));
    const parts: string[] = [];
    let mySlug: string | null = null;
    if (opts.task) {
      const rootTask = await rootTaskOf(opts.task);
      mySlug = threadSlug(rootTask);
      const doc = parseThread(await readText(path.join(projDir, "work", `${mySlug}.md`)));
      if (doc) parts.push(`### This piece of work: ${doc.title}\n${doc.whereItStands}\n\nHistory (oldest → newest):\n${doc.history.slice(-8).join("\n\n")}`);
    }
    const pr = opts.prUrl ?? opts.task?.prUrl;
    if (pr || opts.ticketId) {
      let files: string[] = [];
      try { files = (await fs.readdir(path.join(projDir, "work"))).filter((f) => f.endsWith(".md")); } catch { /* none */ }
      for (const f of files) {
        if (mySlug && f === `${mySlug}.md`) continue;
        const doc = parseThread(await readText(path.join(projDir, "work", f)));
        if (!doc) continue;
        if ((pr && doc.meta.prs.includes(pr)) || (opts.ticketId && doc.meta.tickets.includes(opts.ticketId))) {
          parts.push(`### Related work on the same ${pr && doc.meta.prs.includes(pr) ? "pull request" : "ticket"}: ${doc.title}\n${doc.whereItStands}\n${doc.history.slice(-3).join("\n\n")}`);
        }
      }
    }
    const pmMd = await readText(path.join(projDir, "memory.md"));
    if (pmMd) {
      const pm = parseProjectMemory(pmMd);
      const rows = Object.entries(pm.threads).filter(([s]) => s !== mySlug).slice(-10).map(([s, l]) => `- ${s.replace(/-[0-9a-f]{8}$/, "")}: ${l}`);
      if (rows.length) parts.push(`### Other work on ${opts.project.name}\n${rows.join("\n")}`);
    }
    if (!parts.length) return "";
    let out = parts.join("\n\n");
    if (out.length > max) out = out.slice(0, max - 20) + "\n…(truncated)";
    return out;
  } catch {
    return "";
  }
}

/** Open PRs recorded on this task's thread (newest last) — so follow-up work reuses them. */
export async function threadPrs(project: { name: string } | null | undefined, task: TaskLike): Promise<string[]> {
  try {
    const root = agenticRoot();
    if (!root || !project) return [];
    const rootTask = await rootTaskOf(task);
    const doc = parseThread(await readText(path.join(root, "Projects", slugify(project.name), "work", `${threadSlug(rootTask)}.md`)));
    return doc?.meta.prs ?? [];
  } catch {
    return [];
  }
}

/** Project-level "Where it stands" only (owner chat, client replies, planning). */
export async function projectMemoryBlock(project: { name: string } | null | undefined, maxChars = 2500): Promise<string> {
  try {
    const root = agenticRoot();
    if (!root || !project) return "";
    const pm = parseProjectMemory(await readText(path.join(root, "Projects", slugify(project.name), "memory.md")));
    const rows = Object.entries(pm.threads).slice(-12).map(([s, l]) => `- ${s.replace(/-[0-9a-f]{8}$/, "")}: ${l}`);
    const recent = pm.events.slice(-6).map((e) => `- ${e}`);
    if (!rows.length && !recent.length) return "";
    return `### ${project.name} — where it stands (from memory)\n${rows.join("\n")}${recent.length ? `\nRecent:\n${recent.join("\n")}` : ""}`.slice(0, maxChars);
  } catch {
    return "";
  }
}

/** Pick the projects a message is about: an explicit id wins, else projects whose name appears in the text. */
export function projectsMentioned<P extends { id: string; name: string }>(text: string, projects: P[], projectId?: string, max = 2): P[] {
  if (projectId) return projects.filter((p) => p.id === projectId).slice(0, 1);
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return projects
    .filter((p) => {
      const name = p.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      return name.length >= 3 && hay.includes(` ${name} `);
    })
    .slice(0, max);
}

/**
 * Read-before-act for conversational paths (owner chat, planner, client replies): the vault's
 * "where it stands" for the project(s) in play, framed so the model treats it as its own notes.
 */
/** The coarse, client-safe word for a thread status: never failures, costs, errors or links. Pure. */
export function clientSafeStatus(status: string): string {
  const s = status.toLowerCase();
  if (s.startsWith("live")) return "live";
  if (s.startsWith("merged")) return "finished, going live";
  if (s.startsWith("waiting")) return "waiting on a reply";
  if (s.startsWith("declined")) return "not being done";
  return "in progress"; // in progress, failed, blocked, stuck — the client only needs to know it's being worked on
}

/** Client-facing projection of project memory: counts of work by coarse status only. Thread names
 *  come from internal task titles, so they are never shown to a client. Pure. */
export function clientSafeProjectMemory(projectName: string, pm: ProjectMemory, max = 8): string {
  const counts = new Map<string, number>();
  for (const line of Object.values(pm.threads).slice(-max)) {
    const status = clientSafeStatus(line.split(" · ")[0] ?? "");
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const rows = [...counts.entries()].map(([status, n]) => `- ${n} piece${n === 1 ? "" : "s"} of work ${status}`);
  return rows.length ? `${projectName}:\n${rows.join("\n")}` : "";
}

export async function memoryForMessage(text: string, opts: { projectId?: string; projectIds?: string[]; maxChars?: number; audience?: "internal" | "client" } = {}): Promise<string> {
  try {
    const root = agenticRoot();
    if (!root) return "";
    if (opts.audience === "client" && opts.projectIds === undefined) return ""; // client memory needs an allowlist
    const { store } = await import("@/lib/persistence/store");
    const all = await store.projects.all();
    let picked: typeof all;
    if (opts.projectIds !== undefined) {
      // Any defined list is an allowlist, including an empty one (a client with no permitted
      // projects sees no project memory). Restrict to the permitted projects FIRST, then prefer the ones the message names; only when
      // none is named fall back to the two most recently updated (never a store-order accident).
      const permitted = all.filter((p) => opts.projectIds!.includes(p.id));
      const named = projectsMentioned(text, permitted);
      picked = named.length ? named : [...permitted].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))).slice(0, 2);
    } else {
      picked = projectsMentioned(text, all, opts.projectId);
    }
    if (!picked.length) return "";
    const max = opts.maxChars ?? 3500;
    if (opts.audience === "client") {
      const blocks = (await Promise.all(picked.map(async (p) =>
        clientSafeProjectMemory(p.name, parseProjectMemory(await readText(path.join(root, "Projects", slugify(p.name), "memory.md"))))))).filter(Boolean);
      if (!blocks.length) return "";
      return `\n\nWhere this client's work stands (your notes; status words only — share naturally, never quote internal details):\n${blocks.join("\n\n").slice(0, max)}\n`;
    }
    const blocks = (await Promise.all(picked.map((p) => projectMemoryBlock(p, Math.floor(max / picked.length))))).filter(Boolean);
    if (!blocks.length) return "";
    return `\n\nYour own notes on what was already done and where things were left off (vault memory — trust it over guesses, but the board and GitHub are the live truth):\n${blocks.join("\n\n")}\n`;
  } catch {
    return "";
  }
}
