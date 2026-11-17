import { NextResponse } from "next/server";
import { listTasks, createTask, updateTask, deleteTask } from "@/lib/friday/repo";
import { OWNER } from "@/lib/friday/persona";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });
  return NextResponse.json({ tasks: await listTasks(projectId) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const projectId = String(body.projectId ?? "");
  const title = String(body.title ?? "").trim();
  if (!projectId || !title) return NextResponse.json({ error: "projectId and title required" }, { status: 400 });
  const task = await createTask({
    projectId, title,
    description: body.description,
    status: body.status,
    assignee: body.assignee,
    risk: body.risk,
    // Board-created work is owner-originated unless the caller says otherwise.
    requestedBy: body.requestedBy ?? OWNER,
    details: body.details,
    executionPlan: body.executionPlan,
  });
  return NextResponse.json({ task });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const task = await updateTask(id, body.patch ?? {});
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ task });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = await deleteTask(id);
  return NextResponse.json({ ok });
}
