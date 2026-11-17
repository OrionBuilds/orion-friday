import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { getDoc, updateDoc } from "@/lib/friday/repo";
import { extractText, EXTRACT_CAP } from "@/lib/friday/docs/extract";
import { enrichDoc } from "@/lib/friday/docs/process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Heal a half-processed doc: re-run extraction when it's missing (or ?reextract=1 forces it), then
// AWAIT full enrichment (Drive mirror, memory chunks, brief). Idempotent — chunks re-index in place.
export async function POST(req: Request, ctx: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await ctx.params;
  let doc = await getDoc(docId);
  if (!doc || doc.clientId !== id) return NextResponse.json({ error: "not found" }, { status: 404 });

  const force = new URL(req.url).searchParams.get("reextract") === "1";
  if (force || !doc.extractedText.trim() || doc.status === "failed") {
    const bytes = await fs.readFile(doc.path).catch(() => null);
    if (bytes) {
      try {
        const text = (await extractText(bytes, doc.kind)).slice(0, EXTRACT_CAP + 1);
        doc = (await updateDoc(docId, {
          extractedText: text.slice(0, EXTRACT_CAP), extractedChars: text.length,
          status: "ready", error: undefined,
        })) ?? doc;
      } catch (e) {
        doc = (await updateDoc(docId, { status: "failed", error: String(e).slice(0, 200) })) ?? doc;
      }
    }
  }
  await enrichDoc(docId);
  return NextResponse.json({ doc: await getDoc(docId) });
}
