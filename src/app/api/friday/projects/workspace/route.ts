import { NextResponse } from "next/server";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { getProject, updateProject, addProjectRepo, removeProjectRepo } from "@/lib/friday/repo";
import { createGithubRepo, createNetlifySite, createSupabaseProject, workspaceTokens, githubOwners } from "@/lib/friday/workspace";
import { isSelfSourceDir } from "@/lib/friday/delivery";
import { logEvent } from "@/lib/persistence/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GET → which providers can CREATE (have creds) + the GitHub owners you can create repos under.
export async function GET() {
  const [tokens, owners] = await Promise.all([
    Promise.resolve(workspaceTokens()),
    githubOwners().catch(() => [] as string[]),
  ]);
  return NextResponse.json({ tokens, owners });
}

// POST { projectId, provider: "github"|"netlify"|"supabase", action: "link"|"create"|"unlink", value?, private?, owner? }
// GitHub supports MULTIPLE repos per project (link/unlink append/remove); netlify & supabase are single-value.
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const projectId = String(b.projectId ?? "");
  const provider = b.provider as "github" | "netlify" | "supabase";
  const action = ["create", "unlink"].includes(b.action) ? (b.action as "create" | "unlink") : "link";
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

  // ── Local folder: agents run directly in a real on-disk directory (e.g. ~/projects/FRIDAY) ──
  if (b.provider === "local") {
    if (action === "unlink") {
      const updated = await updateProject(projectId, { workspaceDir: undefined });
      await logEvent("workspace.unlink", { provider: "local", projectId });
      return NextResponse.json({ ok: true, project: updated });
    }
    const value = String(b.value ?? "").trim();
    if (!value) return NextResponse.json({ error: "a folder path is required" }, { status: 400 });
    if (!path.isAbsolute(value)) return NextResponse.json({ error: "use an absolute path (e.g. /srv/friday)" }, { status: 400 });
    if (!existsSync(value)) return NextResponse.json({ error: `folder does not exist: ${value}` }, { status: 400 });
    try { if (!statSync(value).isDirectory()) return NextResponse.json({ error: "that path is a file, not a folder" }, { status: 400 }); }
    catch { return NextResponse.json({ error: "can't read that path" }, { status: 400 }); }
    const updated = await updateProject(projectId, { workspaceDir: value });
    await logEvent("workspace.link", { provider: "local", projectId, value });
    return NextResponse.json({ ok: true, project: updated, selfSource: isSelfSourceDir(value) });
  }

  // ── GitHub: multi-repo ──
  if (provider === "github") {
    if (action === "unlink") {
      const value = String(b.value ?? "").trim();
      if (!value) return NextResponse.json({ error: "value required to unlink" }, { status: 400 });
      const updated = await removeProjectRepo(projectId, value);
      await logEvent("workspace.unlink", { provider, projectId });
      return NextResponse.json({ ok: true, project: updated });
    }
    if (action === "link") {
      const value = String(b.value ?? "").trim();
      if (!value) return NextResponse.json({ error: "value required to link" }, { status: 400 });
      const updated = await addProjectRepo(projectId, value);
      await logEvent("workspace.link", { provider, projectId });
      return NextResponse.json({ ok: true, project: updated });
    }
    // create → make the repo (under the chosen owner), then attach it
    const res = await createGithubRepo(project.name, { private: b.private !== false, description: project.description, owner: b.owner ? String(b.owner) : undefined });
    if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 502 });
    const updated = res.url ? await addProjectRepo(projectId, res.url) : project;
    await logEvent("workspace.create", { provider, projectId, value: res.url });
    return NextResponse.json({ ok: true, project: updated, created: res });
  }

  // ── Netlify / Supabase: single value ──
  const field = provider === "netlify" ? "deployUrl" : "supabaseRef";

  if (action === "unlink") {
    const updated = await updateProject(projectId, { [field]: undefined });
    await logEvent("workspace.unlink", { provider, projectId });
    return NextResponse.json({ ok: true, project: updated });
  }
  if (action === "link") {
    const value = String(b.value ?? "").trim();
    if (!value) return NextResponse.json({ error: "value required to link" }, { status: 400 });
    const updated = await updateProject(projectId, { [field]: value });
    await logEvent("workspace.link", { provider, projectId });
    return NextResponse.json({ ok: true, project: updated });
  }

  // create
  const res: { ok: boolean; error?: string; url?: string; ref?: string } =
    provider === "netlify" ? await createNetlifySite(project.name) : await createSupabaseProject(project.name);
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 502 });
  const value = provider === "supabase" ? (res.ref ?? res.url) : res.url;
  const updated = await updateProject(projectId, { [field]: value });
  await logEvent("workspace.create", { provider, projectId, value });
  return NextResponse.json({ ok: true, project: updated, created: res });
}
