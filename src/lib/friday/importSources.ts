// Where FRIDAY imports agents / skills / commands / souls from.
// Paths default to this machine's known locations but are overridable via
// ~/.agentic-os/config.json → "registrySources": [{ id, kind, root, glob }].

import path from "node:path";
import os from "node:os";
import { config } from "@/lib/config";

export type SourceKind = "agent" | "skill" | "command" | "soul";

export interface ImportSource {
  id: string;
  label: string;
  kind: SourceKind;
  root: string;
  // "**/*.md" = recursive md; "*/SKILL.md" = one SKILL.md per immediate subdir.
  glob: "**/*.md" | "*/SKILL.md";
}

const HOME = os.homedir();
// Where the agency repos are checked out (FRIDAY_REPOS_ROOT, default ~/GitHub).
const REPOS = process.env.FRIDAY_REPOS_ROOT?.trim() || path.join(HOME, "GitHub");

export const DEFAULT_SOURCES: ImportSource[] = [
  { id: "claude-agents",   label: "Claude Agents",     kind: "agent",   root: path.join(HOME, ".claude", "agents"),   glob: "**/*.md" },
  { id: "claude-skills",   label: "Claude Skills",     kind: "skill",   root: path.join(HOME, ".claude", "skills"),   glob: "*/SKILL.md" },
  { id: "claude-commands", label: "Claude Commands",   kind: "command", root: path.join(HOME, ".claude", "commands"), glob: "**/*.md" },
  { id: "multica-skills",  label: "Multica Skills",    kind: "skill",   root: path.join(REPOS, "agents", ".agents", "skills"), glob: "*/SKILL.md" },
  { id: "orion-prompts",  label: "Orion Prompts",    kind: "soul",    root: path.join(REPOS, "orion", "src", "assets", "prompts", "skills"), glob: "**/*.md" },
  { id: "marketing-souls", label: "Marketing Souls",   kind: "soul",    root: path.join(REPOS, "marketing-agents", "src", "skills"), glob: "**/*.md" },
];

export function importSources(): ImportSource[] {
  const custom = (config as unknown as { registrySources?: ImportSource[] }).registrySources;
  if (Array.isArray(custom) && custom.length) return custom;
  return DEFAULT_SOURCES;
}
