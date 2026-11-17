// FRIDAY repository — the one place client/project/task writes go through.
// Dual-writes to the local store + the Obsidian mirror, and emits orchestration logs.
// API routes and the orchestrator call these instead of touching the store directly.

import path from "node:path";
import { store, newId, nowISO, logEvent } from "@/lib/persistence/store";
import {
  writeClientNote, writeProjectNote, appendProjectLog, appendFridayLog,
} from "@/lib/persistence/obsidian";
import type { Client, ClientDoc, Project, Task, TaskStatus, Risk, Channel, RequestOrigin } from "@/lib/friday/types";
import { DEFAULT_STAGE } from "@/lib/friday/stages";
import { localProjectRepos, CONNECTION_KEYS } from "@/lib/friday/types";

// ── Clients ──────────────────────────────────────────────────────────────
export async function createClient(input: {
  name: string; company?: string; email?: string; phone?: string;
  jobTitle?: string; addressLine?: string; city?: string; state?: string; postalCode?: string;
  status?: Client["status"]; notes?: string; tags?: string[];
}, opts?: {
  // Owner rule 2026-07-19: welcomes fire ONLY when the new-client form's checkbox says so — a
  // brand-new client gets one, an imported existing relationship doesn't. Approve-to-send always.
  queueWelcome?: boolean;
}): Promise<Client> {
  const now = nowISO();
  const client: Client = {
    id: newId(),
    name: input.name.trim(),
    company: input.company?.trim(),
    email: input.email?.trim(),
    phone: input.phone?.trim(),
    jobTitle: input.jobTitle?.trim(),
    addressLine: input.addressLine?.trim(),
    city: input.city?.trim(),
    state: input.state?.trim(),
    postalCode: input.postalCode?.trim(),
    status: input.status ?? "active",
    notes: input.notes,
    tags: input.tags,
    createdAt: now,
    updatedAt: now,
  };
  await store.clients.insert(client);
  await writeClientNote(client);
  await logEvent("client.create", { id: client.id, name: client.name });
  // M1: clients live in OS contacts — push the new record up (best-effort; the sync
  // engine reconciles on the next refresh if the OS is unreachable right now).
  void import("@/lib/friday/contactsBridge").then((m) => m.pushClientCreate(client)).catch(() => {});
  // Provision the client's Google Drive doc library (best-effort, non-blocking).
  void import("@/lib/friday/google/library").then((m) => m.ensureClientLibrary(client)).catch(() => {});
  // Welcome email — checkbox-gated, parked in approve-to-send (never sends on its own). Best-effort:
  // a draft/queue failure must never fail client creation.
  if (opts?.queueWelcome && client.email) {
    void import("@/lib/friday/onboarding")
      .then((m) => m.queueWelcomeEmail(client.id))
      .catch((e) => logEvent("welcome.error", { clientId: client.id, error: String(e).slice(0, 160) }, { level: "warn" }));
  }
  return client;
}

export async function updateClient(id: string, patch: Partial<Client>): Promise<Client | null> {
  const client = await store.clients.update(id, { ...patch, updatedAt: nowISO() });
  if (client) {
    await writeClientNote(client);
    // M1: mirror the change into OS contacts / contact_agent_meta (best-effort).
    void import("@/lib/friday/contactsBridge").then((m) => m.pushClientUpdate(client, patch)).catch(() => {});
  }
  return client;
}

export async function listClients(): Promise<Client[]> {
  // M1: reads serve from the local mirror (zero latency); kick a TTL-gated OS refresh in the
  // background so the mirror stays current even when the scheduler isn't running.
  void import("@/lib/friday/contactsBridge").then((m) => m.refreshContacts()).catch(() => {});
  return store.clients.all();
}

