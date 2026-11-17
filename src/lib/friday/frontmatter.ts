// Parse `--- yaml --- body` markdown files (Claude agents/skills, Multica skills, souls).
// Uses the js-yaml dep already in the project. Tolerant: files with no frontmatter return
// an empty object + the whole content as body.

import yaml from "js-yaml";

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): ParsedDoc {
  const m = raw.match(FM_RE);
  if (!m) return { frontmatter: {}, body: raw.trim() };
  let fm: Record<string, unknown> = {};
  try {
    const loaded = yaml.load(m[1]);
    if (loaded && typeof loaded === "object") fm = loaded as Record<string, unknown>;
  } catch {
    /* malformed frontmatter — treat as none */
  }
  return { frontmatter: fm, body: (m[2] ?? "").trim() };
}

// Coerce a frontmatter value that may be a string, array, or comma-list into string[].
export function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
}

export function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}
