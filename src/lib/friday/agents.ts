// FRIDAY's default agent team. These are the builtin specialists FRIDAY delegates to.
// They are seeded into the registry (store.agents) on first run; the operator can then
// activate/deactivate them and import hundreds more from Claude/Multica later (Phase 6).

import { store, nowISO } from "@/lib/persistence/store";
import { FRIDAY_CORE, fridayVoice, AGENCY } from "@/lib/friday/persona";
import type { Agent, AgentRole, Engine } from "@/lib/friday/types";

interface Seed {
  id: string;
  name: string;
  role: AgentRole;
  engine: Engine;
  color: string;
  blurb: string;    // one-line role summary — the source for the generated team roster
  systemPrompt: string;
  tools?: string[];
  skills?: string[]; // pinned skill IDs — always injected (on top of the top-3 auto-selected)
}

function engineLabel(e: Engine): string {
  return ({ claude: "Claude", codex: "Codex", hermes: "Hermes", antigravity: "Antigravity", lmstudio: "LM Studio" } as Record<string, string>)[e] ?? e;
}

// The team roster block, GENERATED from the live specialist seeds — single source of truth. Changing
// an engine or blurb below updates every prompt that shows the roster, with no prose edit anywhere.
// This is what makes the old "prose says Hermes, config says Codex" drift structurally impossible.
export function teamRoster(): string {
  const lines = SPECIALIST_AGENTS.map((a) => `- ${a.name} (${a.id}) — ${a.blurb} [${engineLabel(a.engine)}]`);
  return `Your team (assign each task to the best-fit specialist):\n${lines.join("\n")}`;
}

// Valid task assignees for the planner + daily brief — generated from the roster (+ "human"), so the
// assignee enum can never drift out of sync with the agents that actually exist.
export function assigneeIds(): string[] {
  return [...SPECIALIST_AGENTS.map((a) => a.id), "human"];
}

// Role → tool mapping (set by the operator):
//   Claude Code  → planning roles (orchestrator, Architect, PM) — see roleEngine() below
//   Codex        → execution roles by default (Developer, Designer, DevOps, Debugger, SEO)
//   Codex        → review roles (QA / Code review) ONLY — the owner's directive 2026-08-26
//   Antigravity  → Browser control & automations   ·   Claude → Research
//   (env overrides: AGENTIC_OS_FRIDAY_PLAN_ENGINE / _EXEC_ENGINE / _REVIEW_ENGINE)
// The specialists FRIDAY delegates to. Defined BEFORE BUILTIN_AGENTS so teamRoster() (used to compose
// FRIDAY's own seed just below) can read them with no temporal-dead-zone. Engine per capability;
// "engine follows consequence" — client-facing / plan-defining roles get the strongest model.
// Appended to every deliverable-producing role. Client-facing artifacts (report PDFs, shared Docs) are
// rendered from ONLY the text below this marker (see deliverables.clientSafeBlock), so the agent's raw
// candor — file paths, "VERDICT: FAIL", blocker/should-fix notes — never reaches the client.
const CLIENT_SUMMARY_INSTR =
  "\n\nAt the VERY END of your reply, add a section headed exactly `## CLIENT SUMMARY`. Under it, write 2-5 plain sentences (or short bullets) a non-technical client can read: what was done and what it means for them. NO file paths, NO internal jargon (no \"VERDICT\", \"blocker\", \"PR\", \"commit\"), no candor about what's broken internally — just the client-facing outcome. This block is the ONLY part shown to the client.";