// Delete a client AND cascade-delete its projects (each of which removes its tasks + runs) and its
// uploaded documents (record + on-disk file + memory chunks + Drive copies). This is destructive —
// the caller should confirm the counts first. Only FRIDAY records are removed; external
// GitHub/Supabase/Netlify resources are untouched.
export async function deleteClient(id: string): Promise<{ ok: boolean; projects: number; tasks: number; runs: number }> {
  const client = await store.clients.get(id);
  if (!client) return { ok: false, projects: 0, tasks: 0, runs: 0 };
  const projects = await store.projects.find((p) => p.clientId === id);
  let tasks = 0, runs = 0;
  for (const p of projects) { const r = await deleteProject(p.id); tasks += r.tasks; runs += r.runs; }
  for (const d of await store.docs.find((doc) => doc.clientId === id)) await deleteDoc(d.id).catch(() => {});
  try {
    const { DOCS_ROOT } = await import("@/lib/friday/docs/storage");
    const { promises: fs } = await import("node:fs");
    await fs.rm(path.join(DOCS_ROOT, id), { recursive: true, force: true });
  } catch { /* best-effort */ }
  const ok = await store.clients.remove(id);
  // M1: mark archived for FRIDAY in contact_agent_meta so the sync doesn't resurrect the row.
  // The OS contact itself is untouched — it may be shared with other agents or the CRM.
  void import("@/lib/friday/contactsBridge").then((m) => m.pushClientArchive(client)).catch(() => {});
  await logEvent("client.deleted", { clientId: id, name: client.name, projects: projects.length, tasks, runs }, { level: "warn" });
  return { ok, projects: projects.length, tasks, runs };
}

// ── Client documents (owner-uploaded context — proposals, plans, strategy docs) ──────────────
export async function createDoc(input: {
  id?: string; clientId: string; filename: string; kind: ClientDoc["kind"]; mime: string;
  sizeBytes: number; path: string; category?: ClientDoc["category"];
  extractedText: string; extractedChars: number;
  driveFileId?: string; driveUrl?: string; driveModifiedTime?: string;
  source: ClientDoc["source"]; status?: ClientDoc["status"]; error?: string;
}): Promise<ClientDoc> {
  const now = nowISO();
  const doc: ClientDoc = {
    id: input.id ?? newId(),
    clientId: input.clientId,
    filename: input.filename,
    kind: input.kind,
    mime: input.mime,
    sizeBytes: input.sizeBytes,
    path: input.path,
    category: input.category ?? "other",
    extractedText: input.extractedText,
    extractedChars: input.extractedChars,
    driveFileId: input.driveFileId,
    driveUrl: input.driveUrl,
    driveModifiedTime: input.driveModifiedTime,
    source: input.source,
    status: input.status ?? "ready",
    error: input.error,
    uploadedAt: now,
    updatedAt: now,
  };
  await store.docs.insert(doc);
  await logEvent("doc.create", { id: doc.id, clientId: doc.clientId, filename: doc.filename, category: doc.category, source: doc.source });
  return doc;
}

export async function getDoc(id: string): Promise<ClientDoc | null> {
  return store.docs.get(id);
}

export async function listDocsForClient(clientId: string): Promise<ClientDoc[]> {
  const docs = await store.docs.find((d) => d.clientId === clientId);
  return docs.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
}

export async function updateDoc(id: string, patch: Partial<ClientDoc>): Promise<ClientDoc | null> {
  return store.docs.update(id, { ...patch, updatedAt: nowISO() });
}

// Full cleanup: memory chunks first (must happen even if later steps fail), then disk, record, Drive.
export async function deleteDoc(id: string): Promise<boolean> {
  const doc = await store.docs.get(id);
  if (!doc) return false;
  try {
    const { removeMemory } = await import("@/lib/friday/memory");
    await removeMemory(`doc:${id}#`);
  } catch { /* best-effort */ }
  try {
    const { promises: fs } = await import("node:fs");
    await fs.rm(doc.path, { force: true });
  } catch { /* best-effort */ }
  const ok = await store.docs.remove(id);
  try {
    const { trashFile } = await import("@/lib/friday/google/drive");
    if (doc.driveFileId) await trashFile(doc.driveFileId);
    if (doc.driveBriefFileId) await trashFile(doc.driveBriefFileId);
  } catch { /* best-effort */ }
  await logEvent("doc.delete", { id, clientId: doc.clientId, filename: doc.filename });
  return ok;
}

