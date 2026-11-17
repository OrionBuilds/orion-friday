// FRIDAY client documents — category-aware brief distillation.
//
// A 40-page proposal is useless raw in a prompt; the brief is the skimmable, purpose-shaped digest
// that context.ts prefers when composing the run block. The LENS (which sections matter) is chosen
// by the document's category — a contract answers different questions than a strategy doc — and the
// lens mapping is pure so the eval locks it. Distillation is best-effort: on failure the doc stays
// fully usable from its extracted text.

import { complete } from "@/lib/friday/engines";
import type { Client, ClientDoc, DocCategory } from "@/lib/friday/types";

export const DOC_CATEGORIES: DocCategory[] = ["proposal", "plan", "strategy", "brief", "contract", "other"];

export function normalizeCategory(v: unknown): DocCategory {
  const s = String(v ?? "").trim().toLowerCase();
  return (DOC_CATEGORIES as string[]).includes(s) ? (s as DocCategory) : "other";
}

/** The sections the brief should carry, per category. Pure — eval-locked. */
export function lensSections(category: DocCategory): string[] {
  switch (category) {
    case "proposal":
      return ["Scope & deliverables", "Timeline & milestones", "Pricing & payment terms", "Assumptions & exclusions", "Success criteria", "Notes"];
    case "plan":
      return ["Goals & KPIs", "Workstreams & phases", "Key dates & deadlines", "Owners & responsibilities", "Dependencies & risks", "Notes"];
    case "strategy":
      return ["Objectives", "Audience & positioning", "Key initiatives", "Success metrics", "Constraints", "Notes"];
    case "brief":
      return ["Goals", "Requirements & scope", "Constraints", "Key dates", "Acceptance criteria", "Notes"];
    case "contract":
      return ["Parties & term", "Scope of services", "Payment terms", "Commitments & SLAs", "Key dates", "Termination & renewal"];
    default:
      return ["Goals", "Scope", "Commitments", "Constraints", "Key dates", "Success criteria"];
  }
}

const INPUT_BUDGET = 12_000;

/** Distil a document into a category-lensed markdown brief. Throws only never — returns "" on failure. */
export async function generateDocBrief(client: Client, doc: ClientDoc, text: string): Promise<string> {
  try {
    const sections = lensSections(doc.category).map((s) => `- **${s}**`).join("\n");
    const out = await complete({
      system:
        "You are FRIDAY, an agency operations lead. The OWNER uploaded this document so FRIDAY's agents have the client's real context. " +
        "Distil it into a tight, skimmable brief in markdown. Only use facts present in the document — never invent numbers, prices, or dates; " +
        "quote money and date commitments exactly as written. Omit sections the document does not cover. Output the brief only.",
      prompt:
        `Client: ${client.name}${client.company ? ` (${client.company})` : ""}\n` +
        `Document: "${doc.filename}" (${doc.category}, ${doc.kind})\n\n` +
        `Structure the brief with these sections (bulleted, terse):\n${sections}\n\n` +
        `Document text:\n${text.slice(0, INPUT_BUDGET)}`,
      temperature: 0.2,
      timeoutMs: 180_000,
    });
    return (out ?? "").trim();
  } catch {
    return "";
  }
}
