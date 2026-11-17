import { NextResponse } from "next/server";
import { getDoc, updateDoc, deleteDoc } from "@/lib/friday/repo";
import { normalizeCategory } from "@/lib/friday/docs/brief";
import { enrichDoc } from "@/lib/friday/docs/process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH { category } — recategorize: the brief is cleared and regenerated under the new lens
// (a proposal distilled through the keyword-plan lens is useless; the lens must match the purpose).
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await ctx.params;
  const doc = await getDoc(docId);
  if (!doc || doc.clientId !== id) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const category = normalizeCategory(body.category);
  const updated = await updateDoc(docId, { category, brief: undefined });
  void enrichDoc(docId).catch(() => {});
  return NextResponse.json({ doc: updated });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await ctx.params;
  const doc = await getDoc(docId);
  if (!doc || doc.clientId !== id) return NextResponse.json({ error: "not found" }, { status: 404 });
  const deleted = await deleteDoc(docId);
  return NextResponse.json({ deleted });
}