// ── Fuzzy name matching ────────────────────────────────────────────────────
// So a loosely-worded request resolves to an existing record instead of duplicating it:
// "casey client's" → client "Casey Client", "coach tool" → project "AI Coach Tool". Shared by the
// orchestrator, meeting ingest, and the client SMS/voice channel.
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
// Higher = better match. 0 = no match. Exact > substring (either direction) > token-overlap.
function nameScore(candidate: string, query: string): number {
  const c = norm(candidate), q = norm(query);
  if (!c || !q) return 0;
  if (c === q) return 100;
  if (q.length < 3) return 0; // too short to fuzzy-match safely
  if (c.includes(q) || q.includes(c)) return 80 - Math.abs(c.length - q.length);
  const cts = new Set(c.split(" "));
  const qts = q.split(" ").filter((t) => t.length >= 2);
  const hit = qts.filter((t) => cts.has(t)).length;
  const frac = qts.length ? hit / qts.length : 0;
  return frac >= 0.6 ? 40 + hit * 5 : 0; // most of the query's words must appear
}
function bestByName<T extends { name: string }>(rows: T[], name: string): T | null {
  let best: T | null = null, bestScore = 0;
  for (const r of rows) { const s = nameScore(r.name, name); if (s > bestScore) { bestScore = s; best = r; } }
  return bestScore > 0 ? best : null;
}
export function matchClient(clients: Client[], name: string): Client | null {
  return bestByName(clients, name);
}
// Pass the candidate list already scoped to a client where possible.
export function matchProject(projects: Project[], name: string): Project | null {
  return bestByName(projects, name);
}
// Fuzzy-match a task by its title (so "the QA task" resolves to a real task). Scores on `title`.
export function matchTask(tasks: Task[], query: string): Task | null {
  return bestByName(tasks.map((t) => ({ ...t, name: t.title })), query) as Task | null;
}

// ── Projects ─────────────────────────────────────────────────────────────
export async function createProject(input: {
  clientId: string; name: string; description?: string; stack?: string;
  startDate?: string; targetEndDate?: string; budget?: number;
  repoUrl?: string; repoUrls?: string[]; deployUrl?: string; supabaseRef?: string;
}): Promise<Project> {
  const now = nowISO();
  const repoUrls = input.repoUrls?.length ? input.repoUrls : input.repoUrl ? [input.repoUrl] : undefined;
  const project: Project = {
    id: newId(),
    clientId: input.clientId,
    name: input.name.trim(),
    description: input.description,
    status: "active",
    startDate: input.startDate,
    targetEndDate: input.targetEndDate,
    budget: typeof input.budget === "number" && !Number.isNaN(input.budget) ? input.budget : undefined,
    stack: input.stack,
    repoUrls,
    repoUrl: repoUrls?.[0], // legacy mirror = first repo
    deployUrl: input.deployUrl,
    supabaseRef: input.supabaseRef,
    createdAt: now,
    updatedAt: now,
  };
  await store.projects.insert(project);
  const client = await store.clients.get(project.clientId);
  await writeProjectNote(project, client, []);
  await appendFridayLog({ kind: "note", text: `Created project **${project.name}**${client ? ` for ${client.name}` : ""}.` });
  await logEvent("project.create", { id: project.id, name: project.name });
  // Provision the project's Google Drive folder tree (client → project → category subfolders). Best-effort.
  if (client) void import("@/lib/friday/google/library").then((m) => m.ensureProjectLibrary(client, project)).catch(() => {});
  return project;
}

