import { NextResponse } from "next/server";
import { listSchedules, createSchedule, updateSchedule, deleteSchedule } from "@/lib/friday/schedules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ schedules: await listSchedules() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const schedule = await createSchedule(body);
  return NextResponse.json({ schedule });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const schedule = await updateSchedule(id, body.patch ?? {});
  if (!schedule) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ schedule });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? String((await req.json().catch(() => ({}))).id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = await deleteSchedule(id);
  return NextResponse.json({ ok });
}
