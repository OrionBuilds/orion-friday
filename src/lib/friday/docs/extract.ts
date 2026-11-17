// FRIDAY client documents — text extraction. Parse-only, never executes content, no OCR (a scanned
// PDF extracts to ~nothing and simply contributes no context — visible via extractedChars in the UI).
// A parse failure THROWS; the caller marks the doc status "failed" with the error, and failed docs
// never reach a prompt (context.ts filters to status "ready").

import type { DocKind } from "@/lib/friday/types";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB per file (sibling-agent parity)
export const EXTRACT_CAP = 60_000;                // chars stored on the record

export const DOC_MIME: Record<DocKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};

/** Map a filename to its DocKind — null means "not an accepted document type" (reject the upload). */
export function kindFromFilename(name: string): DocKind | null {
  const ext = (name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext) return null;
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "txt") return "txt";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "csv") return "csv";
  return null;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Extract plain text from a document buffer. Throws on parse failure (caller marks doc failed). */
export async function extractText(buf: Buffer, kind: DocKind): Promise<string> {
  if (kind === "pdf") {
    // Lib subpath on purpose: pdf-parse's index.js runs a debug self-test file read at import time.
    const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
    const out = await pdfParse(buf);
    return (out.text ?? "").trim();
  }
  if (kind === "docx") {
    const mammoth = await import("mammoth");
    const out = await mammoth.extractRawText({ buffer: buf });
    return (out.value ?? "").trim();
  }
  return stripBom(buf.toString("utf8")).trim();
}
