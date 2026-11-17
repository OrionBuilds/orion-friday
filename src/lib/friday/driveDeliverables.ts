// FRIDAY — file every run report as a Google Drive document (owner rule 2026-09-24).
//
// "Full report in the app" is gone. A finished run's artifacts (PDF reports, markdown change
// summaries, CSVs) and — when nothing else carries the narrative — the run's own result are
// uploaded into the project's Drive library so the brief item and any email can link to them:
//   .pdf → Drive PDF · .md → Google Doc (markdown → HTML → Drive import) · .csv → Google Sheet
//
// Where: the existing library tree (google/library.ts: <Client> / <Project> / <Category>) in the
// FRIDAY shared drive, cached on Project.driveFolderId. Coding roles file under "Change Summaries",
// everything else under "Run Reports" (or the role's own report category when it has one). When no
// shared drive is configured the same tree is built under My Drive: <agency> / Projects /
// <Project> / Reports.
//
// NEVER shared with the client here: this is the owner's copy (internal candor and all). Client
// delivery stays on the reviewed paths (clientReview / send_report). Everything is best-effort — a
// Drive hiccup degrades the brief item to text + PR link and logs drive.file.failed.

import { promises as fs } from "node:fs";
import path from "node:path";
import { markdownToBasicHtml } from "@autom8ionlab/agent-core";
import { logEvent } from "@/lib/persistence/store";
import { googleConfigured } from "@/lib/friday/google/auth";
import { createDriveFile, ensureFolder } from "@/lib/friday/google/drive";
import { categoryForRole, ensureCategoryFolder, FRIDAY_DRIVE_ID, type Category } from "@/lib/friday/google/library";
import { isAutoRoundTitle } from "@/lib/friday/notifyBack";
import type { Agent, AgentRun, Artifact, Client, Project, Task } from "@/lib/friday/types";
import { msFolderConfigured, uploadToProjectFolder } from "@/lib/friday/msProjectFiles";
import { AGENCY } from "@/lib/friday/persona";

export interface DriveLink { label: string; url: string }
export interface PublishResult { reportUrl?: string; links: DriveLink[]; filed: number }

const CODING_ROLES = new Set(["architect", "dev", "devops", "debug", "designer"]);
const ROLE_REPORT_CATEGORY: Partial<Record<string, Category>> = { seo: "SEO Audits", qa: "QA Reports", debug: "Bug Reports", review: "Code Reviews", "research-qa": "Research" };

/** Which Drive category a run's files belong in. Pure. */
export function categoryForRun(role: string): Category {
  if (ROLE_REPORT_CATEGORY[role]) return ROLE_REPORT_CATEGORY[role]!;
  if (CODING_ROLES.has(role)) return "Change Summaries";
  return categoryForRole(role as Agent["role"]) === "General" ? "Run Reports" : categoryForRole(role as Agent["role"]);
}

/** Drive target + source mime for a local artifact, by extension. Pure; null = don't upload. */
export function driveTargetFor(artifact: Pick<Artifact, "path" | "mime" | "kind">): { target: "doc" | "sheet" | "pdf"; sourceMime: string } | null {
  const ext = (artifact.path ? path.extname(artifact.path) : "").toLowerCase();
  if (ext === ".pdf" || artifact.mime === "application/pdf") return { target: "pdf", sourceMime: "application/pdf" };
  if (ext === ".md" || ext === ".markdown" || artifact.mime === "text/markdown") return { target: "doc", sourceMime: "text/html" };
  if (ext === ".csv" || artifact.mime === "text/csv") return { target: "sheet", sourceMime: "text/csv" };
  return null;
}

/** "<YYYY-MM-DD> <task title (60)> — <label>". Pure. */
export function driveFileName(taskTitle: string, label: string, at = new Date()): string {
  const day = at.toISOString().slice(0, 10);
  const title = taskTitle.replace(/\s+/g, " ").trim().slice(0, 60);
  const lab = label.replace(/\s+/g, " ").trim().slice(0, 60);
  return lab && lab !== title ? `${day} ${title} — ${lab}` : `${day} ${title}`;
}

/** Should the run's raw result become its own "Run report" Doc? Pure. */
export function wantsNarrativeDoc(input: { result: string; hasNarrative: boolean; taskTitle: string; finalRound?: boolean }): boolean {
  if (input.hasNarrative) return false;
  // Same floor the PDF path uses: anything shorter is a status line, not a report.
  if (input.result.trim().length < 40) return false;
  if (isAutoRoundTitle(input.taskTitle) && !input.finalRound) return false;
  return true;
}