export async function updateProject(id: string, patch: Partial<Project>): Promise<Project | null> {
  // A change to a repo / site / Supabase ref / files folder is stamped so connectionsSync pushes it
  // to the OS (the newer side wins there).
  const before = patch.connectionsUpdatedAt === undefined && CONNECTION_KEYS.some((k) => k in patch)
    ? await store.projects.get(id)
    : null;
  const touches = before && CONNECTION_KEYS.some((k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(before[k]));
  const project = await store.projects.update(id, { ...patch, ...(touches ? { connectionsUpdatedAt: nowISO() } : {}), updatedAt: nowISO() });
  if (project) {
    const client = await store.clients.get(project.clientId);
    const tasks = await store.tasks.find((t) => t.projectId === project.id);
    await writeProjectNote(project, client, tasks);
  }
  return project;
}

// Attach a repo to a project (append, case-insensitive dedup). Keeps repoUrl mirrored to [0].
export async function addProjectRepo(id: string, url: string): Promise<Project | null> {
  const p = await store.projects.get(id);
  if (!p) return null;
  const u = url.trim();
  // Local list only — the OS repo_url / normalised URLs projectRepos() adds must not be persisted locally.
  const list = localProjectRepos(p);
  if (!u || list.some((x) => x.toLowerCase() === u.toLowerCase())) return p; // no-op on empty/dupe
  const next = [...list, u];
  return updateProject(id, { repoUrls: next, repoUrl: next[0] });
}

// Detach a repo from a project. Clears the legacy mirror when the last one is removed.
export async function removeProjectRepo(id: string, url: string): Promise<Project | null> {
  const p = await store.projects.get(id);
  if (!p) return null;
  const next = localProjectRepos(p).filter((x) => x.toLowerCase() !== url.trim().toLowerCase());
  return updateProject(id, { repoUrls: next, repoUrl: next[0] });
}

export async function listProjects(clientId?: string): Promise<Project[]> {
  return clientId ? store.projects.find((p) => p.clientId === clientId) : store.projects.all();
}

// Delete a project and its dependent tasks + runs (so nothing is orphaned). Best-effort per row.
// Does NOT touch the client, the GitHub/Supabase/Netlify resources themselves, or any local folder —
// only FRIDAY's records. Returns how many tasks/runs were removed.
export async function deleteProject(id: string): Promise<{ ok: boolean; tasks: number; runs: number }> {
  const project = await store.projects.get(id);
  if (!project) return { ok: false, tasks: 0, runs: 0 };
  const tasks = await store.tasks.find((t) => t.projectId === id);
  const runs = await store.runs.find((r) => r.projectId === id);
  for (const t of tasks) await store.tasks.remove(t.id).catch(() => {});
  for (const r of runs) await store.runs.remove(r.id).catch(() => {});
  const ok = await store.projects.remove(id);
  await logEvent("project.deleted", { projectId: id, name: project.name, tasks: tasks.length, runs: runs.length }, { level: "warn" });
  return { ok, tasks: tasks.length, runs: runs.length };
}

export async function getProject(id: string): Promise<Project | null> {
  return store.projects.get(id);
}

// Re-mirror a project's board note (called after task changes).
async function refreshProjectNote(projectId: string): Promise<void> {
  const project = await store.projects.get(projectId);
  if (!project) return;
  const client = await store.clients.get(project.clientId);
  const tasks = await store.tasks.find((t) => t.projectId === projectId);
  await writeProjectNote(project, client, tasks);
}

// ── Tasks ────────────────────────────────────────────────────────────────
export async function createTask(input: {
  projectId: string; title: string; description?: string;
  status?: TaskStatus; assignee?: string; risk?: Risk;
  origin?: Channel; originContact?: string; sourceRunId?: string;
  requestedBy?: string; requesterClientId?: string; requestKind?: Task["requestKind"];
  requestId?: string; details?: string; executionPlan?: string;
  requestOrigin?: RequestOrigin;
  bypassAuthority?: boolean; sourceTaskId?: string; prUrl?: string; prHeadRef?: string;
}): Promise<Task> {
  const now = nowISO();
  const siblings = await store.tasks.find((t) => t.projectId === input.projectId && t.status === (input.status ?? DEFAULT_STAGE));
  const task: Task = {
    id: newId(),
    projectId: input.projectId,
    title: input.title.trim(),
    description: input.description,
    status: input.status ?? DEFAULT_STAGE,
    assignee: input.assignee ?? "human",
    risk: input.risk ?? "low",
    order: siblings.length,
    origin: input.origin ?? "web",
    originContact: input.originContact,
    sourceRunId: input.sourceRunId,
    requestedBy: input.requestedBy,
    requesterClientId: input.requesterClientId,
    requestKind: input.requestKind,
    requestId: input.requestId,
    requestOrigin: input.requestOrigin,
    bypassAuthority: input.bypassAuthority,
    sourceTaskId: input.sourceTaskId,
    prUrl: input.prUrl,
    prHeadRef: input.prHeadRef,
    details: input.details,
    executionPlan: input.executionPlan,
    createdAt: now,
    updatedAt: now,
  };
  await store.tasks.insert(task);
  await refreshProjectNote(task.projectId);
  await logEvent("task.create", { id: task.id, title: task.title, projectId: task.projectId });
  return task;
}

export async function updateTask(id: string, patch: Partial<Task>): Promise<Task | null> {
  const before = await store.tasks.get(id);
  const task = await store.tasks.update(id, { ...patch, updatedAt: nowISO() });
  if (task) {
    await refreshProjectNote(task.projectId);
    if (before && patch.status && patch.status !== before.status) {
      const project = await store.projects.get(task.projectId);
      if (project) {
        await appendProjectLog(project, { kind: "task", text: `**${task.title}** → \`${patch.status}\`` });
      }
      await logEvent("task.move", { id: task.id, from: before.status, to: patch.status });
      // Closed-loop notices (see deliveryNotifyRules.ts): fire ONCE on the task's first entry into a
      // closed stage — `completed` (what the PR shepherd sets on merge) or `delivered` — never again on
      // completed → delivered. A bug linked to a portal ticket/CR gets only its portal comment (no
      // duplicate email draft); a bug without one gets the all-clear draft.
      const { deliveryNotifyPlan } = await import("@/lib/friday/deliveryNotifyRules");
      const plan = deliveryNotifyPlan(before.status, task);
      if (plan.bugResolved) {
        const { notifyClientBugResolved } = await import("@/lib/friday/clientNotify");
        notifyClientBugResolved(task).catch(() => {});
      }
      // Done (non-bug) → nudge the owner to tell the client (owner stays in control of the send).
      if (plan.ownerNudge) {
        const client = project ? await store.clients.get(project.clientId) : null;
        const { notifyOwner } = await import("@/lib/friday/notify");
        notifyOwner({
          kind: "delivered", priority: "low",
          text: `🎯 "${task.title.slice(0, 50)}" delivered${client ? ` for ${client.name}` : ""} — reply "tell ${client?.name?.split(" ")[0] || "the client"} it's ready" to notify them.`,
          dedupeKey: `delivered:${task.id}`,
        }).catch(() => {});
      }
      // Close the loop with the CLIENT too (owner ask 2026-07-19) — but only for work a client
      // actually requested that ISN'T owned by a review Request (those go through the portal review)
      // or a portal ticket/CR (its portal reply is the notice). Drafted note parked in approve-to-send.
      if (plan.workDelivered) {
        const { notifyClientWorkDelivered } = await import("@/lib/friday/clientNotify");
        notifyClientWorkDelivered(task).catch(() => {});
      }
    }
  }
  return task;
}

export async function listTasks(projectId: string): Promise<Task[]> {
  const tasks = await store.tasks.find((t) => t.projectId === projectId);
  return tasks.sort((a, b) => a.order - b.order);
}

export async function deleteTask(id: string): Promise<boolean> {
  const task = await store.tasks.get(id);
  const ok = await store.tasks.remove(id);
  if (ok && task) await refreshProjectNote(task.projectId);
  return ok;
}
