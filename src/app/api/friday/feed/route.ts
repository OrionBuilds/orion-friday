import { NextResponse } from "next/server";
import { store } from "@/lib/persistence/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Recent orchestration activity — powers the live feed on the FRIDAY command center.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const logs = await store.logs.tail(limit, projectId ? (l) => l.projectId === projectId : undefined);
  return NextResponse.json({ logs: logs.reverse() });
}
