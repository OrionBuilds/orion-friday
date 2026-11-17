// Shared file-streaming helper for the ~dozen preview / raw / file routes.
//
// It handles ONLY the post-validation streaming: parse the Range header and
// return 206 partial content, 416 for a well-formed-but-unsatisfiable range, or
// 200 whole-file — with the standard headers (Cache-Control: no-store,
// Accept-Ranges: bytes). Callers must have already resolved + jailed the
// absolute path, confirmed it is a real file, and decided the MIME type. MIME is
// deliberately a parameter — this helper never infers or unifies it.

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export interface StreamFileOptions {
  /** Content-Type. Each caller resolves its own MIME; it is never inferred here. */
  mime: string;
  /** Total file size in bytes (callers already stat() for their is-a-file check). */
  size: number;
}

// Node's Readable.toWeb() returns a node:stream/web ReadableStream; the Response
// constructor wants the DOM ReadableStream. Centralize the (safe) cast.
function toWebStream(rs: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(rs) as unknown as NodeReadableStream<Uint8Array> as unknown as ReadableStream<Uint8Array>;
}

export function streamFile(req: Request, absPath: string, opts: StreamFileOptions): Response {
  const { mime, size } = opts;
  const baseHeaders: Record<string, string> = {
    "Content-Type": mime,
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };

  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    // Only a well-formed `bytes=start-end` is acted on. A syntactically
    // unparseable Range header is ignored (fall through to 200), per RFC 7233.
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (m) {
      const start = m[1] === "" ? 0 : Number(m[1]);
      const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
      const satisfiable =
        Number.isFinite(start) && Number.isFinite(end) &&
        start >= 0 && start <= end && start < size;
      if (satisfiable) {
        return new Response(toWebStream(createReadStream(absPath, { start, end })), {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${size}`,
          },
        });
      }
      // Well-formed but unsatisfiable (inverted or out of bounds) → 416.
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
      });
    }
  }

  return new Response(toWebStream(createReadStream(absPath)), {
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}
