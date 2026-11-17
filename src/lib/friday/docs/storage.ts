// FRIDAY client documents — on-disk storage layout + the path jail.
//
// Raw uploads live at DOCS_ROOT/<clientId>/<docId>.<ext> under the data dir (mirrors the JSON-store
// convention; sibling agents run the same layout independently). Every serve/delete path MUST pass
// withinDocs() — the jail is the only thing standing between a crafted ?path= and the rest of the
// datastore (clients.json lives one directory up).

import path from "node:path";
import { FRIDAY_DATA_DIR } from "@/lib/persistence/store";
import type { DocKind } from "@/lib/friday/types";

export const DOCS_ROOT = path.resolve(path.join(FRIDAY_DATA_DIR, "docs"));

/**
 * Pure jail check: true only for DOCS_ROOT itself or paths strictly inside it. The `+ path.sep`
 * form defeats the sibling-prefix trick (`<root>-evil\x`), same guarantee as artifacts.ts.
 * Callers must pass an already-resolved absolute path (path.resolve).
 */
export function withinDocs(abs: string): boolean {
  const r = path.resolve(abs);
  return r === DOCS_ROOT || r.startsWith(DOCS_ROOT + path.sep);
}

export function docFilePath(clientId: string, docId: string, kind: DocKind): string {
  return path.join(DOCS_ROOT, clientId, `${docId}.${kind}`);
}
