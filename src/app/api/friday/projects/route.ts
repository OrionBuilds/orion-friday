import { NextResponse } from "next/server";
import { listProjects, createProject, updateProject, getProject, createClient, deleteProject } from "@/lib/friday/repo";
import { listTasks } from "@/lib/friday/repo";
import { isSelfSourceDir } from "@/lib/friday/delivery";
import { store } from "@/lib/persistence/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const clientId = url.searchParams.get("clientId") ?? undefined;
  if (id) {
    const project = await getProject(id);
    if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
    const tasks = await listTasks(id);
    const client = await store.clients.get(project.clientId);
    return NextResponse.json({ project, tasks, client: client ? { id: client.id, name: client.name, email: client.email } : null, selfSource: isSelfSourceDir(project.workspaceDir) });
  }
  return NextResponse.json({ projects: await listProjects(clientId) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  let clientId = String(body.clientId ?? "");
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  // Allow creating a brand-new client inline (from the "create new client" option).
  if (!clientId && body.newClientName && String(body.newClientName).trim()) {
    const c = await createClient({ name: String(body.newClientName).trim() });
    clientId = c.id;
  }
  if (!clientId) return NextResponse.json({ error: "clientId or newClientName required" }, { status: 400 });
  const project = await createProject({
    clientId, name,
    description: body.description,
    stack: body.stack,
    startDate: body.startDate,
    targetEndDate: body.targetEndDate,
    budget: typeof body.budget === "number" ? body.budget : body.budget ? Number(String(body.budget).replace(/[^0-9.]/g, "")) : undefined,
    repoUrl: body.repoUrl,
    repoUrls: Array.isArray(body.repoUrls) ? body.repoUrls : undefined,
    deployUrl: body.deployUrl,
    supabaseRef: body.supabaseRef,
  });
  return NextResponse.json({ project });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const project = await updateProject(id, body.patch ?? {});
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ project });
}

// Delete a project + its tasks/runs (FRIDAY records only — external repos/sites are untouched).
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? String((await req.json().catch(() => ({}))).id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const res = await deleteProject(id);
  if (!res.ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(res);
}
