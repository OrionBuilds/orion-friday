// FRIDAY — project status as a first-class capability (owner-comms overhaul, 2026-09-24).
//
// "How's Globex going?" used to be answered from memory or by delegating a free-text chat that
// could spawn a task. This module answers it from the ground truth FRIDAY actually holds — task
// board, runs, approvals, GitHub, Netlify, the OS portal feed, the Obsidian project log — and says
// where each fact came from and how old it is. Every source is best-effort with its own timeout:
// a dead GitHub or an offline OS degrades one `sources[]` entry, never the answer.
//
// Shape is the shared interagent StatusResponse (agent-core), so CLARA and the Office can consume
// it verbatim. `assembleProjectStatus` is pure (tested); `buildProjectStatus` only gathers inputs.

import type {
  StatusItem, StatusResponse, StatusSubject,
} from "@autom8ionlab/agent-core";
import { store } from "@/lib/persistence/store";
import { config } from "@/lib/config";
import { isClosed } from "@/lib/friday/stages";
import { engineeringStage, projectRisk, HOLDING_STAGES, CHORE } from "@/lib/friday/projectStage";
import type { Project, Task, AgentRun, Approval, Client, TaskStatus } from "@/lib/friday/types";
import { projectRepos } from "@/lib/friday/types";
import { parseGithubRepo } from "@/lib/friday/recentWork";

const SOURCE_TIMEOUT_MS = 4_000;
const DEFAULT_SINCE_DAYS = 7;

// ── Subject resolution ──────────────────────────────────────────────────────

export type SubjectResolution =
  | { project: Project; client?: Client }
  | { candidates: { id: string; name: string; client?: string }[] }
  | null;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s: string) => norm(s).split(" ").filter((t) => t.length >= 3);

/** Pure resolver over in-memory rows so the precedence is testable without the store. */
export function resolveSubjectFrom(
  subject: StatusSubject,
  projects: Project[],
  clients: Client[],
): SubjectResolution {
  const byId = subject.id ? projects.find((p) => p.id === subject.id) : undefined;
  if (byId) return { project: byId, client: clients.find((c) => c.id === byId.clientId) };
  const q = norm(subject.name ?? subject.id ?? "");
  if (!q) return null;

  const clientOf = (p: Project) => clients.find((c) => c.id === p.clientId);
  const label = (p: Project) => ({ id: p.id, name: p.name, client: clientOf(p)?.company ?? clientOf(p)?.name });

  // 1. exact project name
  const exact = projects.filter((p) => norm(p.name) === q);
  if (exact.length === 1) return { project: exact[0], client: clientOf(exact[0]) };
  // 2. project name contains / is contained by the query (prefer active)
  const contains = projects.filter((p) => norm(p.name).includes(q) || q.includes(norm(p.name)));
  const pick = (list: Project[]): SubjectResolution => {
    if (list.length === 1) return { project: list[0], client: clientOf(list[0]) };
    const active = list.filter((p) => p.status === "active");
    if (active.length === 1) return { project: active[0], client: clientOf(active[0]) };
    return { candidates: (active.length ? active : list).slice(0, 5).map(label) };
  };
  if (contains.length) return pick(contains);
  // 3. token overlap on project name (fuzzy, e.g. "globex site" vs "Globex Website")
  const qt = tokens(q);
  if (qt.length) {
    const scored = projects
      .map((p) => ({ p, hits: tokens(p.name).filter((t) => qt.includes(t)).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits);
    if (scored.length && (scored.length === 1 || scored[0].hits > scored[1].hits)) return { project: scored[0].p, client: clientOf(scored[0].p) };
    if (scored.length > 1) return { candidates: scored.slice(0, 5).map((x) => label(x.p)) };
  }
  // 4. client id, then client name / company → that client's projects
  const rawId = subject.id ?? subject.name ?? "";
  const client = clients.find((c) => c.id === rawId)
    ?? clients.find((c) => norm(c.company ?? "") === q || norm(c.name) === q || norm(c.company ?? "").includes(q) || norm(c.name).includes(q));
  if (client) {
    const theirs = projects.filter((p) => p.clientId === client.id);
    if (theirs.length) return pick(theirs);
  }
  return null;
}

export async function resolveStatusSubject(subject: StatusSubject): Promise<SubjectResolution> {
  const [projects, clients] = await Promise.all([store.projects.all(), store.clients.all()]);
  return resolveSubjectFrom(subject, projects, clients);
}

// ── Inputs (gathered, each best-effort) ─────────────────────────────────────

export interface StatusInputs {
  now: Date;
  since: string;
  project: Project;
  client?: Client;
  tasks: Task[];
  runs: AgentRun[];
  approvals: Approval[];
  commits: { date: string; message: string }[] | null;
  deploys: { id: string; state: string; branch?: string; createdAt?: string; errorMessage?: string; deployUrl?: string }[] | null;
  portal: { at: string; title: string; detail?: string; live?: boolean }[] | null;
  log: { at: string; text: string }[] | null;
  /** Vault memory threads ("Where it stands"): what each feature thread was left at. */
  memory?: { thread: string; line: string }[] | null;
  sources: StatusResponse["sources"];
}

async function withTimeout<T>(name: string, fn: () => Promise<T>, sources: StatusResponse["sources"], note?: string): Promise<T | null> {
  const fetchedAt = new Date().toISOString();
  try {
    const v = await Promise.race<T>([
      fn(),
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), SOURCE_TIMEOUT_MS)),
    ]);
    sources.push({ name, fetchedAt, ok: true, ...(note ? { note } : {}) });
    return v;
  } catch (e) {
    sources.push({ name, fetchedAt, ok: false, note: String((e as Error).message ?? e).slice(0, 120) });
    return null;
  }
}

