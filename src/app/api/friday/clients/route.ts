import { NextResponse } from "next/server";
import { listClients, createClient, updateClient, deleteClient } from "@/lib/friday/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ clients: await listClients() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const client = await createClient({
    name,
    company: body.company,
    email: body.email,
    phone: body.phone,
    jobTitle: body.jobTitle,
    addressLine: body.addressLine,
    city: body.city,
    state: body.state,
    postalCode: body.postalCode,
    status: body.status,
    notes: body.notes,
    tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
  }, {
    // New-client checkbox (owner rule 2026-07-19): welcome only when explicitly asked for; the
    // welcome itself is always parked in approve-to-send.
    queueWelcome: body.sendWelcome === true,
  });
  return NextResponse.json({ client });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const client = await updateClient(id, body.patch ?? {});
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ client });
}

// Delete a client + cascade its projects/tasks/runs (FRIDAY records only — external resources untouched).
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? String((await req.json().catch(() => ({}))).id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const res = await deleteClient(id);
  if (!res.ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(res);
}
