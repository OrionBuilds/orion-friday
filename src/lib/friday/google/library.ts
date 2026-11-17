// FRIDAY client document library — the folder tree in the FRIDAY Google Shared Drive where all
// client-facing deliverables live:  FRIDAY / <Client Business Name> / <Project Name> / <category>.
//
// The Shared Drive itself is "FRIDAY" (its id is the top parent), so client folders are created
// directly under it. Under each project we pre-create the full set of deliverable-type subfolders so
// the library structure is consistent and browsable even before anything is filed.
//
// Folder ids are cached on the Client/Project records (driveFolderId) to avoid re-resolving. Every
// call is best-effort and no-ops when Google isn't connected — a Drive hiccup never breaks a run.

import { ensureFolder, uploadBinaryFile, type DriveFile } from "./drive";
import { googleConfigured } from "./auth";
import type { Client, Project, AgentRole } from "@/lib/friday/types";
import { getOwnerProfile } from "@autom8ionlab/agent-core";

// The FRIDAY Shared Drive id (env-overridable). The drive is named "FRIDAY"; its id IS the top parent.
// Env override first, then the git-ignored owner profile — the real drive id never lives in source.
export const FRIDAY_DRIVE_ID = process.env.FRIDAY_DRIVE_ID?.trim() || getOwnerProfile().drives?.fridayDriveId || "";

// The deliverable-type subfolders created under EVERY project.
export const CATEGORY_FOLDERS = [
  "SEO Audits", "QA Reports", "Bug Reports", "Code Reviews", "Research", "Proposals & SOWs", "Meeting Notes", "General",
  // Owner copies of every run's output (2026-09-24, driveDeliverables.ts): coding roles' change
  // summaries and the run reports of everything else. Never shared with the client from here.
  "Change Summaries", "Run Reports",
] as const;
export type Category = (typeof CATEGORY_FOLDERS)[number];

// Which subfolder a finished deliverable is filed into, by the producing agent's role.
const ROLE_CATEGORY: Partial<Record<AgentRole, Category>> = {
  seo: "SEO Audits",
  qa: "QA Reports",
  debug: "Bug Reports",
  review: "Code Reviews",
  "research-qa": "Research",
};
export function categoryForRole(role: AgentRole): Category {
  return ROLE_CATEGORY[role] ?? "General";
}

// The client's folder name = its business/company name, falling back to the contact name.
export function clientFolderName(client: Pick<Client, "name" | "company">): string {
  return (client.company?.trim() || client.name || "Client").trim();
}

// Find-or-create the client's top-level library folder under the FRIDAY shared drive. Caches the id
// on the client record so later lookups are a no-op. Returns the folder id (or null if unavailable).
export async function ensureClientLibrary(client: Client): Promise<string | null> {
  if (!googleConfigured()) return null;
  if (client.driveFolderId) return client.driveFolderId;
  try {
    const folder = await ensureFolder(clientFolderName(client), FRIDAY_DRIVE_ID, FRIDAY_DRIVE_ID);
    if (!folder) return null;
    const { updateClient } = await import("@/lib/friday/repo");
    await updateClient(client.id, { driveFolderId: folder.id }).catch(() => {});
    return folder.id;
  } catch { return null; }
}

// Ensure the full tree for a project: client folder → project folder → all category subfolders.
// Caches the project folder id. Returns the project folder id (or null).
export async function ensureProjectLibrary(client: Client, project: Project): Promise<string | null> {
  if (!googleConfigured()) return null;
  // Folder lives in SharePoint/OneDrive (set in the OS): no Google library for this project.
  if (project.filesProvider === "microsoft") return null;
  try {
    const clientFolderId = await ensureClientLibrary(client);
    if (!clientFolderId) return null;
    const projectFolder = project.driveFolderId
      ? { id: project.driveFolderId }
      : await ensureFolder(project.name, clientFolderId, FRIDAY_DRIVE_ID);
    if (!projectFolder?.id) return null;
    if (!project.driveFolderId) {
      const { updateProject } = await import("@/lib/friday/repo");
      await updateProject(project.id, { driveFolderId: projectFolder.id }).catch(() => {});
    }
    // Pre-create every category subfolder (idempotent find-or-create).
    for (const cat of CATEGORY_FOLDERS) {
      await ensureFolder(cat, projectFolder.id, FRIDAY_DRIVE_ID);
    }
    return projectFolder.id;
  } catch { return null; }
}

// Ensure (lazily) that a single category subfolder exists for a project, and return its id. Used at
// filing time so a deliverable always lands even if provisioning was skipped/failed earlier.
export async function ensureCategoryFolder(client: Client, project: Project, category: Category): Promise<string | null> {
  if (!googleConfigured()) return null;
  try {
    const projectFolderId = await ensureProjectLibrary(client, project);
    if (!projectFolderId) return null;
    const cat = await ensureFolder(category, projectFolderId, FRIDAY_DRIVE_ID);
    return cat?.id ?? null;
  } catch { return null; }
}

// Upload a finished deliverable (bytes) into the right category subfolder. Returns the DriveFile
// (with webViewLink) or null.
export async function fileDeliverable(
  client: Client, project: Project, category: Category,
  file: { name: string; bytes: Buffer; mime: string },
): Promise<DriveFile | null> {
  if (!googleConfigured()) return null;
  try {
    const folderId = await ensureCategoryFolder(client, project, category);
    if (!folderId) return null;
    return await uploadBinaryFile(file.name, file.bytes, folderId, file.mime);
  } catch { return null; }
}

// The Project folder id for a project (ensuring the tree exists) — used to move a Google Doc into a
// specific category subfolder from the orchestrator.
export async function ensureProjectCategoryFolderId(client: Client, project: Project, category: Category): Promise<string | null> {
  return ensureCategoryFolder(client, project, category);
}

// Backfill: provision the library tree for every existing client + project. Idempotent + sequential
// (kind to Drive rate limits). Returns counts.
export async function provisionAllLibraries(): Promise<{ clients: number; projects: number; ok: boolean; error?: string }> {
  if (!googleConfigured()) return { clients: 0, projects: 0, ok: false, error: "Google not connected" };
  const { store } = await import("@/lib/persistence/store");
  let clientsDone = 0, projectsDone = 0;
  try {
    const clients = await store.clients.all();
    const projects = await store.projects.all();
    const byId = new Map(clients.map((c) => [c.id, c]));
    for (const c of clients) {
      const id = await ensureClientLibrary(c);
      if (id) clientsDone++;
    }
    for (const p of projects) {
      if (p.status === "archived") continue;
      const c = byId.get(p.clientId);
      if (!c) continue;
      // Re-read the client so the just-cached driveFolderId is used.
      const fresh = (await store.clients.get(c.id)) ?? c;
      const id = await ensureProjectLibrary(fresh, p);
      if (id) projectsDone++;
    }
    return { clients: clientsDone, projects: projectsDone, ok: true };
  } catch (e) {
    return { clients: clientsDone, projects: projectsDone, ok: false, error: String(e) };
  }
}
