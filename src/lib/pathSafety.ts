// Path-safety primitives for anything built from caller-supplied input.
//
// Why this exists: the codebase validated project/goal/run names with
// /^[A-Za-z0-9_.-]+$/, which MATCHES ".." — `.` is in the character class and
// nothing rejected dot-only names. So `path.join(ROOT, name)` could escape ROOT.
//
// Mirrors the existing `withinArtifacts` (src/lib/friday/artifacts.ts) and
// `withinDocs` (src/lib/friday/docs/storage.ts) idiom.

import path from "node:path";

/**
 * A single, safe path segment: the original allowed character set, minus
 * dot-only names ("." / ".." / "...") and anything containing a separator.
 */
export function isSafeSegment(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0) return false;
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return false;
  if (/^\.+$/.test(name)) return false; // ".", "..", "..." — traversal
  return true;
}

/** True only when `abs` resolves to `root` itself or something inside it. */
export function withinRoot(abs: string, root: string): boolean {
  const r = path.resolve(abs);
  const base = path.resolve(root);
  return r === base || r.startsWith(base + path.sep);
}

/**
 * Contain a caller-supplied absolute path to `root`.
 * Returns the resolved path when it is inside `root`, otherwise null.
 *
 * Used to stop a request body from choosing an arbitrary working directory for
 * a spawned agent CLI.
 */
export function containedPath(candidate: unknown, root: string): string | null {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const resolved = path.resolve(candidate);
  return withinRoot(resolved, root) ? resolved : null;
}
