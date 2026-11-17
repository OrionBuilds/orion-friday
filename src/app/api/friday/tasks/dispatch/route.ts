import { NextResponse } from "next/server";
import { dispatchTask } from "@/lib/friday/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

// Run one existing task's assigned agent now (from the project board).
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const taskId = String(body.taskId ?? "");
  if (!taskId) return NextResponse.json({ error: "taskId required" }, { status: 400 });
  const result = await dispatchTask(taskId);
  return NextResponse.json(result);
}
