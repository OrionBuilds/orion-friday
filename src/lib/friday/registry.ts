// FRIDAY registry — imports agents / skills / commands / souls from disk into the store.
//
// Index-in-place: we store frontmatter + the absolute `path`, NOT the full body. Bodies are
// read on demand via readBody() and LRU-cached, so ~640 records stay small and auto-sync with
// the source files. Operator state (active toggle, pinned skills, engine override) is preserved
// across re-scans.

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { store, nowISO, logEvent } from "@/lib/persistence/store";
import { parseFrontmatter, asString, asStringArray } from "@/lib/friday/frontmatter";
import { importSources, type ImportSource } from "@/lib/friday/importSources";
import { sanitizeBody } from "@/lib/friday/bench";
import { staleRowIds } from "@/lib/friday/registryPrune";
import type { Agent, Skill, AgentSource, Engine } from "@/lib/friday/types";

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unnamed";
}

// Pick the best engine for an imported sub-agent by its frontmatter `type` + name/description, so
// the 100+ library agents don't all pile onto Claude. Codex = execution/review; Antigravity = browser;
// Hermes = research/integration/SEO/sales tools; LM Studio = planning/coordination; Claude = build/design.
function engineForAgent(type?: string, name = "", description = ""): Engine {
  const t = (type || "").toLowerCase();
  const hay = `${type || ""} ${name} ${description}`.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => hay.includes(w));
  if (/security|tester|validator|code-analyzer|devops/.test(t) || has("code review", "code-review", "reviewer", "qa", "security", "devops", "ci/cd", "pipeline", "lint", "debugg", "test-", "unit test")) return "codex";
  if (/automation/.test(t) || has("browser", "scrape", "rpa", "playwright", "puppeteer", "selenium", "web automation", "desktop")) return "antigravity";
  if (/analyst|analysis|documentation|research|synchronizer/.test(t) || has("research", "seo", "backlink", "crawl", "competitor", "outreach", "lead-gen", "leads", "sales", "market analys", "integration")) return "claude"; // Hermes retired 2026-09-13
  if (/coordinator|coordination|orchestration/.test(t) || has("coordinator", "orchestrat", "project manager", "sprint", "prioritiz", "product manager", "planner")) return "lmstudio";
  return "claude";
}

// Walk a source root for its glob. "*/SKILL.md" → one level of subdirs; "**/*.md" → recursive.
async function walkFiles(src: ImportSource): Promise<string[]> {
  if (!existsSync(src.root)) return [];
  const out: string[] = [];
  if (src.glob === "*/SKILL.md") {
    const entries = await fs.readdir(src.root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const f = path.join(src.root, e.name, "SKILL.md");
      if (existsSync(f)) out.push(f);
    }
    return out;
  }
  // recursive **/*.md
  const stack = [src.root];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".git")) continue;
        stack.push(full);
      } else if (e.name.toLowerCase().endsWith(".md")) {
        out.push(full);
      }
    }
  }
  return out;
}

const AGENT_SOURCE: Record<string, AgentSource> = {
  "claude-agents": "claude", "claude-skills": "claude", "claude-commands": "claude",
  "multica-skills": "multica", "orion-prompts": "import", "marketing-souls": "import",
};

export interface ScanResult {
  agents: number;
  skills: number;
  commands: number;
  souls: number;
  durationMs: number;
  bySource: Record<string, number>;
  pruned: { agents: number; skills: number }; // rows for files that vanished from a scanned source
}