const SPECIALIST_AGENTS: Seed[] = [
  {
    id: "architect",
    name: "Architect",
    role: "architect",
    engine: "claude",
    color: "#22d3ee",
    blurb: "system/architecture design before code",
    systemPrompt:
      "You are the Architect for {{AGENCY}}. You design system architecture, data models, and technical approaches for client projects before code is written. Stack: GitHub + Netlify + Supabase + Next.js/React + TypeScript. Produce clear, pragmatic designs: components, data flow, tradeoffs, and a build sequence. Favor simple, proven patterns over clever ones.",
    tools: ["design", "architecture", "supabase", "workspace"],
    skills: ["skill:skills-library:codebase-design", "skill:skills-library:writing-plans", "skill:skills-library:test-driven-development"],
  },
  {
    id: "dev",
    name: "Developer",
    role: "dev",
    engine: "claude",
    color: "#d97757",
    blurb: "ships code + infra: GitHub, Netlify, Supabase",
    systemPrompt:
      "You are the Developer for {{AGENCY}}. You ship production code and infrastructure for client projects. Stack: GitHub + Netlify + Supabase + Next.js/React + TypeScript. Write clean, working code that matches the surrounding codebase. Explain what you changed in one tight paragraph. Never deploy or push to a client's production without explicit approval.",
    tools: ["code", "github", "netlify", "supabase", "workspace"],
    skills: ["skill:skills-library:test-driven-development", "skill:skills-library:verification-before-completion", "skill:skills-library:finishing-a-development-branch"],
  },
  {
    id: "devops",
    name: "DevOps",
    role: "devops",
    engine: "codex",
    color: "#22c55e",
    blurb: "CI/CD, deployments, environment + release engineering",
    systemPrompt:
      "You are the DevOps engineer for {{AGENCY}}. You handle CI/CD, deployments, environment config, Netlify + Supabase setup, and release engineering. Be precise and safety-first: propose the exact commands/config, and never run a production deploy or destructive infra change without explicit approval.",
    tools: ["ci", "deploy", "netlify", "supabase", "shell"],
    skills: ["skill:skills-library:netlify-deploy", "skill:skills-library:github-actions-hardening", "skill:skills-library:code-security"],
  },
  {
    id: "qa",
    name: "QA / Code Review",
    role: "qa",
    engine: "claude", // the gate can't be weaker than what it gates; needs reliable structured verdicts
    color: "#38bdf8",
    blurb: "reviews code/deliverables for correctness + quality",
    systemPrompt:
      "You are the QA / Code Review agent for {{AGENCY}}. You review code and deliverables for correctness, security, completeness, and quality before they reach the client. Report a short, prioritized list of findings (blocker / should-fix / nit) with file references. Be skeptical; flag anything that isn't client-ready." + CLIENT_SUMMARY_INSTR,
    tools: ["review", "test", "lint"],
    skills: ["skill:skills-library:code-review", "skill:skills-library:verification-before-completion", "skill:skills-library:webapp-testing", "skill:agency-agents:testing-reality-checker"],
  },
  {
    id: "debug",
    name: "Debugger",
    role: "debug",
    engine: "codex",
    color: "#f59e0b",
    blurb: "reproduces and root-causes failures, proposes minimal fixes",
    systemPrompt:
      "You are the Debugger for {{AGENCY}}. You diagnose failures — reproduce the issue, isolate the root cause, and propose the minimal fix. Show your reasoning briefly, then the concrete change. Prefer fixing the cause over the symptom." + CLIENT_SUMMARY_INSTR,
    tools: ["debug", "logs", "test"],
    skills: ["skill:skills-library:systematic-debugging", "skill:skills-library:diagnosing-bugs", "skill:skills-library:verification-before-completion"],
  },
  {
    id: "automation",
    name: "Automation",
    role: "automation",
    engine: "antigravity",
    color: "#7c3aed",
    blurb: "browser control and cross-app automations",
    systemPrompt:
      "You are the Automation agent for {{AGENCY}}. You drive browser-based and cross-app automations: filling forms, scraping, multi-step web workflows, and repetitive ops tasks. Describe the steps you'll take, then execute. Stop and ask before any irreversible or account-affecting action.",
    tools: ["browser", "automation", "web"],
    skills: ["skill:skills-library:agent-browser", "skill:skills-library:playwright-cli"],
  },
  {
    id: "pm",
    name: "PM / Delivery",
    role: "pm",
    engine: "claude", // owns breakdowns/effort/timelines — the job being automated; low volume, high leverage
    color: "#34d399",
    blurb: "breaks work down, owns tasks + timelines",
    systemPrompt:
      "You are the PM/Delivery agent for {{AGENCY}}. You turn a client request into a concrete, well-sequenced task breakdown, keep timelines realistic, and surface blockers early. Be concise and outcome-focused. Output plans as short task lists with owners and rough effort.",
    tools: ["projects", "tasks", "timeline"],
    skills: ["skill:skills-library:to-spec", "skill:skills-library:to-tickets", "skill:skills-library:writing-plans", "skill:agency-agents:project-management-project-shepherd"],
  },
  {
    id: "support",
    name: "Client Support",
    role: "support",
    engine: "claude", // every word shapes whether FRIDAY reads as a real Technical Director
    color: "#60a5fa",
    blurb: "client comms + support tickets (email, SMS)",
    systemPrompt:
      "You are the Client Support agent for {{AGENCY}}. You draft clear, friendly, professional client communications (email + SMS) and handle support tickets. Match a warm, competent agency tone. Always draft for approval before anything is sent to a client. Keep replies brief and human.",
    tools: ["email", "sms", "tickets"],
    skills: ["skill:skills-library:emails", "skill:agency-agents:customer-success-manager"],
  },
  {
    id: "research-qa",
    name: "Research",
    role: "research-qa",
    engine: "claude", // Hermes retired 2026-09-13
    color: "#f472b6",
    blurb: "research, competitive analysis, technical spikes",
    systemPrompt:
      "You are the Research agent for {{AGENCY}}. You research questions with rigor — web search, competitive analysis, technical spikes — and return a short, sourced, prioritized brief. Be concrete and skeptical; separate what's verified from what's assumed." + CLIENT_SUMMARY_INSTR,
    tools: ["research", "web", "search"],
    skills: ["skill:agency-agents:agent-reach", "skill:skills-library:research", "skill:agency-agents:research-synthesist", "skill:agency-agents:sales-outbound-strategist"],
  },
  // ── ALL SEO lives HERE. On-site/technical/AI-GEO plus off-site (links/authority, local/GBP, citations,
  // keyword→content strategy) for the clients' sites. ──
  {
    id: "seo",
    name: "SEO",
    role: "seo",
    engine: "codex", // technical crawl/audit + structured-data work — code-flavored, like devops/debug
    color: "#10b981",
    blurb: "technical, AI/GEO, off-site and local SEO for the sites we build & manage",
    systemPrompt:
      "You are the SEO specialist for {{AGENCY}}. You own the SEO for the sites we build and manage — on the site: technical SEO (crawlability, indexation, Core Web Vitals, site architecture, internal linking, redirects, hreflang), structured data / schema, on-page optimization, XML sitemaps, and AI-search / GEO readiness (AEO, llms.txt, entity + knowledge-panel signals, citability for AI answer engines). You diagnose against the live site, then implement the fix or hand a developer a precise, buildable spec. You also own OFF-SITE SEO — backlinks / digital PR, local & Google Business Profile, citations, and keyword-driven content strategy. Autom8ion Lab no longer offers paid ads or marketing campaigns; if asked, say so plainly. Prioritize by impact, cite the exact pages/templates, and tie every recommendation to the site's goals.",
    tools: ["seo", "web", "search"],
    skills: ["skill:skills-library:seo-audit", "skill:skills-library:schema", "skill:skills-library:ai-seo", "skill:agency-agents:marketing-seo-specialist", "skill:agency-agents:marketing-ai-citation-strategist"],
  },
  {
    id: "designer",
    name: "Designer",
    role: "designer",
    engine: "claude", // UI/UX reasoning + code
    color: "#ec4899",
    blurb: "UI/UX, design systems, front-end styling",
    systemPrompt:
      "You are the Designer for {{AGENCY}}. You produce UI/UX designs, design systems, and front-end styling that are clean, modern, accessible, and on-brand. Give concrete, buildable specs (layout, components, tokens) — not vague direction.",
    tools: ["design", "ui", "ux", "brand"],
    skills: ["skill:skills-library:ui-ux-pro-max", "skill:skills-library:frontend-design", "skill:skills-library:web-design-guidelines"],
  },
];

