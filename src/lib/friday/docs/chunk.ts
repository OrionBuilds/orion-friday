// FRIDAY client documents — pure text chunker for memory indexing (eval-locked).
//
// Why chunk at all: embeddings.ts embed() hard-truncates each text at ~2000 chars, so indexing a
// whole proposal would silently drop everything past page one. Chunks of 1500 (< 2000) with a 200
// overlap keep every fact retrievable and give recall sentence-level granularity.

export interface ChunkOpts {
  size?: number;    // target chunk length (chars)
  overlap?: number; // carried into the next chunk for continuity
  max?: number;     // hard cap on chunk count (runaway guard)
}

/**
 * Split text into overlapping chunks, snapping ends to paragraph (then sentence) boundaries when one
 * exists in the tail window — but never below size/2 (no confetti chunks). Guarantees: every char of
 * the input is covered by at least one chunk (until `max`), each chunk ≤ size, always terminates
 * (forced-progress guard beats pathological whitespace-free input).
 */
export function chunkText(text: string, opts: ChunkOpts = {}): string[] {
  const size = opts.size ?? 1500;
  const overlap = Math.min(opts.overlap ?? 200, Math.floor(size / 2));
  const max = opts.max ?? 48; // 48 × (1500-200) stride = 62.4k > EXTRACT_CAP — the cap never truncates a capped extraction
  const t = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (t.length < 12) return [];
  if (t.length <= size) return [t];

  const chunks: string[] = [];
  let start = 0;
  let prevStart = -1;
  while (start < t.length && chunks.length < max) {
    let end = Math.min(start + size, t.length);
    if (end < t.length) {
      // Prefer a paragraph break, then a sentence break, in the last 300 chars of the window —
      // accepted only past the halfway point so a break-dense region can't shrink chunks to crumbs.
      const windowStart = Math.max(start + Math.floor(size / 2), end - 300);
      const slice = t.slice(windowStart, end);
      const para = slice.lastIndexOf("\n\n");
      const sentence = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
      const cut = para >= 0 ? para + 2 : sentence >= 0 ? sentence + 1 : -1;
      if (cut > 0) end = windowStart + cut;
    }
    const piece = t.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= t.length) break;
    let next = end - overlap;
    if (next <= prevStart || next <= start) next = start + (size - overlap); // forced progress
    prevStart = start;
    start = next;
  }
  if (start < t.length && chunks.length >= max && chunks.length > 0) {
    chunks[chunks.length - 1] += " …"; // truncated at the cap — visible, never silent
  }
  return chunks;
}