// My Drive fallback: <agency> / Projects / <project> / Reports — cached on the project.
async function ensureMyDriveReports(project: Project): Promise<string | null> {
  if (project.driveFolderId) return project.driveFolderId;
  const root = await ensureFolder(AGENCY);
  const projects = root ? await ensureFolder("Projects", root.id) : null;
  const proj = projects ? await ensureFolder(project.name, projects.id) : null;
  const reports = proj ? await ensureFolder("Reports", proj.id) : null;
  if (!reports) return null;
  const { updateProject } = await import("@/lib/friday/repo");
  await updateProject(project.id, { driveFolderId: reports.id }).catch(() => {});
  return reports.id;
}

async function targetFolder(client: Client | null, project: Project | null, category: Category): Promise<string | undefined> {
  if (!project) return undefined;
  // The project's folder is in SharePoint/OneDrive (set in the OS): don't create a Google one, which
  // would also sync back and replace that choice.
  if (project.filesProvider === "microsoft") return undefined;
  if (FRIDAY_DRIVE_ID && client) return (await ensureCategoryFolder(client, project, category)) ?? undefined;
  return (await ensureMyDriveReports(project)) ?? undefined;
}

/**
 * Upload the run's artifacts (and, if needed, a narrative Doc) to Drive, mutating `artifacts` in
 * place so `url`/`driveFileId` are recorded on the run. Never throws.
 */
export async function publishRunToDrive(input: {
  run: AgentRun; task: Task; project: Project | null; client: Client | null; agent: Agent;
  artifacts: Artifact[]; result: string; finalRound?: boolean;
}): Promise<PublishResult> {
  // The project's folder is in SharePoint/OneDrive (set in the OS): file there, through Clara's account.
  if (msFolderConfigured(input.project)) return publishRunToMicrosoft({ ...input, project: input.project });
  const out: PublishResult = { links: [], filed: 0 };
  if (!googleConfigured()) return out;
  const category = categoryForRun(input.agent.role);
  let folderId: string | undefined;
  try { folderId = await targetFolder(input.client, input.project, category); } catch { folderId = undefined; }
  if (!folderId) {
    // No library folder → nothing is filed. Uploading without `parents` would drop the file in the
    // owner's My Drive root and still report it as filed; skip and say so instead.
    await logEvent("drive.file.failed", { runId: input.run.id, reason: input.project ? "folder-unresolved" : "no-project" }, { level: "warn" }).catch(() => {});
    return out;
  }
  const parents = [folderId];
  const now = new Date();

  let hasNarrative = false;
  for (const a of input.artifacts) {
    if (a.url || !a.path) continue;
    const spec = driveTargetFor(a);
    if (!spec) continue;
    try {
      const raw = await fs.readFile(a.path);
      const bytes = spec.target === "doc" ? Buffer.from(markdownToBasicHtml(raw.toString("utf8")), "utf8") : raw;
      const file = await createDriveFile({ name: driveFileName(input.task.title, a.label, now), parents, target: spec.target, sourceMime: spec.sourceMime, bytes });
      if (!file) { await logEvent("drive.file.failed", { runId: input.run.id, label: a.label, reason: "upload returned null" }, { level: "warn" }); continue; }
      a.url = file.webViewLink ?? a.url;
      a.driveFileId = file.id;
      out.filed++;
      // Only the markdown change summary carries the run's own narrative. The report PDF is built
      // from clientSafeText (internal findings stripped), so it must not suppress the owner's copy.
      if (a.kind === "summary") hasNarrative = true;
      const label = a.kind === "pdf" ? `${a.label} (Google Drive)` : spec.target === "doc" ? `${a.label} (Google Doc)` : spec.target === "sheet" ? `${a.label} (Google Sheet)` : a.label;
      if (a.url) { out.links.push({ label, url: a.url }); if (!out.reportUrl && (a.kind === "pdf" || a.kind === "summary")) out.reportUrl = a.url; }
    } catch (e) {
      await logEvent("drive.file.failed", { runId: input.run.id, label: a.label, error: String(e).slice(0, 200) }, { level: "warn" });
    }
  }

  if (wantsNarrativeDoc({ result: input.result, hasNarrative, taskTitle: input.task.title, finalRound: input.finalRound })) {
    try {
      const md = `# Run report — ${input.task.title}\n\n${input.result.trim()}\n`;
      const file = await createDriveFile({ name: driveFileName(input.task.title, "Run report", now), parents, target: "doc", sourceMime: "text/html", bytes: Buffer.from(markdownToBasicHtml(md), "utf8") });
      if (file?.webViewLink) {
        const { linkArtifact } = await import("@/lib/friday/artifacts");
        const art = linkArtifact("file", "Run report", file.webViewLink);
        art.driveFileId = file.id;
        input.artifacts.push(art);
        out.filed++;
        out.reportUrl = out.reportUrl ?? file.webViewLink;
        out.links.push({ label: "Report (Google Doc)", url: file.webViewLink });
      } else {
        await logEvent("drive.file.failed", { runId: input.run.id, label: "Run report", reason: "upload returned null" }, { level: "warn" });
      }
    } catch (e) {
      await logEvent("drive.file.failed", { runId: input.run.id, label: "Run report", error: String(e).slice(0, 200) }, { level: "warn" });
    }
  }
  if (out.filed) await logEvent("drive.file.published", { runId: input.run.id, filed: out.filed, category, reportUrl: out.reportUrl }, { runId: input.run.id, projectId: input.task.projectId });
  return out;
}