function ts(x: unknown): string {
  const r = (x ?? {}) as Record<string, unknown>;
  for (const k of ["finishedAt", "completedAt", "endedAt", "updatedAt", "startedAt", "createdAt"]) {
    if (typeof r[k] === "string") return r[k] as string;
  }
  return new Date(0).toISOString();
}

export async function gatherProjectInputs(project: Project, since?: string): Promise<StatusInputs> {
  const now = new Date();
  const sinceIso = since ?? new Date(now.getTime() - DEFAULT_SINCE_DAYS * 86_400_000).toISOString();
  const sources: StatusResponse["sources"] = [];

  const [client, tasks, runs, approvals] = await Promise.all([
    withTimeout("client", () => store.clients.get(project.clientId), sources),
    withTimeout("tasks", () => store.tasks.find((t) => t.projectId === project.id), sources),
    withTimeout("runs", () => store.runs.find((r) => r.projectId === project.id), sources),
    withTimeout("approvals", () => store.approvals.find((a) => a.projectId === project.id && a.status === "pending"), sources),
  ]);

  const [commits, deploys, portal, log, memory] = await Promise.all([
    withTimeout("github", async () => {
      const { recentCommitLinesStrict } = await import("@/lib/friday/recentWork");
      const repos = projectRepos(project).filter((u) => parseGithubRepo(u));
      if (!repos.length) throw new Error("no repo linked");
      const r = await recentCommitLinesStrict([{ name: project.name, repoUrls: repos }], 15);
      // Every repo unreadable (gh unauthenticated, network) is a failed source, not an empty history.
      if (r.attempted > 0 && r.failedRepos.length === r.attempted) throw new Error(`GitHub unreachable (${r.failedRepos.join(", ")})`);
      return r.lines.filter((c) => c.date >= sinceIso).map((c) => ({ date: c.date, message: c.message }));
    }, sources),
    withTimeout("netlify", async () => {
      const { findNetlifySite, listNetlifyDeploys } = await import("@/lib/friday/workspace");
      const site = await findNetlifySite(project.netlifySiteId || project.deployUrl || project.name);
      if (!site) throw new Error("no site");
      const res = await listNetlifyDeploys(site.id, 3);
      if (!res.ok) throw new Error(res.error ?? "deploys failed");
      return res.deploys.map((d) => ({ id: d.id, state: d.state, branch: d.branch, createdAt: d.createdAt, errorMessage: d.errorMessage, deployUrl: d.deployUrl }));
    }, sources),
    withTimeout("portal", async () => {
      const { osClient, osEnabled } = await import("@/lib/friday/osClient");
      if (!osEnabled()) throw new Error("OS bridge disabled");
      const { osProjectMap } = await import("@/lib/friday/portalUpdates");
      const osId = (await osProjectMap()).get(project.id);
      if (!osId) throw new Error("not mirrored to the OS");
      const raw = await osClient.callTool("project_activity_list", { project_id: osId, limit: 20 });
      const rows = unwrapMcp(raw) as Array<{ event_type?: string; created_at?: string; payload?: Record<string, unknown> }>;
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => r.event_type === "milestone")
        .slice(0, 5)
        .map((r) => {
          const p = r.payload ?? {};
          const s = (p.sections ?? {}) as Record<string, unknown>;
          return {
            at: r.created_at ?? "",
            title: String(p.title ?? ""),
            detail: [s.impact, s.live_now].filter((x) => typeof x === "string" && x).join(" ") || (typeof p.detail === "string" ? p.detail.slice(0, 240) : undefined),
            live: typeof p.is_live === "boolean" ? p.is_live : undefined,
          };
        })
        .filter((x) => x.title && (!x.at || x.at >= sinceIso));
    }, sources),
    withTimeout("log", async () => {
      const root = config.vaultRoot;
      if (!root) throw new Error("no vault");
      const { promises: fs } = await import("node:fs");
      const path = await import("node:path");
      const slug = project.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";
      // Log files are named by the writer's LOCAL date (vaultWriter.todayISO). Using the UTC date here
      // missed every entry written after 8pm Eastern and read tomorrow's-UTC file that didn't exist yet.
      const { todayISO } = await import("@/lib/vaultWriter");
      const days = [0, 1].map((d) => todayISO(new Date(now.getTime() - d * 86_400_000)));
      const out: { at: string; text: string }[] = [];
      for (const day of days) {
        const file = path.join(root, "Agentic OS", "Projects", slug, "log", `${day}.md`);
        let text = "";
        try { text = await fs.readFile(file, "utf8"); } catch { continue; }
        for (const m of text.matchAll(/^### (\d{2}:\d{2}) · ([^·\n]+) · ([^\n]+)\n([\s\S]*?)(?=\n### |\s*$)/gm)) {
          // Local wall-clock → real instant, so it compares correctly with the UTC `since`.
          const local = new Date(`${day}T${m[1]}:00`);
          out.push({ at: Number.isNaN(local.getTime()) ? `${day}T${m[1]}` : local.toISOString(), text: `${m[3].trim()}: ${m[4].trim().split("\n")[0].slice(0, 160)}` });
        }
      }
      return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
    }, sources),
    withTimeout("memory", async () => {
      const root = config.vaultRoot;
      if (!root) return []; // no vault configured: nothing to read, not a failure
      const { promises: fs } = await import("node:fs");
      const path = await import("node:path");
      const { slugify, parseProjectMemory } = await import("@/lib/friday/vaultMemory");
      let text = "";
      try {
        text = await fs.readFile(path.join(root, "Agentic OS", "Projects", slugify(project.name), "memory.md"), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // no memory yet
        throw e; // unreadable memory must not look healthy
      }
      return Object.entries(parseProjectMemory(text).threads).map(([thread, line]) => ({ thread: thread.replace(/-[0-9a-f]{8}$/, ""), line }));
    }, sources),
  ]);

  return {
    now, since: sinceIso, project, client: client ?? undefined,
    tasks: tasks ?? [], runs: runs ?? [], approvals: approvals ?? [],
    commits, deploys, portal, log, memory, sources,
  };
}

function unwrapMcp(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

// ── Assembly (pure) ─────────────────────────────────────────────────────────

const strip = (s: string) => s.replace(/[\p{Extended_Pictographic}️‍]/gu, "").replace(/\s+/g, " ").trim();
const BLOCKED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["blocked", "waiting_on_client"]);

const HEALTH_SOURCES = new Set(["tasks", "runs", "approvals", "memory"]);

/** Vault memory threads left failed/blocked/stuck — blockers the board may already show as closed. */
export const memoryBlockers = (memory: StatusInputs["memory"]) => (memory ?? []).filter((m) => /^(failed|blocked|stuck)/.test(m.line));

export function deriveHealth(inp: Pick<StatusInputs, "tasks" | "runs" | "approvals" | "deploys" | "now" | "memory"> & { sources?: StatusResponse["sources"] }): StatusResponse["summary"]["health"] {
  // The inputs that detect blockers and failed runs come from the local store; if any of them
  // failed to load, "green" would just mean "no data". Say unknown instead.
  if (inp.sources?.some((s) => HEALTH_SOURCES.has(s.name) && !s.ok)) return "unknown";
  const dayAgo = inp.now.getTime() - 86_400_000;
  const failedRun = inp.runs.some((r) => r.status === "error" && new Date(ts(r)).getTime() >= dayAgo);
  const failedDeploy = inp.deploys?.[0]?.state === "error";
  const blocked = inp.tasks.some((t) => !isClosed(t.status) && t.status === "blocked") || memoryBlockers(inp.memory).length > 0;
  if (failedRun || failedDeploy || blocked) return "red";
  const waiting = inp.tasks.some((t) => !isClosed(t.status) && t.status === "waiting_on_client");
  const stale = (() => {
    const open = inp.tasks.filter((t) => !isClosed(t.status));
    if (!open.length) return false;
    const newest = Math.max(...open.map((t) => new Date(ts(t)).getTime()));
    return inp.now.getTime() - newest > 7 * 86_400_000;
  })();
  if (inp.approvals.length || waiting || stale) return "amber";
  return "green";
}

// Internal upkeep the owner never asked about: dependency sweeps, auto-QA rounds, fix rounds, run
// notes. Stage/health still count them (projectStage does its own CHORE scoping); the narrative
// surfaces do not.
const UPKEEP = /\[(?:Deps|QA|(?:Fix|Review|Rebase)(?:\s*R\d+)?)\]|weekly patch|patch sweep|patch bumps|^run notes\b|site health|health check|qa-e2e|failing checks|typecheck/i;
const isUpkeepTask = (t: Task) => CHORE.test(t.title ?? "") || UPKEEP.test(t.title ?? "");
const isUpkeepRun = (r: AgentRun, tasks: Task[]) => {
  const t = r.taskId ? tasks.find((x) => x.id === r.taskId) : undefined;
  return (t ? isUpkeepTask(t) : false) || UPKEEP.test(r.input.split("\n")[0]) || UPKEEP.test(r.summary ?? "");
};

export function assembleProjectStatus(inp: StatusInputs): StatusResponse {
  const { project, tasks: allTasks, runs: allRuns, approvals, now } = inp;
  const tasks = allTasks.filter((t) => !isUpkeepTask(t));
  const runs = allRuns.filter((r) => !isUpkeepRun(r, allTasks));
  const open = tasks.filter((t) => !isClosed(t.status));
  const blockedTasks = open.filter((t) => BLOCKED.has(t.status));
  const moving = open.filter((t) => !HOLDING_STAGES.has(t.status));
  const nextUp = open
    .filter((t) => t.status === "planning")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .slice(0, 5);
  const stage = engineeringStage(project, allTasks);
  const risk = projectRisk(allTasks, false);
  const health = deriveHealth(inp);

  const recent: StatusItem[] = [];
  for (const p of (inp.portal ?? []).filter((p) => !p.at || p.at >= inp.since)) recent.push({ when: p.at, headline: strip(p.title), detail: p.detail ? strip(p.detail) : undefined, source: "portal" });
  for (const r of runs.filter((r) => r.status === "done" && new Date(ts(r)) >= new Date(inp.since)).slice(0, 4)) {
    const link = r.artifacts?.find((a) => a.url)?.url;
    recent.push({ when: ts(r), headline: strip(r.summary || r.input.split("\n")[0]).slice(0, 140), link, source: "run" });
  }
  for (const c of (inp.commits ?? []).filter((c) => !UPKEEP.test(c.message) && !/^chore\b/i.test(c.message)).slice(0, 5)) {
    recent.push({ when: c.date, headline: strip(c.message.split("\n")[0]).replace(/\s*\(#\d+\)\s*$/, "").slice(0, 120), source: "git" });
  }
  for (const d of (inp.deploys ?? []).filter((d) => !d.createdAt || d.createdAt >= inp.since).slice(0, 1)) recent.push({ when: d.createdAt ?? "", headline: `Deploy ${d.state}${d.branch ? ` (${d.branch})` : ""}${d.errorMessage ? `: ${strip(d.errorMessage).slice(0, 100)}` : ""}`, link: d.deployUrl, source: "deploy" });
  for (const l of (inp.log ?? []).filter((l) => l.at >= inp.since.slice(0, l.at.length))) recent.push({ when: l.at, headline: strip(l.text).slice(0, 140), source: "log" });
  recent.sort((a, b) => b.when.localeCompare(a.when));
  const recentTop = dedupeHeadlines(recent).slice(0, 8);

  const openItems: StatusItem[] = [
    ...runs.filter((r) => r.status === "running" || r.status === "queued").map((r) => ({ when: ts(r), headline: `Running: ${strip(r.input.split("\n")[0]).slice(0, 120)}`, source: "run" as const })),
    ...moving.slice(0, 8).map((t) => ({ when: ts(t), headline: `${strip(t.title)} (${t.status.replace(/_/g, " ")})`, source: "task" as const })),
  ];
  const blocked: StatusItem[] = blockedTasks.map((t) => ({ when: ts(t), headline: `${strip(t.title)} — ${t.status === "waiting_on_client" ? "waiting on the client" : "blocked"}`, source: "task" }));
  // Vault memory knows about threads the board may already show as closed (a failed QA round, a
  // shepherd give-up). Surface those as blockers so the report says where work was actually left.
  for (const m of memoryBlockers(inp.memory).slice(0, 4)) {
    const when = m.line.match(/\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\)\s*$/);
    blocked.push({ when: when ? `${when[1]}T${when[2]}` : "", headline: strip(`${m.thread.replace(/-/g, " ")} — ${m.line.replace(/\s*\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)\s*$/, "")}`).slice(0, 200), source: "log" });
  }
  const nextUpItems: StatusItem[] = nextUp.map((t) => ({ when: ts(t), headline: strip(t.title), source: "task" }));
  const approvalsPending: StatusItem[] = approvals.map((a) => ({ when: ts(a), headline: `Needs your OK: ${strip(a.action)}`, detail: a.detail ? strip(a.detail).slice(0, 200) : undefined, source: "approval" }));

  const newest = recentTop[0];
  const healthWord = { green: "on track", amber: "needs attention", red: "has a problem", unknown: "status unknown" }[health];
  const headline = newest
    ? `${project.name} is in ${stage} and ${healthWord}. Latest: ${newest.headline}${newest.when ? ` (${ago(newest.when, now)})` : ""}.`
    : `${project.name} is in ${stage} and ${healthWord}. Nothing new since ${inp.since.slice(0, 10)}.`;

  return {
    ok: true,
    asOf: now.toISOString(),
    agent: "friday",
    subject: { type: "project", id: project.id, name: project.name, client: inp.client?.company ?? inp.client?.name },
    summary: { stage, status: `${project.status}${risk !== "low" ? `, risk ${risk}` : ""}`, health, headline },
    recent: recentTop,
    open: openItems,
    blocked,
    nextUp: nextUpItems,
    approvalsPending,
    sources: inp.sources,
  };
}

function dedupeHeadlines(items: StatusItem[]): StatusItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = norm(i.headline).slice(0, 60);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function ago(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (m < 2) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export async function buildProjectStatus(project: Project, since?: string): Promise<StatusResponse> {
  return assembleProjectStatus(await gatherProjectInputs(project, since));
}

// ── Portfolio ───────────────────────────────────────────────────────────────

export async function buildPortfolioStatus(since?: string): Promise<StatusResponse> {
  const now = new Date();
  const sinceIso = since ?? new Date(now.getTime() - DEFAULT_SINCE_DAYS * 86_400_000).toISOString();
  const projects = (await store.projects.find((p) => p.status === "active" && p.portalUpdates !== false));
  const statuses = await Promise.all(projects.map((p) => buildProjectStatus(p, sinceIso).catch(() => null)));
  return assemblePortfolio(statuses.filter((s): s is StatusResponse => !!s), now, sinceIso);
}

export function assemblePortfolio(statuses: StatusResponse[], now: Date, since: string): StatusResponse {
  const rank = { red: 0, amber: 1, green: 2, unknown: 3 } as const;
  const ordered = [...statuses].sort((a, b) => rank[a.summary.health] - rank[b.summary.health]);
  const recent: StatusItem[] = [];
  for (const s of ordered) for (const r of s.recent.slice(0, 2)) recent.push({ ...r, headline: `${s.subject.name}: ${r.headline}` });
  const worst = ordered[0]?.summary.health ?? "unknown";
  const reds = ordered.filter((s) => s.summary.health === "red").map((s) => s.subject.name);
  const ambers = ordered.filter((s) => s.summary.health === "amber").map((s) => s.subject.name);
  const headline = statuses.length
    ? `${statuses.length} active project${statuses.length === 1 ? "" : "s"}: ${reds.length ? `${reds.join(", ")} need${reds.length === 1 ? "s" : ""} attention now; ` : ""}${ambers.length ? `${ambers.join(", ")} ${ambers.length === 1 ? "has" : "have"} something waiting; ` : ""}${!reds.length && !ambers.length ? "all on track." : "the rest are on track."}`
    : "No active projects.";
  const sources: StatusResponse["sources"] = [];
  for (const s of ordered) for (const src of s.sources) sources.push({ ...src, name: `${s.subject.name}/${src.name}` });
  return {
    ok: true, asOf: now.toISOString(), agent: "friday",
    subject: { type: "portfolio", id: "portfolio", name: "All active projects" },
    summary: { status: `${statuses.length} active`, health: worst, headline },
    recent: recent.sort((a, b) => b.when.localeCompare(a.when)).slice(0, 12),
    open: ordered.flatMap((s) => s.open.slice(0, 2).map((i) => ({ ...i, headline: `${s.subject.name}: ${i.headline}` }))),
    blocked: ordered.flatMap((s) => s.blocked.map((i) => ({ ...i, headline: `${s.subject.name}: ${i.headline}` }))),
    nextUp: ordered.flatMap((s) => s.nextUp.slice(0, 1).map((i) => ({ ...i, headline: `${s.subject.name}: ${i.headline}` }))),
    approvalsPending: ordered.flatMap((s) => s.approvalsPending.map((i) => ({ ...i, headline: `${s.subject.name}: ${i.headline}` }))),
    sources: [...sources, { name: "window", fetchedAt: now.toISOString(), ok: true, note: `since ${since.slice(0, 10)}` }],
  };
}

// ── Prose ───────────────────────────────────────────────────────────────────

export type StatusChannel = "sms" | "voice" | "chat" | "email" | "web";

const CODE_OR_PATH = /#[0-9A-Fa-f]{3,8}\b|(?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|json|md|sql|css)\b/g;

export function renderStatusProse(sr: StatusResponse, opts: { channel: StatusChannel; now?: Date }): string {
  const now = opts.now ?? new Date(sr.asOf);
  const short = opts.channel === "sms" || opts.channel === "voice";
  const noLinks = opts.channel === "voice";
  const clean = (s: string) => strip(s).replace(CODE_OR_PATH, "").replace(/\s{2,}/g, " ").trim();
  const item = (i: StatusItem) => {
    const when = i.when ? ` (${ago(i.when, now)})` : "";
    const link = !noLinks && i.link ? ` ${i.link}` : "";
    return `- ${clean(i.headline)}${when}${link}`;
  };

  const okSources = sr.sources.filter((s) => s.ok);
  const badSources = sr.sources.filter((s) => !s.ok);
  const freshest = okSources.map((s) => `${s.name.split("/").pop()} ${ago(s.fetchedAt, now)}`).slice(0, short ? 2 : 5);
  const provenance = `As of ${fmtClock(now)} today${freshest.length ? `: ${freshest.join(", ")}` : ""}${badSources.length ? `; ${badSources.map((s) => s.name.split("/").pop()).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(", ")} unreachable` : ""}.`;

  const lines: string[] = [clean(sr.summary.headline), provenance];
  if (!short) {
    if (sr.recent.length) lines.push("Recent activity:", ...sr.recent.slice(0, 8).map(item));
    if (sr.blocked.length) lines.push("Blocked:", ...sr.blocked.slice(0, 6).map(item));
    if (sr.open.length) lines.push("In flight:", ...sr.open.slice(0, 6).map(item));
    if (sr.nextUp.length) lines.push("Next up:", ...sr.nextUp.slice(0, 4).map(item));
    if (sr.approvalsPending.length) lines.push("Waiting on your decision:", ...sr.approvalsPending.slice(0, 5).map((a) => `- ${clean(a.headline)}`));
    return lines.join("\n");
  }

  // SMS/voice: ≤ 6 lines and ≤ 600 chars. Answer and provenance first, then what needs them
  // (decisions, blockers) BEFORE recent activity, so the cap never hides the action items.
  if (sr.approvalsPending.length) lines.push("Waiting on you:", `- ${clean(sr.approvalsPending[0].headline)}`);
  if (sr.blocked.length) lines.push("Blocked:", ...sr.blocked.slice(0, lines.length >= 4 ? 1 : 2).map(item));
  if (sr.recent.length && lines.length < 5) lines.push("Recent:", ...sr.recent.slice(0, Math.max(0, 6 - lines.length - 1)).map(item));
  const capped: string[] = [];
  for (const l of lines) {
    if (capped.length >= 6) break;
    capped.push(l);
  }
  let out = capped.join("\n");
  while (out.length > 600 && capped.length > 2) { capped.pop(); out = capped.join("\n"); }
  if (out.length > 600) out = out.slice(0, 597).replace(/\s+\S*$/, "") + "...";
  return out;
}

function fmtClock(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