export const BUILTIN_AGENTS: Seed[] = [
  {
    id: "friday",
    name: "FRIDAY",
    role: "orchestrator",
    engine: "claude",
    color: "#22d3ee",
    blurb: "orchestrator — plans, delegates, tracks delivery",
    // Composed from parts: identity (CORE) + wit (VOICE) + the generated roster. teamRoster() reads
    // SPECIALIST_AGENTS (defined above), so no temporal-dead-zone and the roster is always current.
    systemPrompt: `${FRIDAY_CORE}\n\n${fridayVoice()}\n\n${teamRoster()}`,
    tools: ["plan", "dispatch", "clients", "projects", "tasks"],
    skills: ["skill:skills-library:writing-plans", "skill:skills-library:dispatching-parallel-agents", "skill:agency-agents:specialized-chief-of-staff"],
  },
  ...SPECIALIST_AGENTS,
];

// The specialist seed prompts carry the agency name as a "{{AGENCY}}" token; resolve
// it to config.agencyName here (the single materialization point) so identity lives in config, not in a
// dozen prompt strings, and flipping agencyName reflects in every stored prompt on next seed.
function withAgency(prompt: string): string {
  return prompt.split("{{AGENCY}}").join(AGENCY);
}

// ── Engine architecture (the owner, 2026-08-26): Claude PLANS, Codex EXECUTES + REVIEWS (LM Studio + Hermes retired 2026-09-13). ──
// Per-role-class engine resolution with env overrides. Applied at seed time so seedAgents()
// (which re-syncs builtin rows on every orchestrate/dispatch) always lands on the intended
// engine — a store-level override cannot survive the re-seed, so this is the one real lever.
// Roles not in any class keep their seed engine (support=claude comms, research-qa=claude,
// automation=antigravity).
const PLAN_ROLES = new Set(["orchestrator", "architect", "pm"]);
const EXEC_ROLES = new Set(["dev", "designer", "devops", "debug", "seo"]);
const REVIEW_ROLES = new Set(["qa"]);

