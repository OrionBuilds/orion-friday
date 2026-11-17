import { NextResponse } from "next/server";
import { getOwnerStatus, setAway, setAvailable } from "@/lib/friday/ownerStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → current owner availability. POST { away, untilISO?, reason? } → toggle (2.3 away mode).
export async function GET() {
  return NextResponse.json(await getOwnerStatus());
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (body.away === false) {
    const { status, digest } = await setAvailable();
    return NextResponse.json({ status, digest });
  }
  const status = await setAway(typeof body.untilISO === "string" ? body.untilISO : undefined, typeof body.reason === "string" ? body.reason : undefined);
  return NextResponse.json({ status });
}
