// FRIDAY artifacts — durable, servable deliverables produced by agent runs (PDF reports, etc.).
// Files land under ~/.agentic-os/friday/artifacts/<runId>/<slug>.<ext>. The GET /api/friday/artifact
// route streams them back, path-jailed to ARTIFACTS_ROOT via `withinArtifacts` below.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { newId, nowISO } from "@/lib/persistence/store";
import type { Artifact } from "@/lib/friday/types";

export const ARTIFACTS_ROOT = path.join(os.homedir(), ".agentic-os", "friday", "artifacts");

export function artifactsRoot(): string {
  return ARTIFACTS_ROOT;
}

// True only for a path that resolves inside the artifacts dir (blocks ../ traversal).
export function withinArtifacts(abs: string): boolean {
  const r = path.resolve(abs);
  return r === ARTIFACTS_ROOT || r.startsWith(ARTIFACTS_ROOT + path.sep);
}

function slug(s: string): string {
  return (s || "artifact").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "artifact";
}

// Persist bytes for a run and return the Artifact record (with an absolute on-disk `path`).
export async function saveArtifact(
  runId: string,
  input: { kind: Artifact["kind"]; label: string; ext: string; mime?: string; bytes: Buffer },
): Promise<Artifact> {
  const dir = path.join(ARTIFACTS_ROOT, runId);
  await mkdir(dir, { recursive: true });
  const ext = input.ext.startsWith(".") ? input.ext : `.${input.ext}`;
  const abs = path.join(dir, `${slug(input.label)}${ext}`);
  await writeFile(abs, input.bytes);
  return { id: newId(), kind: input.kind, label: input.label, path: abs, mime: input.mime, createdAt: nowISO() };
}

// A pure link artifact (e.g. a GitHub PR) — no file on disk.
export function linkArtifact(kind: Artifact["kind"], label: string, url: string): Artifact {
  return { id: newId(), kind, label, url, createdAt: nowISO() };
}