function pickEngine(v: string | undefined): Engine | null {
  return v === "claude" || v === "lmstudio" || v === "codex" || v === "antigravity" || v === "hermes"
    ? v
    : null;
}

export function roleEngine(role: string, fallback: Engine): Engine {
  if (PLAN_ROLES.has(role)) return pickEngine(process.env.AGENTIC_OS_FRIDAY_PLAN_ENGINE) ?? "claude";
  if (EXEC_ROLES.has(role)) return pickEngine(process.env.AGENTIC_OS_FRIDAY_EXEC_ENGINE) ?? "codex";
  if (REVIEW_ROLES.has(role)) return pickEngine(process.env.AGENTIC_OS_FRIDAY_REVIEW_ENGINE) ?? "codex";
  return fallback;
}

export async function seedAgents(): Promise<Agent[]> {
  const existing = await store.agents.all();
  const byId = new Map(existing.map((a) => [a.id, a]));
  for (const s of BUILTIN_AGENTS) {
    const current = byId.get(s.id);
    const systemPrompt = withAgency(s.systemPrompt);
    const engine = roleEngine(s.role, s.engine);
    if (!current) {
      await store.agents.insert({
        id: s.id, name: s.name, role: s.role, engine,
        systemPrompt, tools: s.tools, skills: s.skills, color: s.color,
        active: true, source: "builtin", createdAt: nowISO(),
      });
    } else if (current.source === "builtin") {
      // Keep builtin definitions in sync with code (engine/prompt/tools/skills/color),
      // but preserve the operator's active toggle.
      await store.agents.update(s.id, {
        name: s.name, role: s.role, engine,
        systemPrompt, tools: s.tools, skills: s.skills, color: s.color,
      });
    }
  }
  return store.agents.all();
}

export async function getAgent(id: string): Promise<Agent | null> {
  return store.agents.get(id);
}

// Map a planner's short assignee (role word or alias) to a registered agent id.
const ASSIGNEE_ALIASES: Record<string, string> = {
  developer: "dev", build: "dev", engineer: "dev",
  "dev-ops": "devops", ops: "devops", deploy: "devops", infra: "devops",
  "code-review": "qa", review: "qa", reviewer: "qa", test: "qa", testing: "qa",
  debugging: "debug", debugger: "debug", bug: "debug",
  browser: "automation", automate: "automation", rpa: "automation",
  research: "research-qa", researcher: "research-qa",
  "project-manager": "pm", delivery: "pm", planner: "pm",
  "customer-support": "support", customer: "support",
  // Design lives here, and all SEO (on-site, AI/GEO, off-site, local/GBP).
  design: "designer", ui: "designer", ux: "designer", "ui-ux": "designer",
  seo: "seo", "on-site-seo": "seo", "off-site-seo": "seo", "local-seo": "seo", gbp: "seo", backlinks: "seo", citations: "seo", "technical-seo": "seo", geo: "seo", aeo: "seo", "ai-seo": "seo", schema: "seo",
  // CRO / landing-page work: designer specs it, dev ships it. Tracking/pixel/analytics work is
  // on-site technical → seo. A raw "cro"/"landing"/"tracking" assignee resolves here without
  // falling through to `pm` (the previous default).
  cro: "designer", landing: "designer", "landing-page": "designer", conversion: "designer",
  tracking: "seo", analytics: "seo", pixel: "seo",
};
export function resolveAssignee(assignee: string): string {
  const key = assignee.toLowerCase().trim();
  if (key === "human") return "human";
  if (ASSIGNEE_ALIASES[key]) return ASSIGNEE_ALIASES[key];
  const match = BUILTIN_AGENTS.find((a) => a.id === key || a.role === key);
  return match ? match.id : "pm";
}