export async function scanSources(): Promise<ScanResult> {
  const started = Date.now();
  const result: ScanResult = { agents: 0, skills: 0, commands: 0, souls: 0, durationMs: 0, bySource: {}, pruned: { agents: 0, skills: 0 } };

  // Preserve operator state across re-scans.
  const existingAgents = new Map((await store.agents.all()).map((a) => [a.id, a]));
  const existingSkills = new Map((await store.skills.all()).map((s) => [s.id, s]));

  const agentRows: Agent[] = [];
  const skillRows: Skill[] = [];

  const scanned = new Set<string>(); // sources whose root exists — only these may have rows pruned
  for (const src of importSources()) {
    const files = await walkFiles(src);
    result.bySource[src.id] = files.length;
    if (existsSync(src.root)) scanned.add(src.id);
    for (const file of files) {
      let fm: Record<string, unknown> = {}, body = "";
      try {
        const raw = await fs.readFile(file, "utf8");
        ({ frontmatter: fm, body } = parseFrontmatter(raw));
      } catch { continue; }
      const name = asString(fm.name) || path.basename(file, ".md").replace(/^SKILL$/i, path.basename(path.dirname(file)));
      const description = asString(fm.description) || body.slice(0, 200);

      if (src.kind === "agent") {
        const id = `agent:${src.id}:${slug(name)}`;
        const prev = existingAgents.get(id);
        agentRows.push({
          id,
          name,
          description,
          role: "custom",
          // Route each imported sub-agent to the engine that fits its capability (by frontmatter
          // `type` then name keywords) instead of everything on Claude. Operator overrides win.
          engine: (prev?.engine ?? engineForAgent(asString(fm.type), name, description)) as Engine,
          model: asString(fm.model),
          systemPrompt: undefined, // lazy from path
          tools: asStringArray(fm.tools),
          skills: prev?.skills ?? [],
          color: asString(fm.color),
          active: prev?.active ?? false, // opt-in to roster
          source: AGENT_SOURCE[src.id] ?? "import",
          sourceId: src.id,
          path: file,
          type: asString(fm.type),
          createdAt: prev?.createdAt ?? nowISO(),
        });
        result.agents++;
      } else {
        const id = `skill:${src.id}:${slug(name)}`;
        const prev = existingSkills.get(id);
        skillRows.push({
          id,
          name,
          description,
          kind: src.kind === "command" ? "command" : src.kind === "soul" ? "soul" : "skill",
          source: AGENT_SOURCE[src.id] ?? "import",
          sourceId: src.id,
          path: file,
          frontmatter: fm,
          tags: asStringArray(fm.tags) ?? asStringArray((fm.metadata as { tags?: unknown })?.tags),
          active: prev?.active ?? true,
          createdAt: prev?.createdAt ?? nowISO(),
        });
        if (src.kind === "command") result.commands++;
        else if (src.kind === "soul") result.souls++;
        else result.skills++;
      }
    }
  }

  // Drop rows whose file vanished from a source we walked this pass (renamed/deleted skills used to
  // linger forever with empty bodies). Unscanned sources and builtins are untouched — see registryPrune.
  const staleAgents = staleRowIds([...existingAgents.values()], agentRows, scanned);
  const staleSkills = staleRowIds([...existingSkills.values()], skillRows, scanned);
  for (const id of staleAgents) await store.agents.remove(id);
  for (const id of staleSkills) await store.skills.remove(id);
  result.pruned = { agents: staleAgents.length, skills: staleSkills.length };

  if (agentRows.length) await store.agents.upsertMany(agentRows, false);
  if (skillRows.length) await store.skills.upsertMany(skillRows, false);

  result.durationMs = Date.now() - started;
  await logEvent("registry.scan", { ...result });
  return result;
}

// ── Lazy body loading (LRU) ──────────────────────────────────────────────
const bodyCache = new Map<string, string>();
const BODY_CACHE_MAX = 300;

export async function readBody(rec: { id?: string; path?: string; body?: string }): Promise<string> {
  if (rec.body) return sanitizeBody(rec.body);
  if (!rec.path) return "";
  const key = rec.path;
  const hit = bodyCache.get(key);
  if (hit !== undefined) return hit;
  let body = "";
  try {
    const raw = await fs.readFile(rec.path, "utf8");
    // Interpolate ${OWNER}/${AGENCY}/${STACK} + scrub other-business literals that ride in on shared
    // "soul" bodies (see bench.sanitizeBody). Cached post-sanitize so every consumer gets the clean text.
    body = sanitizeBody(parseFrontmatter(raw).body);
  } catch { body = ""; }
  if (bodyCache.size >= BODY_CACHE_MAX) {
    const first = bodyCache.keys().next().value;
    if (first) bodyCache.delete(first);
  }
  bodyCache.set(key, body);
  return body;
}