/** File extension for a run artifact going to SharePoint/OneDrive (uploaded as-is, no conversion). Pure. */
export function msExtensionFor(artifact: Pick<Artifact, "path" | "mime" | "kind">): string | null {
  const spec = driveTargetFor(artifact);
  if (!spec) return null;
  return spec.target === "pdf" ? ".pdf" : spec.target === "sheet" ? ".csv" : ".md";
}

/**
 * SharePoint/OneDrive twin of publishRunToDrive: same category folders and naming, files uploaded
 * as-is (PDF / Markdown / CSV open in Office online) through the OS project-files function. Never throws.
 */
async function publishRunToMicrosoft(input: {
  run: AgentRun; task: Task; project: Project; agent: Agent;
  artifacts: Artifact[]; result: string; finalRound?: boolean;
}): Promise<PublishResult> {
  const out: PublishResult = { links: [], filed: 0 };
  const category = categoryForRun(input.agent.role);
  const now = new Date();
  let hasNarrative = false;

  for (const a of input.artifacts) {
    if (a.url || !a.path) continue;
    const ext = msExtensionFor(a);
    if (!ext) continue;
    try {
      const bytes = await fs.readFile(a.path);
      const file = await uploadToProjectFolder(input.project, { category, fileName: driveFileName(input.task.title, a.label, now) + ext, bytes });
      a.url = file.url ?? a.url;
      a.driveFileId = file.id;
      out.filed++;
      if (a.kind === "summary") hasNarrative = true;
      if (a.url) {
        out.links.push({ label: `${a.label} (SharePoint)`, url: a.url });
        if (!out.reportUrl && (a.kind === "pdf" || a.kind === "summary")) out.reportUrl = a.url;
      }
    } catch (e) {
      await logEvent("drive.file.failed", { runId: input.run.id, label: a.label, provider: "microsoft", error: String(e).slice(0, 200) }, { level: "warn" }).catch(() => {});
    }
  }

  if (wantsNarrativeDoc({ result: input.result, hasNarrative, taskTitle: input.task.title, finalRound: input.finalRound })) {
    try {
      const md = `# Run report — ${input.task.title}\n\n${input.result.trim()}\n`;
      const file = await uploadToProjectFolder(input.project, { category, fileName: driveFileName(input.task.title, "Run report", now) + ".md", bytes: Buffer.from(md, "utf8") });
      if (file.url) {
        const { linkArtifact } = await import("@/lib/friday/artifacts");
        const art = linkArtifact("file", "Run report", file.url);
        art.driveFileId = file.id;
        input.artifacts.push(art);
        out.filed++;
        out.reportUrl = out.reportUrl ?? file.url;
        out.links.push({ label: "Report (SharePoint)", url: file.url });
      }
    } catch (e) {
      await logEvent("drive.file.failed", { runId: input.run.id, label: "Run report", provider: "microsoft", error: String(e).slice(0, 200) }, { level: "warn" }).catch(() => {});
    }
  }
  if (out.filed) await logEvent("drive.file.published", { runId: input.run.id, filed: out.filed, category, provider: "microsoft", reportUrl: out.reportUrl }, { runId: input.run.id, projectId: input.task.projectId }).catch(() => {});
  return out;
}
