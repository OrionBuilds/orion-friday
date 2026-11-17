// FRIDAY orchestrator — the plan → dispatch → track loop.
//
//   1. FRIDAY (planner) reads the operator's message + context → structured plan.
//   2. The plan is materialised: client/project/tasks created (dual-written + mirrored).
//   3. If dispatch is requested, each task's assigned agent runs — UNLESS it needs
//      approval (client-facing / destructive / spend), in which case an Approval is
//      queued for the operator instead of executing.
//   4. Everything is logged to the store, the Obsidian daily log, and the activity feed.
//
// Runs on Claude when available, else LM Studio — so the whole loop works offline.

import { store, newId, nowISO, logEvent } from "@/lib/persistence/store";
import { complete, completeWithMeta, completeJSON, defaultEngine, voiceEngine } from "@/lib/friday/engines";
import { startLive, endLive, applyClaudeEvent, applyCodexEvent, applyRawChunk, maybeSnapshot } from "@/lib/fridayLive";
import { registerProc, unregisterProc, isStopped } from "@/lib/ultracodeProcs";
import { plannerSystem, OWNER, OWNER_FIRST, AGENCY } from "@/lib/friday/persona";
import { seedAgents, getAgent, resolveAssignee, teamRoster, assigneeIds } from "@/lib/friday/agents";
import { approvalReason, shortCode } from "@/lib/friday/risk";
import { isRetainer } from "@/lib/friday/retainer";
import { selfHealEnabled, maxHealRounds, nextFixTitle, parseFixRound, qaAlreadyRanFor, fixRoundExistsFor, qaRoundTitle } from "@/lib/friday/qaHeal";
import { inheritLineage, authorityMode } from "@/lib/friday/authority";
import type { ApprovalFacts } from "@/lib/friday/approvalCopy";
import { buildSystemPrompt } from "@/lib/friday/promptAssembly";
import { findLibraryAgent } from "@/lib/friday/skillMatch";
import { deliveryCwd, repoDirName, isSelfSourceDir, isWorktreeDir, workspaceKindFor, taskRepoFor, taskWorktreeNames } from "@/lib/friday/delivery";
import { projectRepos } from "@/lib/friday/types";
import { createClient, updateClient, createProject, updateProject, createTask, updateTask, listClients, listProjects, listTasks, matchClient, matchProject, matchTask } from "@/lib/friday/repo";
import { appendFridayLog } from "@/lib/persistence/obsidian";
import { finalizeRun } from "@/lib/friday/deliverables";
import { verifyCodeRun, type VerifyResult } from "@/lib/friday/verify";
import { saveArtifact } from "@/lib/friday/artifacts";
import { recallBlock } from "@/lib/friday/memory";
import type { Agent, AgentRun, Approval, Client, Project, Task, Channel, TaskStatus, RequestOrigin } from "@/lib/friday/types";
import type { ScopeVerdict } from "@/lib/friday/authority";
import { DEFAULT_STAGE, TASK_STAGES, isClosed } from "@/lib/friday/stages";

interface PlannerClient {
  name: string; email?: string; phone?: string; company?: string; jobTitle?: string;
  addressLine?: string; city?: string; state?: string; postalCode?: string;
}
interface PlannerProject {
  name: string; clientName?: string; description?: string; stack?: string;
  startDate?: string; targetEndDate?: string; budget?: number; fromMeeting?: boolean;
}
// An operation on EXISTING data (status query / task update / dispatch / send report) — distinct
// from the create-client/project/tasks materialization path.
interface PlannerAction {
  kind: "status" | "update_task" | "dispatch_task" | "send_report" | "deploy" | "schedule" | "notify_client" | "reschedule" | "cancel" | "deliver_doc" | "schedule_recurring" | "set_away" | "offboard";
  away?: boolean;        // set_away: true = going away, false = back/available
  untilISO?: string;     // set_away: when the owner expects to be back (ISO date/datetime)
  reason?: string;       // set_away: short client-safe reason ("traveling")
  project?: string;  // project name (fuzzy)
  client?: string;   // client name (fuzzy)
  task?: string;     // task title (fuzzy)
  status?: string;   // target stage/word for update_task
  title?: string;    // meeting title (schedule)
  startISO?: string; // meeting start, ISO-8601 (schedule)
  endISO?: string;   // meeting end, ISO-8601 (schedule)
  durationMin?: number; // meeting length if endISO omitted (schedule)
  findSlot?: boolean; // schedule: pick the first free slot on startISO's day instead of a fixed time
  message?: string;  // what to tell the client (notify_client)
  clearCache?: boolean; // deploy: force a cache-clearing rebuild (purge stale CDN entries)
  // schedule_recurring — set up a RECURRING agent task (not a calendar meeting)
  freq?: "daily" | "weekly" | "monthly";
  dayOfWeek?: number;   // 0=Sun … 6=Sat (weekly)
  dayOfMonth?: number;  // 1-31 (monthly)
  atHour?: number;      // 0-23 (local); default 9
  assignee?: string;    // agent role, e.g. "seo" | "qa" | "debug" | "support"
  taskTitle?: string;   // the recurring task's title, e.g. "SEO audit"
}
interface PlannerOutput {
  reply: string;
  intent: string;
  client: PlannerClient | null;
  project: PlannerProject | null;
  tasks: { title: string; assignee: string; risk?: Task["risk"] }[];
  dispatch: boolean;
  action?: PlannerAction | null;
}

export interface OrchestrateResult {
  reply: string;
  intent: string;
  client?: Client;
  project?: Project;
  tasks: Task[];
  runs: AgentRun[];
  approvals: Approval[];
}

// Compact "owner/repo" from a GitHub URL for context.
function ghShort(url: string): string {
  const m = url.replace(/\.git$/, "").match(/github\.com\/([^/]+\/[^/]+)/i);
  return m ? m[1] : url;
}

async function buildContext(projectId?: string): Promise<string> {
  const clients = await listClients();
  const allProjects = await store.projects.all();
  // Rounded to the nearest 5 min, not the true instant: LM Studio/llama.cpp caches by matching
  // token PREFIX, and this line sits at the top of a ~7000-token context block (client/project
  // list + the tool catalog) that's otherwise identical call to call. A second-precision timestamp
  // here means every inbound message pays a full ~35s cold prefill instead of the ~2s a cache hit
  // gives once the prefix matches (measured live 2026-08-23: 35.3s time-to-first-token on a cold
  // prefix vs 2.3s on a cache hit, same 7000-token prompt, on a sibling agent's identical pattern).
  // 5-minute granularity is still accurate enough for "book it Tuesday 2pm"-style scheduling math.
  const now = new Date(Math.floor(Date.now() / 300_000) * 300_000);
  const lines: string[] = [
    `Current date/time: ${now.toString()} (use this to compute ISO times for scheduling).`,
  ];
  if (!clients.length) {
    lines.push("Known clients: (none yet)");
  } else {
    // List each client WITH their existing projects — including each project's ATTACHED SOURCE
    // (local folder or GitHub repo) + stack — so FRIDAY reuses them (no duplicates) AND knows it
    // can already reach the code: a dispatched agent runs directly in that folder/repo.
    lines.push("Existing clients and their projects (reuse these — do not duplicate):");
    for (const c of clients.slice(0, 40)) {
      // Archived (offboarded) projects drop out of the planning snapshot — they're closed work (2.4).
      const projs = allProjects.filter((p) => p.clientId === c.id && p.status !== "archived");
      if (!projs.length) { lines.push(`- ${c.name} — (no projects yet)`); continue; }
      lines.push(`- ${c.name}:`);
      for (const p of projs.slice(0, 20)) {
        const bits: string[] = [];
        if (p.workspaceDir) bits.push(`local folder ${p.workspaceDir}`);
        const repos = projectRepos(p);
        if (repos.length) bits.push(`${repos.length > 1 ? "repos" : "repo"} ${repos.map(ghShort).join(", ")}`);
        if (p.stack) bits.push(`stack: ${p.stack}`);
        // "code: yes/no" is the reachability signal the planner keys off (replaces the old
        // defensive "never say you can't access" prose). Status included for at-a-glance triage.
        const hasCode = Boolean(p.workspaceDir) || repos.length > 0;
        lines.push(`    • ${p.name} (${p.status}) — code: ${hasCode ? "yes" : "no"}${bits.length ? `; ${bits.join("; ")}` : ""}`);
      }
    }
  }
  if (projectId) {
    const project = await store.projects.get(projectId);
    if (project) {
      const tasks = await store.tasks.find((t) => t.projectId === projectId);
      lines.push(`Active project (the board you're viewing): ${project.name} (${project.status}) — ${tasks.length} tasks.`);
    }
  }
  return lines.join("\n");
}

// Coding roles that are allowed to modify files + run git/network (branch/commit/push/PR).
// qa/review stay read-only analysts. `designer` builds front-end code, so it writes too.
const WRITE_ROLES = ["architect", "dev", "devops", "debug", "designer"];

// Self-edit gate (0.1 stopgap for the 2.1 deploy pipeline). Default OFF: a dispatched write-role agent
// whose working dir would be FRIDAY's OWN source can silently modify the running system — including the
// approval/gate logic that supervises agents. `SELF_EDIT_ENABLED=true` is a manual override only.
function selfEditEnabled(): boolean {
  const v = process.env.SELF_EDIT_ENABLED;
  return v === "true" || v === "1";
}

// Roles whose work legitimately takes minutes (coding, audits, deep research, tool-heavy Hermes runs,
// browser automation). `automation` (Antigravity) drives multi-step browser jobs → needs the long cap.
const LONG_ROLES = [...WRITE_ROLES, "qa", "review", "seo", "research-qa", "marketing", "sales", "automation"];
// Roles that need NETWORK access even if they don't write a repo — e.g. SEO/research must fetch live
// pages, and Codex's read-only sandbox blocks the network. Grants danger-full-access (writes+network).
const NET_ROLES = [...WRITE_ROLES, "seo", "research-qa"];

// What the agent should PRODUCE, by role — so deliverables (PR link, client PDF) exist to capture.
// Sanctioned external-research tools available on PATH once the owner runs Agent Reach's
// installer (see docs/AGENT-REACH.md) — zero-config only, no login/cookies. Free to use for
// pulling in reference material (a linked design doc, a GitHub issue, a YouTube walkthrough)
// while working a task; not a substitute for reading the actual project code.
const RESEARCH_TOOLS_NOTE =
  " For external reference material: `curl https://r.jina.ai/<url>` returns a page's clean text "
  + "(works for any URL), `yt-dlp` extracts YouTube transcripts, and `gh repo view owner/repo` reads "
  + "public GitHub repos. Any of these may be unavailable if not installed — fall back gracefully.";

// Worm guard for the agents themselves (2026-09-28): the tip-rewrite worm was "fixed" by FRIDAY's
// agents as ordinary code changes, silently. Seeing it is a stop-and-report event, never a fix.
export const MALWARE_STOP_NOTE =
  "\n\nSECURITY — READ FIRST: if you see obfuscated JavaScript (e.g. a `global[...]=` assignment followed by long `_0x…` identifier soup, code hidden after a long run of spaces in a build config), a VS Code task with `\"runOn\": \"folderOpen\"`, a \"font\" file that is really text/script (e.g. `public/fonts/fa-solid-900.woff2`), or a `.gitignore` that ignores `config.bat`: STOP. Do NOT build, run, install, fix, delete, commit or push anything. Reply with a line starting `MALWARE SUSPECTED:` naming the files, and nothing else.";

function deliverableGuidance(role: Agent["role"], task?: Pick<Task, "prUrl" | "prHeadRef">, taskBranch?: string): string {
  // Every role gets the stop-and-report instruction — any of them may be handed a project checkout.
  return deliverableGuidanceBody(role, task, taskBranch) + MALWARE_STOP_NOTE;
}

function deliverableGuidanceBody(role: Agent["role"], task?: Pick<Task, "prUrl" | "prHeadRef">, taskBranch?: string): string {
  if (WRITE_ROLES.includes(role) && task?.prUrl && task.prHeadRef) {
    // A round on an EXISTING pull request (PR shepherd): the worktree is already on that branch.
    return "\n\nYou have full write access to the working directory, which is a git worktree on branch `" + task.prHeadRef + "` of the existing pull request " + task.prUrl + ". ACTUALLY DO THE WORK — don't just describe it:\n"
      + "1. Do NOT create a new branch and do NOT open a new pull request.\n"
      + "2. Make the code changes with your Edit/Write tools and run the project's own checks (typecheck/build/tests).\n"
      + "3. `git add -A && git commit -m \"<clear message>\"`\n"
      + "4. Before pushing, confirm `git rev-parse --abbrev-ref @{upstream}` prints `origin/" + task.prHeadRef + "`; then `git push origin HEAD:" + task.prHeadRef + "`.\n"
      + "End your reply with the pull request URL (" + task.prUrl + ") on its own line. If any git/gh step fails, report the exact error."
      + RESEARCH_TOOLS_NOTE;
  }
  if (WRITE_ROLES.includes(role) && taskBranch) {
    // A fresh task in its own worktree, already on a new branch cut from the default branch.
    return "\n\nYou have full write access to the working directory, which is a git worktree already checked out on the new branch `" + taskBranch + "` (cut from the latest default branch). ACTUALLY DO THE WORK — don't just describe it:\n"
      + "1. Do NOT create or switch branches — you are already on `" + taskBranch + "`.\n"
      + "2. Make the code changes with your Edit/Write tools and run the project's own checks (typecheck/build/tests).\n"
      + "3. `git add -A && git commit -m \"<clear message>\"`\n"
      + "4. `git push -u origin HEAD`\n"
      + "5. `gh pr create --fill` (open a pull request against the default branch).\n"
      + "Before step 5: if \"What happened before (from memory)\" lists an OPEN pull request for this thread, do NOT open a second one — push your commits to that PR's branch instead and report its URL.\n"
      + "End your reply with the PR URL on its own line. If any git/gh step fails, report the exact error."
      + RESEARCH_TOOLS_NOTE;
  }
  if (WRITE_ROLES.includes(role)) {
    return "\n\nYou have full write access to the working directory. ACTUALLY DO THE WORK — don't just describe it:\n"
      + "1. `git checkout -b friday/<short-slug>`\n"
      + "2. Make the code changes with your Edit/Write tools.\n"
      + "3. `git add -A && git commit -m \"<clear message>\"`\n"
      + "4. `git push -u origin friday/<short-slug>`\n"
      + "5. `gh pr create --fill` (open a pull request against the default branch).\n"
      + "End your reply with the PR URL on its own line. If any git/gh step fails, report the exact error."
      + RESEARCH_TOOLS_NOTE;
  }
  if (["qa", "review", "seo", "research-qa"].includes(role)) {
    return "\n\nYou can fetch live URLs (network is available — use curl or a quick script). Produce a clear, self-contained markdown report suitable for the client: a one-line summary at the top, then findings (each with a severity), then recommended next steps. Use headings and bullet lists."
      + RESEARCH_TOOLS_NOTE;
  }
  return "";
}

// Findings from earlier runs on THIS task's lineage (root task + its [QA]/[Fix]/[Review]/[Rebase]
// rounds), used only when the thread has no vault memory yet. Never an unrelated project run: the
// old project-wide "newest QA report" handed a fix run an unrelated dependency-sweep report.
async function priorFindings(task: Task, currentRunId: string): Promise<string> {
  const rootId = task.sourceTaskId ?? task.id;
  const lineage = new Set((await store.tasks.find((t) => t.id === rootId || t.sourceTaskId === rootId)).map((t) => t.id));
  lineage.add(task.id);
  const runs = (await store.runs.find((r) => !!r.taskId && lineage.has(r.taskId) && r.id !== currentRunId && r.status === "done" && !!r.result))
    .sort((a, b) => (b.startedAt < a.startedAt ? -1 : 1));
  if (!runs.length) return "";
  const report = runs.find((r) => ["qa", "review", "debug"].includes(r.agentId)) ?? runs[0];
  const history = runs.slice(0, 5).map((r) => `- ${r.agentId}: ${(r.summary || r.result || "").slice(0, 100)}`).join("\n");
  return `\n\nPrior findings to address (from the ${report.agentId} report on this piece of work):\n${(report.result || "").slice(0, 6000)}\n\nEarlier runs on this piece of work:\n${history}`;
}

/** The open PR this task's thread already has (from its lineage tasks or the thread's vault memory). */
async function adoptThreadPr(task: Task, project: Project): Promise<{ prUrl: string; prHeadRef: string } | null> {
  const rootId = task.sourceTaskId ?? task.id;
  const lineage = await store.tasks.find((t) => (t.id === rootId || t.sourceTaskId === rootId) && !!t.prUrl);
  const candidates = [...new Set([
    ...lineage.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).map((t) => t.prUrl!),
    ...(await (await import("@/lib/friday/vaultMemory")).threadPrs(project, task)).reverse(),
  ])];
  const { prReadiness } = await import("@/lib/friday/prGate");
  for (const url of candidates) {
    const r = await prReadiness(url).catch(() => null);
    if (r && r.state === "OPEN" && r.headRefName) return { prUrl: url, prHeadRef: r.headRefName };
  }
  return null;
}

/** True unless GitHub positively says the PR is merged or closed (an unreadable PR counts as open). */
export async function taskPrStillOpen(prUrl: string, readiness?: (url: string) => Promise<{ state?: string } | null>): Promise<boolean> {
  const read = readiness ?? (await import("@/lib/friday/prGate")).prReadiness;
  const r = await read(prUrl).catch(() => null);
  return !r || !r.state || r.state === "OPEN";
}

/** Best-effort vault memory write (never throws, never blocks a run's outcome). */
async function remember(input: Parameters<typeof import("@/lib/friday/vaultMemory").recordOutcome>[0]): Promise<void> {
  try { await (await import("@/lib/friday/vaultMemory")).recordOutcome(input); } catch { /* memory is best-effort */ }
}

// Create the run record + mark the task in-progress. Synchronous so a caller gets a run id back
// immediately (the heavy work happens in executeRun, which can run in the background).
async function startRun(agent: Agent, task: Task, project: Project | null, channel?: Channel): Promise<AgentRun> {
  const run: AgentRun = {
    id: newId(),
    agentId: agent.id,
    projectId: task.projectId,
    taskId: task.id,
    channel: channel ?? task.origin ?? "web",
    input: task.title,
    status: "running",
    startedAt: nowISO(),
  };
  await store.runs.insert(run);
  await updateTask(task.id, { status: "in_progress", runId: run.id });
  await logEvent("dispatch.start", { agent: agent.id, task: task.title }, { runId: run.id, projectId: task.projectId });
  return run;
}

// Do the actual agent work for an already-started run: build the prompt, call the engine, capture
// deliverables, and (on completion) notify. Long-running — call it in the background for async dispatch.
async function executeRun(run: AgentRun, agent: Agent, task: Task, project: Project | null): Promise<AgentRun> {
  let runCwd: string | undefined; // for the failure path's worm scan
  try {
    // OS agent settings (Settings → AI Agents): FRIDAY or this specialist paused/disabled, or the
    // specialist's own daily budget / call cap spent → refuse before anything else (no worktree, no
    // scan, no engine). Every run path (dispatchTask, auto-QA/fix, approval-approved, PR shepherd)
    // reaches here.
    const { settingsRunRefusal } = await import("@/lib/friday/usage");
    const settingsRefusal = await settingsRunRefusal(agent);
    if (settingsRefusal) {
      await updateTask(task.id, { status: "blocked" });
      await logEvent("agent_settings.run_refused", { task: task.title, agent: agent.id, reason: settingsRefusal }, { level: "warn", runId: run.id, projectId: task.projectId });
      await remember({ project, task, kind: "run", title: task.title, outcome: "blocked", summary: `${agent.name} run refused: ${settingsRefusal}`, leftOff: "Stopped before anything ran.", next: "Re-dispatch once the OS agent settings allow it." });
      const { notifyOwner } = await import("@/lib/friday/notify");
      await notifyOwner({ kind: "agent_settings", priority: "normal", text: `Held "${task.title.slice(0, 60)}": ${settingsRefusal}`, dedupeKey: `agentsettings:${agent.id}:${new Date().toISOString().slice(0, 10)}` }).catch(() => {});
      return (await store.runs.update(run.id, { status: "error", error: settingsRefusal, endedAt: nowISO() })) ?? run;
    }
    // Client identity + owner-uploaded doc context (2026-07-19). Agents previously saw only project
    // name/stack — they didn't even know WHO the client was, and client-scoped doc memories never
    // reached runs (the recall below is project-scoped by design; docs are client-level).
    const client = project?.clientId ? await store.clients.get(project.clientId) : null;
    const clientLine = client
      ? `Client: ${client.name}${client.company ? ` (${client.company})` : ""}${client.status === "past" ? " — a PAST client; this work draws on historical materials" : ""}.\n`
      : "";
    const context = project ? `${clientLine}Project: ${project.name}. ${project.description ?? ""} Stack: ${project.stack ?? "n/a"}.` : "";
    // Effective system prompt = the agent's own prompt + pinned + auto-selected skills,
    // injected so EVERY engine (Claude/Codex/Hermes/LM Studio) can use the imported skills.
    const system = await buildSystemPrompt(agent, `${task.title} ${task.description ?? ""}`);
    // Coding agents run inside the real client repo (cloned/pulled per project) so they can
    // actually read/edit/git/deploy — non-coding roles run in their default scratch.
    // One thread, one pull request: a write-role run on a task whose lineage (or thread memory)
    // already has an OPEN PR works on that PR's branch instead of opening a second one.
    if (project && WRITE_ROLES.includes(agent.role) && !(task.prUrl && task.prHeadRef)) {
      const adopted = await adoptThreadPr(task, project).catch(() => null);
      if (adopted) {
        task = { ...task, prUrl: adopted.prUrl, prHeadRef: adopted.prHeadRef };
        await updateTask(task.id, { prUrl: adopted.prUrl, prHeadRef: adopted.prHeadRef }).catch(() => {});
        await logEvent("delivery.pr_adopted", { task: task.title, pr: adopted.prUrl }, { runId: run.id, projectId: task.projectId });
      } else if (task.prUrl && !task.prHeadRef && (await taskPrStillOpen(task.prUrl))) {
        // The task already has a PR that is (or may still be) open, but its branch couldn't be read.
        // Falling through would pick a fresh task worktree and open a SECOND PR — refuse instead.
        await updateTask(task.id, { status: "blocked" });
        await logEvent("delivery.run_refused_pr_unresolved", { task: task.title, role: agent.role, pr: task.prUrl }, { level: "warn", runId: run.id, projectId: task.projectId });
        await remember({ project, task, kind: "run", title: task.title, outcome: "blocked", summary: `${agent.name} run refused: ${task.prUrl} exists but its branch couldn't be retrieved.`, leftOff: "Blocked before any work started.", next: "Retry once GitHub is reachable, or close the PR if it is abandoned." });
        return (await store.runs.update(run.id, { status: "error", error: "PR exists but its branch couldn't be retrieved — refused rather than opening a second PR.", endedAt: nowISO() })) ?? run;
      }
    }
    const cwd = await deliveryCwd(agent.role, project, task);
    runCwd = cwd;
    // A run that needs an isolated worktree (fresh single-repo task or PR round) must never proceed
    // without one: a write-role agent with no cwd would edit wherever the engine defaults to.
    const needsWorktree = workspaceKindFor(agent.role, project, task);
    if (!cwd && (needsWorktree === "task-worktree" || needsWorktree === "pr-worktree")) {
      await updateTask(task.id, { status: "blocked" });
      await logEvent("delivery.run_refused_no_worktree", { task: task.title, role: agent.role, kind: needsWorktree }, { level: "warn", projectId: task.projectId });
      await remember({ project, task, kind: "run", title: task.title, outcome: "blocked", summary: `${agent.name} run refused: no isolated git worktree could be created.`, leftOff: "Blocked before any work started.", next: "Retry once the repository can be fetched." });
      return (await store.runs.update(run.id, { status: "error", error: "Could not create the isolated git worktree for this run — refused before execution (never runs in the owner's checkout).", endedAt: nowISO() })) ?? run;
    }
    // WORM GUARD (2026-09-28): scan the checkout BEFORE anything runs in it — an agent run, its build,
    // tests, a QA/review/rebase round. The tip-rewrite worm hides a payload in build configs that
    // executes on `next build`, and FRIDAY's rounds ran it on this box while her agents quietly
    // "fixed" it. A hit (or a repo already blocked for one) stops the run cold: nothing is built,
    // fixed, committed or pushed, the worktree is deleted, and the owner is emailed.
    if (project) {
      const { guardWorkspace } = await import("@/lib/friday/wormGuard");
      const guard = await guardWorkspace({ cwd, repoUrls: [...(task.prUrl ? [task.prUrl] : []), ...projectRepos(project)], source: "run", projectId: project.id, taskId: task.id });
      if (guard.kind !== "clean") {
        // blocked → waits for the owner; unavailable (the check itself failed) → back in the queue to retry.
        await updateTask(task.id, { status: guard.kind === "blocked" ? "blocked" : DEFAULT_STAGE });
        await logEvent(guard.kind === "blocked" ? "security.run_refused_malware" : "security.run_refused_scan_unavailable", { task: task.title, role: agent.role, reason: guard.reason }, { level: "warn", runId: run.id, projectId: task.projectId });
        if (guard.kind === "blocked") await remember({ project, task, kind: "run", title: task.title, outcome: "blocked", summary: `${agent.name} run refused: ${guard.reason}`, leftOff: "Stopped before anything ran. Nothing was built, changed, committed or pushed.", next: "Waiting for the owner to confirm the repo is clean (\"resume <repo>\")." });
        return (await store.runs.update(run.id, { status: "error", error: guard.reason, endedAt: nowISO() })) ?? run;
      }
    }
    const repos = project ? projectRepos(project) : [];
    const onPrBranch = !!(task.prUrl && task.prHeadRef && cwd); // a shepherd round in a PR-branch worktree
    // A fresh single-repo task runs in its own worktree on a pre-named branch (never the owner's checkout).
    const onTaskBranch = !onPrBranch && !!cwd && isWorktreeDir(cwd) && workspaceKindFor(agent.role, project, task) === "task-worktree";
    const taskBranch = onTaskBranch && project ? taskWorktreeNames(taskRepoFor(project)!, task, project.branchPrefix).branch : undefined;
    const isLocal = !!project?.workspaceDir && !onPrBranch && !onTaskBranch; // a real on-disk folder (not a cloned repo)
    // Self-edit is about WHOSE code this is, not where it runs: FRIDAY's own project stays gated even
    // though its runs now happen in a worktree rather than the live source folder.
    const selfSrc = isSelfSourceDir(project?.workspaceDir) || (isLocal && isSelfSourceDir(cwd));
    if (cwd) await store.runs.update(run.id, { cwd }).catch(() => {});
    // SELF-EDIT HARD GATE (0.1, defense-in-depth). dispatchTask blocks the common path, but auto-QA/fix
    // and approval-approved runs reach here via runAgentOnTask/dispatchRunAsync WITHOUT passing through
    // it. A write-role run inside FRIDAY's own source must never touch the engine unless SELF_EDIT_ENABLED.
    if (selfSrc && WRITE_ROLES.includes(agent.role) && !selfEditEnabled()) {
      await updateTask(task.id, { status: "blocked" });
      await logEvent("selfedit.blocked_run", { task: task.title, role: agent.role }, { level: "warn", projectId: task.projectId });
      await remember({ project, task, kind: "run", title: task.title, outcome: "blocked", summary: "Refused: this is FRIDAY's own source and self-edit is off.", next: "Needs the owner or CLARA." });
      return (await store.runs.update(run.id, { status: "error", error: "Self-edit gated (SELF_EDIT_ENABLED off) — run refused before execution.", endedAt: nowISO() })) ?? run;
    }
    // Per-task spend breaker (2.2): a task that has already burned its model-call/cost budget across
    // prior runs is paused rather than re-run — the backstop if a fix/QA cycle keeps re-dispatching it.
    const { taskOverBudget, taskSpend } = await import("@/lib/friday/usage");
    if (await taskOverBudget(task.id)) {
      const spend = await taskSpend(task.id);
      await updateTask(task.id, { status: "blocked" });
      await logEvent("spend.task_capped", { task: task.title, ...spend }, { level: "warn", projectId: task.projectId });
      await remember({ project, task, kind: "run", title: task.title, outcome: "blocked", summary: `Paused: the task hit its budget (${spend.calls} runs, $${spend.costUsd.toFixed(2)}).`, leftOff: "Something may be looping.", next: "Review before re-running." });
      const { notifyOwner } = await import("@/lib/friday/notify");
      await notifyOwner({ kind: "spend", priority: "critical", text: `Paused "${task.title.slice(0, 50)}" — it hit its budget (${spend.calls} runs, $${spend.costUsd.toFixed(2)}). Something may be looping. Review before re-running.`, dedupeKey: `taskspend:${task.id}` }).catch(() => {});
      return (await store.runs.update(run.id, { status: "error", error: "Task over model-call/cost budget — paused.", endedAt: nowISO() })) ?? run;
    }
    const workspaceLine = !cwd ? ""
      : onPrBranch
        ? `\nWorking directory: ${cwd} (a git worktree on branch ${task.prHeadRef} of ${task.prUrl} — read/edit files and use git here; push to that same branch).`
      : onTaskBranch
        ? `\nWorking directory: ${cwd} (a fresh git worktree of the project's repo on branch ${taskBranch}, cut from the latest default branch — read/edit files and use git here).`
      : isLocal
        ? `\nWorking directory: ${cwd} (a LOCAL project folder — read/edit files directly here).`
          + (selfSrc ? `\nNOTE: this is FRIDAY's OWN source and the dev server is running from it — avoid changes that would crash the server mid-task; prefer small, restart-safe edits.` : "")
      : repos.length > 1
        ? `\nWorking directory: ${cwd} — this project spans ${repos.length} git repos, one per subfolder:\n`
          + repos.map((u) => `  • ${repoDirName(u)}/ → ${u}`).join("\n")
          + `\nRead/edit files and run git inside the relevant repo's subfolder.`
        : `\nWorking directory: ${cwd} (the project's git repo — read/edit files and use git here).`;
    // Feed a fix/coding task the actual prior QA/regression findings (they live in runs.json, not on
    // disk in the repo, so the agent can't find them otherwise). Only for WRITE roles — injecting
    // prior findings into a QA/review agent biases its fresh assessment.
    // Memory first (vault memory contract v1): what happened before on THIS piece of work — earlier
    // runs, QA/review findings and what was declined, open PRs, where it was left off — plus the
    // project's other live threads. Every role reads it (QA sees what was asked and already tried).
    const { recallFor } = await import("@/lib/friday/vaultMemory");
    const threadMemory = project ? await recallFor({ project, task, prUrl: task.prUrl }).catch(() => "") : "";
    const memoryBlock = threadMemory ? `\n\n## What happened before (from memory)\n${threadMemory}` : "";
    // Fallback for work that has no memory yet: findings scoped to THIS task's lineage only — never
    // an unrelated project run (write roles only; prior findings would bias a fresh QA).
    const findings = (!threadMemory && project && WRITE_ROLES.includes(agent.role)) ? await priorFindings(task, run.id) : "";
    // Semantically-relevant past runs/decisions for this project (beyond the freshest findings above).
    const memory = project ? await recallBlock(`${task.title} ${task.description ?? ""}`, { projectId: task.projectId, limit: 3 }, "Relevant past work on this project you can build on (conversation notes are what was SAID — a promise in a reply is not proof it shipped; trust the board and commits over chat)").catch(() => "") : "";
    // Owner-uploaded client documents (proposals/plans/strategy) — deterministic direct block,
    // brief-preferred, 8k budget. Direct injection beats similarity recall for authoritative context;
    // chunk recall still covers the long tail in the reply brains. "" when no ready docs or
    // FRIDAY_DOC_CONTEXT=off. Never breaks a run.
    const docsBlock = client ? await (await import("@/lib/friday/docs/context")).clientDocsBlock(client.id, { budget: 8000 }).catch(() => "") : "";
    // Project knowledge (agent-maintained notes about the codebase), behind FRIDAY_PROJECT_KNOWLEDGE=on.
    // Best-effort and read-only: any miss or failure is "" and the run proceeds without it.
    let knowledgeText = "";
    if (project) {
      try {
        const pk = await import("@/lib/friday/projectKnowledge");
        if (pk.knowledgeEnabled()) {
          const res = await pk.buildKnowledgeBlock(
            { localProjectId: project.id, taskTitle: task.title, taskDescription: task.description, isPrRound: onPrBranch },
            await pk.liveKnowledgeDeps(cwd && onPrBranch ? () => pk.gitChangedFiles(cwd) : undefined),
          );
          knowledgeText = res.text;
          void logEvent("knowledge.injected", { runId: run.id, notes: res.slugs, chars: res.chars, ...(res.reason ? { reason: res.reason } : {}) }, { runId: run.id, projectId: task.projectId });
        }
      } catch { /* never break a run over notes */ }
    }
    if (docsBlock) void logEvent("docs.context_injected", { clientId: client!.id, chars: docsBlock.length }, { runId: run.id, projectId: task.projectId });
    // Live viewer: build an in-memory picture of what this agent is doing as it streams. The engine
    // only streams (claude stream-json / codex --json) when these callbacks are present + the kill
    // switch is on; otherwise it's the old buffered path. Never let the viewer break the run.
    // Worm gate: any agent working in a checkout gets FRIDAY's pre-commit/pre-push hooks and PATH shims
    // for npm/npx/pnpm/yarn/bun, so a build or push of worm-infected code is refused mid-run, not just
    // caught afterwards. If the gate can't be set up, the run doesn't start (back to the queue).
    let gateEnv: Record<string, string> | undefined;
    if (cwd) {
      try { const g = await import("@/lib/friday/wormGate"); gateEnv = g.wormGateEnv(await g.ensureWormGate()); }
      catch (e) {
        await updateTask(task.id, { status: DEFAULT_STAGE });
        await logEvent("security.worm_gate_unavailable", { task: task.title, error: String(e).slice(0, 200) }, { level: "warn", runId: run.id, projectId: task.projectId });
        return (await store.runs.update(run.id, { status: "error", error: `worm gate could not be set up (${String(e).slice(0, 120)}) — not running unguarded`, endedAt: nowISO() })) ?? run;
      }
    }
    const eng = agent.engine ?? defaultEngine();
    const live = startLive(run.id, agent.role, eng);
    const applyEv = eng === "codex" ? applyCodexEvent : applyClaudeEvent;
    const { text: result, served } = await completeWithMeta({
      engine: agent.engine,
      system,
      prompt: `${context}${workspaceLine}\n\nTask: ${task.title}\n${task.description ?? ""}${memoryBlock}${knowledgeText}${findings}${memory}${docsBlock}\n\nComplete this task. Be concrete and concise.${deliverableGuidance(agent.role, task, taskBranch)}`,
      cwd,
      extraEnv: gateEnv,
      taskId: task.id, projectId: task.projectId, agentRole: agent.role, // cost attribution (2.2)
      write: NET_ROLES.includes(agent.role), // coding + SEO/research get file-write + git/network
      // Analysis/tool-using roles (audits, research, deep review) get 10 min; quick text roles keep a
      // short cap. Coding roles get 20: a real bug fix (investigate → branch → edit → test → PR) ran
      // out mid-work at 10 on 2026-09-14, right after diagnosing it. A capped run now FAILS (see
      // runCapError) instead of passing its partial transcript off as done.
      timeoutMs: WRITE_ROLES.includes(agent.role) ? 1_200_000 : LONG_ROLES.includes(agent.role) ? 600_000 : 240_000,
      runId: run.id,
      onEvent: (ev) => { try { applyEv(live, ev); void maybeSnapshot(run.id); } catch { /* viewer */ } },
      onChunk: (t) => { try { applyRawChunk(live, t); void maybeSnapshot(run.id); } catch { /* viewer */ } },
      onSpawn: (child) => registerProc(run.id, child),
    });
    unregisterProc(run.id);
    // G2 — fail loud on tool-less fallback. A WRITE role that silently fell back to LM Studio (no
    // tools/filesystem/git) can only produce prose describing work it never did. Do NOT mark it done
    // or emit a (hallucinated) PR artifact — flag it, bounce the task back, and alert the owner.
    if (served.fallback && served.engine === "lmstudio" && agent.engine !== "lmstudio" && WRITE_ROLES.includes(agent.role)) {
      const msg = `${agent.engine} unavailable — fell back to LM Studio (no tools), so this coding task was NOT executed.`;
      const patch = {
        status: "error" as const, error: msg, result,
        intendedEngine: served.intended, servedEngine: served.engine, servedModel: served.model, fellBack: true,
        endedAt: nowISO(),
      };
      await store.runs.update(run.id, patch);
      await updateTask(task.id, { status: DEFAULT_STAGE });
      await logEvent("dispatch.toolless_fallback", { agent: agent.id, intended: served.intended, task: task.title }, { level: "warn", runId: run.id, projectId: task.projectId });
      await remember({ project, task, kind: "run", title: task.title, outcome: "failed", summary: msg, leftOff: "Nothing was changed.", next: `Re-run once ${agent.engine} is available.` });
      const { notifyOwner } = await import("@/lib/friday/notify");
      await notifyOwner({ kind: "run.error", priority: "normal", text: `"${task.title.slice(0, 50)}" not executed — ${agent.engine} down, no-tools fallback. Check ${agent.engine} auth.`, dedupeKey: `toolless:${run.id}` }).catch(() => {});
      endLive(run.id, "error"); await maybeSnapshot(run.id, true);
      return { ...run, ...patch };
    }
    // An agent that saw the worm must stop and say MALWARE SUSPECTED (deliverableGuidance) — treat
    // that exactly like a scanner hit: block the repo, delete the worktree, email the owner, and do
    // NOT finalize, verify or QA anything it may have produced.
    if (project) {
      const { scanAgentOutput } = await import("@/lib/friday/wormScan");
      const reported = scanAgentOutput(result);
      if (reported.length) {
        const { reportWormHit } = await import("@/lib/friday/wormGuard");
        const { describeCheckout } = await import("@/lib/friday/wormScan");
        const co = cwd ? await describeCheckout(cwd) : {};
        const entry = await reportWormHit({ repoUrl: co.remote ?? task.prUrl ?? projectRepos(project)[0], root: cwd, branch: co.branch, sha: co.sha, hits: reported, source: "agent-report", worktreeDir: cwd, projectId: project.id, taskId: task.id });
        const msg = `malware-suspected: ${agent.name} reported malware in ${entry.key} — stopped; nothing was finalized, verified or merged.`;
        await store.runs.update(run.id, { status: "error", error: msg, result, endedAt: nowISO(), intendedEngine: served.intended, servedEngine: served.engine, servedModel: served.model, fellBack: served.fallback });
        endLive(run.id, "error"); await maybeSnapshot(run.id, true);
        await updateTask(task.id, { status: "blocked" });
        await remember({ project, task, kind: "run", title: task.title, outcome: "blocked", summary: msg, leftOff: "The agent stopped on suspected malware.", next: "Waiting for the owner to confirm the repo is clean (\"resume <repo>\")." });
        return { ...run, status: "error", error: msg, result, endedAt: nowISO() };
      }
    }
    // Scan what the agent left behind BEFORE anything is finalized (artifacts, feed, notifications,
    // client updates) — e.g. it merged an infected base in. A hit here is final: nothing is filed.
    if (project && cwd) {
      const { guardWorkspace } = await import("@/lib/friday/wormGuard");
      const post = await guardWorkspace({ cwd, repoUrls: [...(task.prUrl ? [task.prUrl] : []), ...projectRepos(project)], source: "verify", projectId: project.id, taskId: task.id });
      if (post.kind !== "clean") {
        const msg = post.kind === "blocked" ? post.reason : `post-run ${post.reason}; nothing was finalized — rerun once the scan can complete.`;
        await store.runs.update(run.id, { status: "error", error: msg, result, endedAt: nowISO(), intendedEngine: served.intended, servedEngine: served.engine, servedModel: served.model, fellBack: served.fallback });
        endLive(run.id, "error"); await maybeSnapshot(run.id, true);
        await updateTask(task.id, { status: post.kind === "blocked" ? "blocked" : DEFAULT_STAGE });
        await logEvent("security.finalize_refused", { task: task.title, kind: post.kind, reason: post.reason }, { level: "warn", runId: run.id, projectId: task.projectId });
        if (post.kind === "blocked") await remember({ project, task, kind: "run", title: task.title, outcome: "blocked", summary: msg, leftOff: "The run finished, but its checkout carries the worm — nothing was finalized, built or merged.", next: "Waiting for the owner to confirm the repo is clean (\"resume <repo>\")." });
        return { ...run, status: "error", error: msg, result, endedAt: nowISO() };
      }
    }
    const patch = {
      status: "done" as const, result, endedAt: nowISO(),
      intendedEngine: served.intended, servedEngine: served.engine, servedModel: served.model, fellBack: served.fallback,
    };
    await store.runs.update(run.id, patch); // persist result FIRST so a live poll that catches the
    endLive(run.id, "done"); await maybeSnapshot(run.id, true); // done-flip already sees the result
    await updateTask(task.id, { status: "internal_review" });
    const finished = { ...run, ...patch };
    // Derive deliverables (PDF/PR/summary), mirror to feed + Obsidian, notify the origin channel.
    // Fires its own dispatch.done log. Best-effort — never fails the completed run.
    try { await finalizeRun(finished, task, project, agent); }
    catch (e) { await logEvent("dispatch.finalize_error", { error: String(e) }, { level: "warn", runId: run.id, projectId: task.projectId }); }
    // PROVE it works: run the project's own typecheck/build/tests in the checkout, attach the
    // evidence + a confidence score to the run. RED checks become a hard fail the auto-QA gate
    // bounces to Revisions. Best-effort — a verify crash never un-completes the run.
    let verify: VerifyResult | null = null;
    try { verify = await verifyCodeRun(project, agent, finished, task, cwd && isWorktreeDir(cwd) ? { dirs: [{ url: task.prUrl ?? (project ? taskRepoFor(project) : null) ?? cwd, dir: cwd }] } : {}); }
    catch (e) { await logEvent("dispatch.verify_error", { error: String(e) }, { level: "warn", runId: run.id, projectId: task.projectId }); }
    // The pre-build scan inside verifyCodeRun found the worm (e.g. the agent merged an infected base
    // in): the build was skipped, the repo is blocked and the owner emailed. No QA, no merge.
    if (verify?.malware) {
      await store.runs.update(run.id, { status: "error", error: verify.malware }).catch(() => {});
      // An incomplete scan is transient: back to the queue. Malware found: blocked for the owner.
      await updateTask(task.id, { status: verify.malwareKind === "unavailable" ? DEFAULT_STAGE : "blocked" });
      await logEvent("security.verify_refused_malware", { task: task.title, reason: verify.malware }, { level: "warn", runId: run.id, projectId: task.projectId });
      await remember({ project, task, kind: "run", title: task.title, outcome: "blocked", summary: verify.malware, leftOff: "Stopped before the build ran.", next: "Waiting for the owner to confirm the repo is clean (\"resume <repo>\")." });
      return { ...finished, status: "error", error: verify.malware };
    }
    if (verify) {
      try {
        const patchV: Partial<AgentRun> = {
          confidence: verify.confidence,
          verification: { ran: verify.ran, passed: !verify.hardFail, checks: verify.checks.map((c) => ({ name: c.name, ok: c.ok })) },
        };
        if (verify.ran) {
          const cur = await store.runs.get(run.id);
          const art = await saveArtifact(run.id, { kind: "summary", label: "verification", ext: ".md", mime: "text/markdown", bytes: Buffer.from(verify.evidenceMarkdown, "utf8") });
          patchV.artifacts = [...(cur?.artifacts ?? []), art];
        }
        await store.runs.update(run.id, patchV);
        await logEvent("dispatch.verified", { task: task.title, ran: verify.ran, hardFail: verify.hardFail, confidence: verify.confidence, checks: verify.checks.map((c) => `${c.name}:${c.ok ? "pass" : "fail"}`) }, { level: verify.hardFail ? "warn" : "info", runId: run.id, projectId: task.projectId });
      } catch (e) { await logEvent("dispatch.verify_persist_error", { error: String(e) }, { level: "warn", runId: run.id, projectId: task.projectId }); }
    }
    // Delivery autopilot: a completed dev run auto-triggers a QA pass (fire-and-forget so it doesn't
    // block this response); QA routes the task to Client Review or opens a fix task. Executed
    // verification is passed through so a hard fail bounces WITHOUT spending a QA LLM call.
    void maybeAutoQA(task, project, agent, verify).catch(() => {});
    return finished;
  } catch (e) {
    unregisterProc(run.id);
    const stopped = isStopped(run.id);
    endLive(run.id, stopped ? "stopped" : "error"); await maybeSnapshot(run.id, true);
    const patch = { status: (stopped ? "cancelled" : "error") as "cancelled" | "error", error: String(e), endedAt: nowISO() };
    await store.runs.update(run.id, patch);
    // A failed or stopped run may have died on the worm gate (a shim/hook refused infected code, then
    // the agent errored or timed out). Scan what it left before requeueing: a hit blocks the repo,
    // emails the owner, and keeps the task blocked instead of letting it retry into the same code.
    if (project && runCwd) {
      const { guardWorkspace } = await import("@/lib/friday/wormGuard");
      const post = await guardWorkspace({ cwd: runCwd, repoUrls: [...(task.prUrl ? [task.prUrl] : []), ...projectRepos(project)], source: "verify", projectId: project.id, taskId: task.id })
        .catch((): { kind: "unavailable"; reason: string } => ({ kind: "unavailable", reason: "scan crashed" }));
      if (post.kind === "blocked") {
        await updateTask(task.id, { status: "blocked" });
        await logEvent("security.failed_run_malware", { task: task.title, reason: post.reason, error: String(e).slice(0, 200) }, { level: "warn", runId: run.id, projectId: task.projectId });
        await remember({ project, task, kind: "run", title: task.title, outcome: "blocked", summary: `${agent.name} run failed and its checkout carries the worm: ${post.reason}`, leftOff: "Nothing was finalized, built or merged.", next: "Waiting for the owner to confirm the repo is clean (\"resume <repo>\")." });
        return { ...run, ...patch };
      }
    }
    await updateTask(task.id, { status: DEFAULT_STAGE });
    if (stopped) { await logEvent("dispatch.stopped", { agent: agent.id }, { level: "warn", runId: run.id, projectId: task.projectId }); return { ...run, ...patch }; }
    await logEvent("dispatch.error", { agent: agent.id, error: String(e) }, { level: "error", runId: run.id, projectId: task.projectId });
    await remember({ project, task, kind: "run", title: task.title, outcome: "failed", summary: `${agent.name} run failed: ${String(e).slice(0, 400)}`, leftOff: "The run errored; any partial changes are on the task's branch, not merged.", next: "Retry or investigate the error." });
    // Always tell the owner a run failed (successes already push; failures were silent).
    const { notifyOwner } = await import("@/lib/friday/notify");
    await notifyOwner({ kind: "run.error", text: `"${task.title.slice(0, 50)}" failed (${agent.id}): ${String(e).slice(0, 140)}`, dedupeKey: `runerr:${run.id}` }).catch(() => {});
    return { ...run, ...patch };
  }
}

// SYNC full run (start → await execute → completed run). Use where the caller needs the RESULT now
// (the auto-QA gate reads the QA verdict to decide pass/fail).
async function runAgentOnTask(agent: Agent, task: Task, project: Project | null, channel?: Channel): Promise<AgentRun> {
  const run = await startRun(agent, task, project, channel);
  return executeRun(run, agent, task, project);
}

// ASYNC dispatch: start the run, run the agent in the BACKGROUND, and return the "running" stub
// immediately — so an SMS/HTTP caller never waits minutes on a slow agent. The result is delivered
// via finalizeRun's notify-back + the board/feed poll. Errors surface via the run-error alert.
export async function dispatchRunAsync(agent: Agent, task: Task, project: Project | null, channel?: Channel): Promise<AgentRun> {
  const run = await startRun(agent, task, project, channel);
  // GAP-D (2026-07-23): opt-in detached child-process execution. Isolates agent-run OOM
  // from the Next process. When FRIDAY_DETACHED_RUNS=1, spawn the run in a child; on any
  // spawn failure fall back to in-process so a bad env var never silently drops tasks.
  const { detachedRunsEnabled, spawnDetachedRun } = await import("@/lib/friday/detachedRun");
  if (detachedRunsEnabled()) {
    const spawned = await spawnDetachedRun(run.id);
    if (spawned) return run;
    // Fallthrough to in-process — spawnDetachedRun already logged the reason.
  }
  void executeRun(run, agent, task, project).catch(() => {});
  return run;
}

/**
 * GAP-D (2026-07-23): standalone entry-point for detached run-executor scripts. Loads the
 * run's agent/task/project + calls executeRun. Idempotent-safe: returns early if the run
 * is already in a terminal state (defends against a manual re-invoke).
 */
export async function runOne(runId: string): Promise<void> {
  const run = await store.runs.get(runId);
  if (!run) throw new Error(`runOne: run ${runId} not found`);
  if (run.status !== "running") {
    await logEvent("dispatch.runOne.skipped", { runId, status: run.status }, { level: "warn", runId }).catch(() => {});
    return;
  }
  if (!run.taskId) throw new Error(`runOne: run ${runId} has no taskId`);
  const task = await store.tasks.get(run.taskId);
  if (!task) throw new Error(`runOne: task ${run.taskId} not found`);
  const project = task.projectId ? await store.projects.get(task.projectId) : null;
  const agent = await getAgent(run.agentId);
  if (!agent) throw new Error(`runOne: agent ${run.agentId} not found`);
  await executeRun(run, agent, task, project ?? null);
}

// Pick the agent to run a task: the planner's assignee, unless it defaulted to the generic
// "pm" bucket AND a library specialist clearly fits better — then delegate to that imported
// agent (so FRIDAY can reach the whole imported library by capability).
async function pickAgent(task: Task): Promise<Agent | null> {
  const assigned = await getAgent(task.assignee);
  const text = `${task.title} ${task.description ?? ""}`;
  // The generic PM bucket always tries the imported specialist library first (low bar). A specific
  // builtin keeps its assignment unless a library agent is a VERY strong domain match.
  if (assigned && assigned.id === "pm") {
    const lib = await findLibraryAgent(text, { minScore: 2.0 });
    if (lib) return lib;
  } else if (assigned && assigned.source === "builtin") {
    // Never downgrade a write-capable builtin (dev/devops/debug/architect/designer) to an imported
    // "custom"-role agent: custom agents aren't in WRITE_ROLES, so the swap silently strips file/git
    // access and the coding task can't actually execute. Keep the write-capable builtin.
    if (WRITE_ROLES.includes(assigned.role)) return assigned;
    const lib = await findLibraryAgent(text, { minScore: 3.5 });
    if (lib) return lib;
  }
  return assigned;
}

// State check (owner rule 2026-07-19): before asking the owner for work, answer "has this already been
// done or asked?" from what exists — similar tasks on the same board + matching recent commits on the
// project's repo(s). Live proof of the failure mode this kills: "Block July 20" and the phone-footer
// fix sat as pending approvals while their commits were already on the Initech repo. Advisory, never a
// decision: the note rides the approval so the OWNER can reject stale asks in one glance. Best-effort
// and timeboxed — a gh outage degrades to the task-similarity half, never blocks the queue.
async function approvalStateNote(task: Task): Promise<string> {
  try {
    const parts: string[] = [];
    const { findDuplicateTask, commitMatchesTitle } = await import("@/lib/friday/dedup");
    const siblings = (await store.tasks.find((t) => t.projectId === task.projectId && t.id !== task.id));
    const match = findDuplicateTask(task.title, siblings);
    if (match) {
      const when = match.task.updatedAt?.slice(0, 10) ?? "recently";
      parts.push(match.kind === "recent_done"
        ? `similar task "${match.task.title}" completed ${when}`
        : `similar task already on the board: "${match.task.title}" (${match.task.status})`);
    }
    const project = await store.projects.get(task.projectId);
    if (project) {
      const { recentCommitLines } = await import("@/lib/friday/recentWork");
      const commits = await Promise.race([
        recentCommitLines([project]),
        new Promise<[]>((r) => setTimeout(() => r([]), 8_000)),
      ]).catch(() => [] as Array<{ date: string; message: string }>);
      for (const c of commits.filter((c) => commitMatchesTitle(task.title, c.message)).slice(0, 3)) {
        parts.push(`commit ${c.date} "${c.message}"`);
      }
    }
    return parts.length ? `State check: ${parts.join(" · ")} — reject this if it's already covered.` : "State check: clean.";
  } catch {
    return ""; // advisory only — never fail an approval over it
  }
}


// `facts` carries the structured basis for the owner's copy. When a client asked for this, the caller
// has their words in scope and should pass them (see clientChannel.ts) — the copy is only as specific
// as what reaches here. Without facts we degrade honestly to an internal_task description.
// The grounded scope verdict for a task that came from a client Request — what decideAutonomy keys
// on for client-origin work. "unknown" (gates) when the task has no Request or the row is gone.
export async function taskScopeVerdict(task: Task): Promise<ScopeVerdict> {
  if (!task.requestId) return "unknown";
  const req = await store.requests.get(task.requestId).catch(() => null);
  if (!req) return "unknown";
  return req.scopeVerdict ?? req.scope ?? "unknown";
}

async function queueApproval(task: Task, agent: Agent, facts?: ApprovalFacts, opts: { selfEdit?: boolean } = {}): Promise<Approval> {
  // Duplicate-ping guard (owner rule 2026-07-19): a pending approval already standing for this task
  // IS the ask — return it instead of minting a second row + second email for the same decision.
  const dup = (await store.approvals.find((a) => a.status === "pending" && a.taskId === task.id))[0];
  if (dup) {
    await logEvent("approval.duplicate_suppressed", { taskId: task.id, existing: dup.id, task: task.title }, { projectId: task.projectId });
    return dup;
  }
  // Delegated Authority — origin-aware (2026-09): WHO asked decides. owner/CLARA/scheduler-origin work
  // is Tier 1 (auto); client-origin work is Tier 1 only inside the approved scope; money text, critical
  // risk and the self-edit gate floor to Tier 3 for every origin. shadow (default) = stamp + log only;
  // active = Tier 1/2 take the approve click below. (autonomy_policy=legacy restores the Wave-1 table.)
  const { evaluateAuthority, inferOrigin } = await import("@/lib/friday/authority");
  const origin: RequestOrigin = task.requestOrigin ?? inferOrigin(task);
  const scope: ScopeVerdict = origin === "client" ? await taskScopeVerdict(task) : "unknown";
  const authority = await evaluateAuthority({
    actionClass: "task_dispatch", risk: task.risk, projectId: task.projectId,
    origin, scope: origin === "client" ? scope : undefined,
    // title + details (+ the composed description, which quotes the client's own words) — the money
    // guard must see everything, since under Tier 1 no human reads any of it before dispatch.
    text: [task.title, task.details, task.description].filter(Boolean).join("\n"),
    selfEdit: opts.selfEdit,
  });
  const stateNote = await approvalStateNote(task);
  const approval: Approval = {
    id: newId(),
    taskId: task.id,
    projectId: task.projectId,
    action: `${agent.name} → ${task.title}`, // the UI label + ack string; NOT the owner-facing copy
    detail: [task.description, stateNote].filter(Boolean).join("\n\n"),
    risk: task.risk,
    status: "pending",
    requestedAt: nowISO(),
    facts,
    stateNote: stateNote || undefined,
    authorityTier: authority.mode === "off" ? undefined : authority.tier,
    authorityMode: authority.mode === "off" ? undefined : authority.mode,
    authorityReason: authority.mode === "off" ? undefined : authority.reason,
    requestOrigin: origin,
    scopeVerdict: origin === "client" ? scope : undefined,
    idempotencyKey: (await import("@/lib/friday/idempotency")).computeIdempotencyKey({
      taskId: task.id, action: `${agent.name} → ${task.title}`,
    }),
  };
  await store.approvals.insert(approval);
  await updateTask(task.id, { status: "blocked" });
  await logEvent("approval.queued", { task: task.title, risk: task.risk, authorityTier: approval.authorityTier, authorityMode: approval.authorityMode, requestOrigin: origin, scopeVerdict: approval.scopeVerdict }, { projectId: task.projectId });

  // SHADOW: record the would-have-auto decision for the /api/friday/authority report; change nothing.
  if (authority.wouldAuto && authority.mode === "shadow") {
    await logEvent(
      "authority.shadow_auto",
      { id: approval.id, tier: authority.tier, reason: authority.reason, action: approval.action.slice(0, 140) },
      { projectId: task.projectId },
    ).catch(() => {});
  }
  // ACTIVE: Tier 1/2 take the approve click through the SAME decide path a human uses (mutex, no
  // double dispatch). Returns before the notify push below — the owner gets a "done" note instead of an
  // approval request: Tier 2 at normal priority, Tier 1 as a low-priority (digest-batched) line.
  if (authority.wouldAuto && authority.mode === "active") {
    await logEvent("authority.auto_approved", { id: approval.id, tier: authority.tier, reason: authority.reason, requestOrigin: origin }, { projectId: task.projectId }).catch(() => {});
    const decided = await decideApproval(approval.id, "approved", { source: "web" });
    void (async () => {
      try {
        const { notifyOwner } = await import("@/lib/friday/notify");
        await notifyOwner({
          kind: "authority auto", priority: authority.tier === 1 ? "low" : "normal",
          text: `Done autonomously (Tier ${authority.tier}, ${authority.reason}): ${approval.action.slice(0, 160)}`,
          dedupeKey: `authority-auto:${approval.id}`,
        });
      } catch { /* best-effort */ }
    })();
    return decided ?? approval;
  }

  // RAISE the ask in the OS approval queue — the ONLY authority for it (audit gap 9, contract §3).
  // Synchronous with retries: the ask counts as raised only once the hub row exists; a failed raise
  // is retried on every bridge tick (osApprovalsBridge.raisePendingAsks). Sits AFTER the
  // active-authority lane on purpose — auto-approved rows were never a question for the owner.
  // The OS sends the ONE owner notification for the ask; FRIDAY sends none of its own.
  await (await import("@/lib/friday/osApprovalsBridge")).raiseApproval(approval);

  // No FRIDAY-side approval notification (contract §3): the OS sends exactly one per ask.

  // (The critical-risk phone call that used to fire here is gone — owner rule 2026-09-24: FRIDAY
  // never phones the owner. A critical approval is still an email they can reply to, and it shows in
  // CLARA's brief as a question.)
  return approval;
}

// Queue the owner-approval for an already-created task WITHOUT dispatching it — used for
// client-originated requests, which must wait for the owner's OK before ANY agent runs. The owner
// releases it with "approve #<code>" (→ decideApproval → dispatch). Distinct from dispatchTask, which
// only gates high-risk/external-effect work and otherwise runs immediately.
//
// Pass `facts` whenever a client actually asked for this — a task id alone can't tell the owner who
// wants what, and the flattened title/description can't be un-flattened here.
export async function requestApprovalForTask(taskId: string, facts?: ApprovalFacts): Promise<Approval | null> {
  const task = await store.tasks.get(taskId);
  if (!task) return null;
  const agent = (await pickAgent(task)) ?? (await getAgent(task.assignee)) ?? (await getAgent("pm"));
  if (!agent) return null;
  return queueApproval(task, agent, facts);
}

// Queue owner approval for a client EMAIL reply FRIDAY drafted (a commitment). The draft only sends
// on "approve #<code>" (→ decideApproval → sendDraft); "reject #<code>" discards it.
export async function queueEmailApproval(input: {
  draftId: string; account: "owner" | "friday"; clientName: string; summary: string;
  projectId?: string; clientId?: string; body?: string; dedupeRef?: string;
  // Wave-2 Track B (2026-07-30): set when this draft is a recurring client-facing FORMAT
  // (weekly_update / client_notify / meeting_followup). Feeds the first-of-kind-then-auto
  // registry: a human approve grants the format; granted formats ride Tier 2 (auto-send under
  // active authority). Leave absent for ad-hoc replies — those stay hard Tier 3.
  formatKind?: string;
  // Origin-aware autonomy (2026-09): who this send is FOR. "scheduler" for FRIDAY's own timed formats
  // (weekly update, stall check-in, delivered note, meeting follow-up, welcome); "client" for a reply
  // to a client's ask — then `scope` says whether every ask in it was inside the approved scope.
  requestOrigin?: RequestOrigin;
  scope?: ScopeVerdict;
}): Promise<Approval> {
  // Duplicate-ping guard (Wave-1, mirror of queueApproval's taskId guard): a pending approval for
  // the same Gmail draft — or the same originating event via the caller's stable dedupeRef (e.g.
  // ingest's `meet:<conferenceRecord>`) — IS the ask. Return it instead of minting a second row +
  // second email for the same decision (the 5-duplicate-Riley-Example queue).
  //
  // 2026-08-20: that guard alone only caught the SAME event being reprocessed — it never asked
  // "does this client already have an unresolved ask of this same format, regardless of which
  // event spawned it?" A new meeting -> new conferenceRecord -> new dedupeRef sailed straight
  // past it, so 8 separate meeting_followup approvals for Riley Example piled up over 8 days
  // while none were ever resolved. Format-stamped drafts (weekly_update/client_notify/
  // meeting_followup) presume at most one pending instance per client at a time — that's the
  // whole premise of the format registry's "first-of-kind-then-auto" design — so also match on
  // (clientId, formatKind) regardless of dedupeRef/draftId.
  const dup = (await store.approvals.find((a) =>
    a.status === "pending" && (
      a.emailDraftId === input.draftId ||
      (!!input.dedupeRef && a.dedupeRef === input.dedupeRef) ||
      (!!input.formatKind && !!input.clientId && a.formatKind === input.formatKind && a.emailClientId === input.clientId)
    ),
  ))[0];
  if (dup) {
    await logEvent("approval.duplicate_suppressed", { emailDraftId: input.draftId, dedupeRef: input.dedupeRef, formatKind: input.formatKind, existing: dup.id, client: input.clientName }, { projectId: input.projectId });
    return dup;
  }
  const project = input.projectId ? await store.projects.get(input.projectId) : null;
  const facts: ApprovalFacts = {
    kind: "email_reply",
    clientName: input.clientName,
    subject: input.summary,
    // The draft body was already a parameter and already persisted — it just never reached the
    // owner. It IS the commitment they're being asked to approve, so it belongs in the copy.
    draftExcerpt: input.body?.slice(0, 300),
    projectName: project?.name,
  };
  // Authority stamp — origin-aware (2026-09): a scheduler/owner-origin send is Tier 1; a client-origin
  // reply is Tier 1 only when every ask in it was in scope; money language in the body floors to Tier 3.
  // (Legacy policy: ad-hoc replies hard Tier 3; format-stamped drafts ride the format registry.)
  // Sending still passes the client_comms master gate inside decideApproval, whatever the tier.
  const { evaluateAuthority } = await import("@/lib/friday/authority");
  const authority = await evaluateAuthority({
    actionClass: "email_reply", risk: "medium", projectId: input.projectId, clientId: input.clientId, formatKind: input.formatKind,
    origin: input.requestOrigin, scope: input.scope, text: `${input.summary}\n${input.body ?? ""}`,
  });
  const approval: Approval = {
    id: newId(),
    projectId: input.projectId,
    action: `Email reply to ${input.clientName} — ${input.summary}`.slice(0, 140),
    detail: "FRIDAY drafted a reply that makes a commitment. Approve to send it from her account (you CC'd), or reject to discard.",
    risk: "medium",
    status: "pending",
    emailDraftId: input.draftId,
    emailAccount: input.account,
    emailClientId: input.clientId,
    emailBody: input.body,
    dedupeRef: input.dedupeRef,
    formatKind: input.formatKind,
    requestedAt: nowISO(),
    facts,
    authorityTier: authority.mode === "off" ? undefined : authority.tier,
    authorityMode: authority.mode === "off" ? undefined : authority.mode,
    authorityReason: authority.mode === "off" ? undefined : authority.reason,
    requestOrigin: authority.origin ?? input.requestOrigin,
    scopeVerdict: input.requestOrigin === "client" ? (input.scope ?? "unknown") : undefined,
    idempotencyKey: (await import("@/lib/friday/idempotency")).computeIdempotencyKey({
      emailDraftId: input.draftId, emailAccount: input.account, emailClientId: input.clientId,
    }),
  };
  await store.approvals.insert(approval);
  await logEvent("approval.queued", { email: input.clientName, summary: input.summary, formatKind: input.formatKind, authorityTier: approval.authorityTier, requestOrigin: approval.requestOrigin, scopeVerdict: approval.scopeVerdict }, { projectId: input.projectId });

  // ── Format lane (Wave-2 Track B) ─────────────────────────────────────────
  // SHADOW: a granted format would have auto-sent — record it for the /api/friday/authority
  // report, change nothing (the row still queues pending, mirroring queueApproval's semantics).
  if (authority.wouldAuto && authority.mode === "shadow") {
    await logEvent(
      "authority.shadow_auto",
      { id: approval.id, tier: authority.tier, reason: authority.reason, action: approval.action.slice(0, 140) },
      { projectId: input.projectId },
    ).catch(() => {});
  }
  // ACTIVE: an auto-eligible send (origin policy: owner/scheduler-origin, or an in-scope client reply;
  // legacy: a granted format) takes the approve click through the SAME decide path a human uses —
  // decideApproval sends the Gmail draft (owner CC'd) exactly as if the owner replied "approve", and it is
  // decideApproval that enforces the client_comms master gate (off ⇒ the draft is discarded, not sent).
  if (authority.wouldAuto && authority.mode === "active") {
    await store.approvals.update(approval.id, { autoApproved: true }).catch(() => {});
    await logEvent("authority.auto_approved", { id: approval.id, tier: authority.tier, reason: authority.reason, via: authority.formatGrantId ? "format-grant" : "origin-policy", requestOrigin: approval.requestOrigin }, { projectId: input.projectId }).catch(() => {});
    const decided = await decideApproval(approval.id, "approved", { source: "web" });
    if (authority.formatGrantId) {
      const { recordAutoSend } = await import("@/lib/friday/formatRegistry");
      await recordAutoSend(authority.formatGrantId).catch(() => {});
    }
    // Auto + tell the owner (digest-friendly note, not an approval ask): Tier 2 normal, Tier 1 low.
    void (async () => {
      try {
        const { notifyOwner } = await import("@/lib/friday/notify");
        await notifyOwner({
          kind: "authority auto", priority: authority.tier === 1 ? "low" : "normal",
          text: `Sent autonomously (${authority.reason}): ${approval.action.slice(0, 160)}`,
          dedupeKey: `authority-auto:${approval.id}`,
        });
      } catch { /* best-effort */ }
    })();
    return decided ?? approval;
  }

  // Raise in the OS queue (the authority) — genuinely-new pending rows only: the dup guard above
  // already returned for re-asks, and the format-grant auto lane just returned for auto-sent rows.
  await (await import("@/lib/friday/osApprovalsBridge")).raiseApproval(approval);

  // No FRIDAY-side approval notification (contract §3): the OS sends exactly one per ask.
  return approval;
}

// Queue the approval for an in-process Netlify PRODUCTION deploy. The build only ever fires through
// decideApproval (which re-verifies the row, then runs deployNetlify) — a human "approve #<code>", or,
// since 2026-09, the origin-aware authority taking that click itself: an owner/CLARA/scheduler-origin
// deploy (or an in-scope client one) is Tier 1 under ACTIVE authority and ships without waiting. Every
// other case (shadow/off, client-origin outside scope, money text, critical) queues for the owner.
/**
 * Tier-3 merge (client out-of-scope, money/contract text, critical risk): the PR shepherd asks
 * instead of merging. The row rides the same approval rail as everything else — the approval email
 * and CLARA's plain-language decisions — and, when approved, decideApprovalInner hands the PR back
 * to the shepherd with authority satisfied. One pending row per PR.
 */
export async function queueMergeApproval(
  project: Project,
  pr: { url: string; number: number; owner: string; repo: string; title: string; headSha?: string },
  task: Task | null,
  reason: string,
): Promise<Approval | null> {
  const dup = (await store.approvals.find((a) => a.status === "pending" && a.mergePrUrl === pr.url))[0];
  if (dup) return null;
  const facts: ApprovalFacts = {
    kind: "internal_task",
    taskTitle: `Merge ${pr.owner}/${pr.repo}#${pr.number} — ${pr.title.slice(0, 80)}`,
    taskDescription: `Merge and release "${pr.title.slice(0, 120)}" on ${project.name}. Checks and review comments are clear; I'm asking because ${reason}.`,
    projectName: project.name,
    agentName: "FRIDAY",
    risk: task?.risk ?? "medium",
  };
  const approval: Approval = {
    id: newId(),
    projectId: project.id,
    taskId: task?.id,
    action: `Merge ${pr.owner}/${pr.repo}#${pr.number}: ${pr.title.slice(0, 90)}`.slice(0, 140),
    detail: `Approve to merge and release this pull request; reject to hold it. Asked because ${reason}.`,
    risk: task?.risk ?? "medium",
    status: "pending",
    mergePrUrl: pr.url,
    mergeHeadSha: pr.headSha,
    requestedAt: nowISO(),
    facts,
    authorityTier: 3,
    authorityMode: (() => { const m = authorityMode(); return m === "off" ? undefined : m; })(),
    authorityReason: reason,
    requestOrigin: task?.requestOrigin,
  };
  await store.approvals.insert(approval);
  await logEvent("approval.queued", { merge: pr.url, reason }, { projectId: project.id });
  // Raise in the OS queue (the authority) — synchronously. The merge ask used to reach the OS only
  // via a once-per-boot back-mirror (globex-fl#7: asked 15:14, in the OS at 22:45) plus a separate
  // critical text to the owner; now the OS row is the ask and the OS sends its ONE notification.
  await (await import("@/lib/friday/osApprovalsBridge")).raiseApproval(approval);
  return approval;
}

export async function queueDeployApproval(
  project: Project,
  opts: { clearCache?: boolean; origin?: RequestOrigin; scope?: ScopeVerdict; taskText?: string } = {},
): Promise<Approval> {
  const what = opts.clearCache ? "cache-clearing production deploy" : "production deploy";
  const facts: ApprovalFacts = {
    kind: "internal_task",
    taskTitle: `Deploy ${project.name} to production`,
    taskDescription: `Trigger a ${what} of ${project.name} on Netlify${project.deployUrl ? ` (${project.deployUrl})` : ""}. This ships live to the client's site.`,
    projectName: project.name,
    agentName: "FRIDAY",
    risk: "high",
  };
  // Authority stamp — origin-aware (2026-09). risk "high" (a production deploy is HIGH, not CRITICAL,
  // in risk.ts now) so the critical floor does not re-gate it; the origin + money text decide.
  // (Legacy policy: deploy is a hard Tier-3 floor for every profile.)
  const { evaluateAuthority } = await import("@/lib/friday/authority");
  const authority = await evaluateAuthority({
    actionClass: "deploy", risk: "high", projectId: project.id,
    origin: opts.origin, scope: opts.scope, text: opts.taskText,
  });
  const approval: Approval = {
    id: newId(),
    projectId: project.id,
    action: `Deploy ${project.name} to production${opts.clearCache ? " (clear cache)" : ""}`.slice(0, 140),
    detail: `Approve to trigger a ${what} on Netlify — this goes live on the client's site. Reject to hold.`,
    risk: "high",
    status: "pending",
    deployProjectId: project.id,
    deployClearCache: !!opts.clearCache,
    requestedAt: nowISO(),
    facts,
    authorityTier: authority.mode === "off" ? undefined : authority.tier,
    authorityMode: authority.mode === "off" ? undefined : authority.mode,
    authorityReason: authority.mode === "off" ? undefined : authority.reason,
    requestOrigin: authority.origin ?? opts.origin,
    scopeVerdict: opts.origin === "client" ? (opts.scope ?? "unknown") : undefined,
    idempotencyKey: (await import("@/lib/friday/idempotency")).computeIdempotencyKey({
      deployProjectId: project.id, deployClearCache: !!opts.clearCache,
    }),
  };
  await store.approvals.insert(approval);
  await logEvent("approval.queued", { deploy: project.name, clearCache: !!opts.clearCache, authorityTier: approval.authorityTier, requestOrigin: approval.requestOrigin }, { projectId: project.id });

  // SHADOW: record the would-have-shipped decision for the /api/friday/authority report; change nothing.
  if (authority.wouldAuto && authority.mode === "shadow") {
    await logEvent("authority.shadow_auto", { id: approval.id, tier: authority.tier, reason: authority.reason, action: approval.action.slice(0, 140) }, { projectId: project.id }).catch(() => {});
  }
  // ACTIVE: Tier 1/2 take the approve click through the SAME decide path a human uses — the build
  // fires inside decideApprovalInner's deployProjectId branch (idempotency key + CAS intact), which
  // also sends the owner the deploy result. Mirrors queueApproval's auto lane; the deploy branch used
  // to lack it because deploys were a hard floor.
  if (authority.wouldAuto && authority.mode === "active") {
    await store.approvals.update(approval.id, { autoApproved: true }).catch(() => {});
    await logEvent("authority.auto_approved", { id: approval.id, tier: authority.tier, reason: authority.reason, requestOrigin: approval.requestOrigin, deploy: project.name }, { projectId: project.id }).catch(() => {});
    const decided = await decideApproval(approval.id, "approved", { source: "web" });
    return decided ?? approval;
  }

  // Raise in the OS queue (the authority) — genuinely-pending rows only (the auto lane returned).
  await (await import("@/lib/friday/osApprovalsBridge")).raiseApproval(approval);
  // No FRIDAY-side approval notification (contract §3): the OS sends exactly one per ask.
  return approval;
}

// ── Actions on EXISTING data (status / update / dispatch / send report) ──────────────────
const STAGE_ALIASES: Record<string, TaskStatus> = {
  done: "completed", complete: "completed", completed: "completed", finished: "completed", close: "completed", closed: "completed",
  delivered: "delivered", ship: "delivered", shipped: "delivered", deliver: "delivered",
  hold: "on_hold", "on hold": "on_hold", pause: "on_hold", paused: "on_hold",
  block: "blocked", blocked: "blocked", stuck: "blocked",
  start: "in_progress", started: "in_progress", "in progress": "in_progress", progress: "in_progress", working: "in_progress", active: "in_progress",
  review: "internal_review", "internal review": "internal_review",
  qa: "qa_testing", testing: "qa_testing", "qa testing": "qa_testing",
  "client review": "client_review", revisions: "revisions", "bug fixes": "bug_fixes", bugs: "bug_fixes",
  maintenance: "maintenance", supporting: "supporting", waiting: "waiting_on_client", "waiting on client": "waiting_on_client",
  planning: "planning", plan: "planning", todo: "planning", backlog: "planning",
};
function resolveStage(word?: string): TaskStatus | null {
  if (!word) return null;
  const w = word.toLowerCase().trim();
  if (TASK_STAGES.some((s) => s.key === w)) return w as TaskStatus;
  return STAGE_ALIASES[w] ?? null;
}

async function statusReport(action: PlannerAction): Promise<string> {
  const [projects, tasks, approvals] = await Promise.all([
    store.projects.all(), store.tasks.all(), store.approvals.find((a) => a.status === "pending"),
  ]);
  if (action.project) {
    const p = matchProject(projects, action.project);
    if (!p) return `I couldn't find a project matching "${action.project}".`;
    const pt = tasks.filter((t) => t.projectId === p.id);
    const open = pt.filter((t) => !isClosed(t.status));
    const lines = [`${p.name} — ${open.length} open of ${pt.length} tasks.`];
    for (const s of TASK_STAGES) {
      const items = open.filter((t) => t.status === s.key);
      if (items.length) lines.push(`• ${s.label}: ${items.map((t) => t.title.slice(0, 32)).join(", ")}`);
    }
    const runs = (await store.runs.find((r) => r.projectId === p.id)).sort((a, b) => (b.startedAt < a.startedAt ? -1 : 1));
    if (runs[0]?.summary) lines.push(`Last result: ${runs[0].summary.slice(0, 140)}`);
    const pa = approvals.filter((a) => a.projectId === p.id);
    if (pa.length) lines.push(`${pa.length} awaiting your OK — reply "approve" to the approval email, or say "approve the ${pa[0].action.slice(0, 40)}".`);
    return lines.join("\n").slice(0, 1300);
  }
  if (action.client) {
    const c = matchClient(await listClients(), action.client);
    if (!c) return `I couldn't find a client matching "${action.client}".`;
    const cps = projects.filter((p) => p.clientId === c.id);
    if (!cps.length) return `${c.name} has no projects yet.`;
    const lines = [`${c.name} — ${cps.length} project(s):`];
    for (const p of cps) {
      const open = tasks.filter((t) => t.projectId === p.id && !isClosed(t.status)).length;
      lines.push(`• ${p.name} (${p.status}) — ${open} open task(s)`);
    }
    return lines.join("\n").slice(0, 1300);
  }
  const active = projects.filter((p) => p.status === "active");
  const open = tasks.filter((t) => !isClosed(t.status));
  return `${active.length} active project(s), ${open.length} open task(s), ${approvals.length} awaiting your OK.${approvals.length ? ` Reply to the approval email, or say "approve the ${approvals[0].action.slice(0, 40)}".` : ""}`;
}

async function resolveActionTask(action: PlannerAction): Promise<Task | null> {
  if (!action.task) return null;
  const projects = await store.projects.all();
  const proj = action.project ? matchProject(projects, action.project) : null;
  const candidates = proj ? await listTasks(proj.id) : await store.tasks.all();
  return matchTask(candidates, action.task);
}

async function updateTaskAction(action: PlannerAction): Promise<string> {
  const task = await resolveActionTask(action);
  if (!task) return `I couldn't find a task matching "${action.task ?? ""}".`;
  const stage = resolveStage(action.status);
  if (!stage) return `Which stage should I move "${task.title.slice(0, 40)}" to? (e.g. done, on hold, in progress)`;
  await updateTask(task.id, { status: stage });
  const label = TASK_STAGES.find((s) => s.key === stage)?.label ?? stage;
  return `Moved "${task.title.slice(0, 50)}" → ${label}.`;
}

async function dispatchExistingAction(action: PlannerAction): Promise<string> {
  const task = await resolveActionTask(action);
  if (!task) return `I couldn't find a task matching "${action.task ?? ""}".`;
  const res = await dispatchTask(task.id);
  if (res.error) return `Couldn't dispatch "${task.title.slice(0, 40)}": ${res.error}`;
  if (res.approval) return `"${task.title.slice(0, 40)}" needs your OK first — reply "approve" to the email I sent, or say "approve the ${task.title.slice(0, 40)}".`;
  return `Dispatched "${task.title.slice(0, 50)}"${res.run ? ` to ${res.run.agentId}` : ""}. You'll see the result in your brief.`;
}

async function sendReportAction(action: PlannerAction): Promise<string> {
  const { googleConfigured } = await import("@/lib/friday/google/auth");
  if (!googleConfigured()) return "Gmail isn't connected — connect Google in Settings first.";
  const projects = await store.projects.all();
  let project = action.project ? matchProject(projects, action.project) : null;
  if (!project && action.client) {
    const c = matchClient(await listClients(), action.client);
    const cps = c ? projects.filter((p) => p.clientId === c.id) : [];
    project = cps.length === 1 ? cps[0] : null;
  }
  if (!project) return `Which project's report should I send? (couldn't resolve "${action.project ?? action.client ?? ""}")`;
  const runs = (await store.runs.find((r) => r.projectId === project!.id && (r.artifacts ?? []).some((a) => a.kind === "pdf")))
    .sort((a, b) => (b.startedAt < a.startedAt ? -1 : 1));
  const pdf = runs[0]?.artifacts?.find((a) => a.kind === "pdf");
  if (!pdf?.path) return `No report has been generated for ${project.name} yet — run a QA first.`;
  const client = await store.clients.get(project.clientId);
  if (!client?.email) return `${client?.name ?? "That client"} has no email on file — add one first.`;
  try {
    const { readFile } = await import("node:fs/promises");
    const { withinArtifacts } = await import("@/lib/friday/artifacts");
    const path = await import("node:path");
    if (!withinArtifacts(path.resolve(pdf.path))) return "That report file is missing.";
    // Emailing a file from FRIDAY's own mailbox is retired (Clara owns client email and drafts carry no
    // attachments yet). The report stays in the project's artifacts; the owner can have Clara send a link.
    void readFile; void path;
    return `I can't email files to clients any more. The "${pdf.label}" is saved with ${project.name}'s artifacts at ${pdf.path} — ask Clara to send ${client.name} a note with it, or share it through the portal.`;
  } catch (e) {
    return `Couldn't send the report: ${String(e).slice(0, 120)}`;
  }
}

async function deployAction(action: PlannerAction, origin: RequestOrigin): Promise<string> {
  const projects = await store.projects.all();
  let project = action.project ? matchProject(projects, action.project) : null;
  if (!project && action.client) {
    const c = matchClient(await listClients(), action.client);
    const cps = c ? projects.filter((p) => p.clientId === c.id) : [];
    project = cps.length === 1 ? cps[0] : null;
  }
  if (!project) return `Which project should I deploy? (couldn't resolve "${action.project ?? action.client ?? ""}")`;

  // Preferred path: FRIDAY triggers the Netlify build itself (in-process, using NETLIFY_AUTH_TOKEN).
  // The build only fires through decideApproval: an owner/CLARA-origin ask under ACTIVE authority
  // takes that click itself inside queueDeployApproval (Tier 1); otherwise the row waits for the owner.
  const { netlifyConfigured } = await import("@/lib/friday/workspace");
  if (netlifyConfigured() && (project.netlifySiteId || project.deployUrl || project.name)) {
    const approval = await queueDeployApproval(project, { clearCache: !!action.clearCache, origin, taskText: action.message });
    if (approval.status === "approved") {
      return `Deploying ${project.name} to production now${approval.resultNote ? ` — ${approval.resultNote.slice(0, 160)}` : ""}. You'll see the result in your brief.`;
    }
    return `Deploy of ${project.name} to production needs your OK — reply "approve" to the email I just sent (or use the dashboard). Nothing ships until you approve.`;
  }

  if (!projectRepos(project).length && !project.workspaceDir) return `${project.name} has no repo or local folder attached to deploy from.`;
  // Fallback (no Netlify token / site not found): a gated devops agent task.
  const task = await createTask({
    projectId: project.id,
    title: `Deploy ${project.name} to Netlify (build, then run netlify deploy --prod; report the live URL)`,
    assignee: "devops", status: DEFAULT_STAGE, risk: "high",
    requestedBy: OWNER, requestOrigin: origin,
  });
  const res = await dispatchTask(task.id);
  if (res.approval) return `Deploy of ${project.name} needs your OK — reply "approve" to the email I sent, or say "approve the ${project.name} deploy".`;
  if (res.error) return `Couldn't start the deploy: ${res.error}`;
  return `🚀 Deploying ${project.name}${res.run ? ` (${res.run.agentId})` : ""} — I'll text you the result.`;
}

// In-process Netlify deploy: resolve the project's site (stored id → deployUrl/name lookup, then
// cache the id), trigger a build (optionally cache-clearing), and report the deploy dashboard link.
// Returns handled=false when Netlify isn't configured or the site can't be resolved, so the caller
// falls back to a gated devops-agent task.
export async function deployNetlify(
  project: Project, opts: { clearCache?: boolean } = {},
): Promise<{ handled: boolean; message: string; deployId?: string }> {
  const { netlifyConfigured, findNetlifySite, triggerNetlifyBuild, purgeNetlifyCache } = await import("@/lib/friday/workspace");
  if (!netlifyConfigured()) return { handled: false, message: "" };

  let siteId = project.netlifySiteId;
  let resolvedUrl = project.deployUrl;
  let adminUrl = "";
  if (!siteId) {
    const site = await findNetlifySite(project.deployUrl || project.name);
    if (!site) return { handled: false, message: "" };
    siteId = site.id;
    resolvedUrl = site.url;
    adminUrl = site.adminUrl;
  }

  const build = await triggerNetlifyBuild(siteId, { clearCache: opts.clearCache });
  if (!build.ok) return { handled: true, message: `Couldn't trigger the Netlify deploy for ${project.name}: ${build.error}` };

  // A clearCache request wants stale cached responses gone — a build alone won't do that. Purge the
  // CDN / Durable / runtime cache too (evicts stale user-agent-keyed prerender variants).
  let purged = false;
  if (opts.clearCache) {
    const p = await purgeNetlifyCache(siteId);
    purged = p.ok;
  }

  // Persist the resolved site id (+ canonical url) so future deploys skip the lookup.
  const patch: Partial<Project> = { netlifySiteId: siteId };
  if (resolvedUrl && resolvedUrl !== project.deployUrl) patch.deployUrl = resolvedUrl;
  await updateProject(project.id, patch).catch(() => {});

  const deploys = adminUrl ? `${adminUrl}/deploys` : "https://app.netlify.com";
  await logEvent("netlify.deploy", { project: project.id, siteId, clearCache: !!opts.clearCache, purged, deployId: build.deployId });
  const what = opts.clearCache ? `cache-clearing production deploy${purged ? " + CDN purge" : ""}` : "production deploy";
  return {
    handled: true,
    deployId: build.deployId,
    message: `🚀 Triggered a ${what} for ${project.name} on Netlify — building now.${adminUrl ? ` Watch it: ${deploys}` : ""}`,
  };
}

// Set up a RECURRING agent task (persists a Schedule; the scheduler fires it). Distinct from
// scheduleAction, which books a one-off Google Calendar meeting.
async function scheduleRecurringAction(action: PlannerAction): Promise<string> {
  const projects = await store.projects.all();
  const project = action.project ? matchProject(projects, action.project) : null;
  let clientId: string | undefined;
  let targetType: "project" | "client" | "all-active" = "all-active";
  if (project) targetType = "project";
  else if (action.client) {
    const c = matchClient(await listClients(), action.client);
    if (c) { clientId = c.id; targetType = "client"; }
  }
  const assignee = action.assignee ? resolveAssignee(action.assignee) : "pm";
  const base = (action.taskTitle || action.task || "Scheduled review").trim();
  const title = base.includes("{project}") ? base : `${base} — {project}`;
  const { createSchedule, describeCadence } = await import("@/lib/friday/schedules");
  const s = await createSchedule({
    name: `${base}${project ? ` — ${project.name}` : action.client ? ` — ${action.client}` : " (all active)"}`,
    targetType, projectId: project?.id, clientId,
    assignee, title, risk: "low", enabled: true,
    freq: action.freq ?? "weekly",
    dayOfWeek: action.dayOfWeek, dayOfMonth: action.dayOfMonth,
    hour: typeof action.atHour === "number" ? action.atHour : 9,
  });
  return `⏰ Scheduled "${s.name}" — ${describeCadence(s)}, run by ${assignee}. Manage it on the Schedules page.`;
}

async function scheduleAction(action: PlannerAction): Promise<string> {
  const { googleConfigured } = await import("@/lib/friday/google/auth");
  if (!googleConfigured()) return "Calendar isn't connected — connect Google in Settings first.";
  if (!action.startISO || Number.isNaN(Date.parse(action.startISO))) return "When should the meeting be? Give me a date (and time, or say 'find a slot').";
  const dur = action.durationMin ?? 30;
  let start = new Date(action.startISO);
  // "find a slot" → pick the first open business-hours slot on that day.
  if (action.findSlot) {
    const { freeBusy, firstFreeSlot } = await import("@/lib/friday/google/calendar");
    const dayStart = new Date(start); dayStart.setHours(9, 0, 0, 0);
    const dayEnd = new Date(start); dayEnd.setHours(17, 0, 0, 0);
    const now = new Date();
    const busy = await freeBusy(dayStart.toISOString(), dayEnd.toISOString());
    const slot = firstFreeSlot(busy, dayStart > now ? dayStart : now, dayEnd, dur);
    if (!slot) return `No open ${dur}-min slot that day — want me to try another day?`;
    start = slot;
  }
  const end = action.endISO && !Number.isNaN(Date.parse(action.endISO))
    ? new Date(action.endISO) : new Date(start.getTime() + dur * 60_000);
  const attendees: string[] = [];
  let who = "";
  if (action.client) {
    const c = matchClient(await listClients(), action.client);
    if (c?.email) { attendees.push(c.email); who = ` with ${c.name}`; }
  }
  const { createEvent } = await import("@/lib/friday/google/calendar");
  const summary = action.title || `Call${who}`.trim();
  const res = await createEvent({ summary, startISO: start.toISOString(), endISO: end.toISOString(), attendees, withMeet: true });
  if (!res.ok) return `Couldn't create the event: ${res.error}`;
  const when = start.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  await logEvent("calendar.create", { summary, attendees, ok: true });
  return `📅 Booked "${summary}"${who} for ${when}.${res.meet ? ` Meet: ${res.meet}` : ""}`;
}

// Resolve the upcoming event the operator means (by client attendee or title) for reschedule/cancel.
async function resolveEvent(action: PlannerAction): Promise<{ id: string; summary: string; start: string; end: string } | null> {
  const { listEvents } = await import("@/lib/friday/google/calendar");
  const now = new Date();
  const events = await listEvents({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 45 * 86_400_000).toISOString(), max: 25 });
  if (!events.length) return null;
  let cand = events;
  if (action.client) {
    const c = matchClient(await listClients(), action.client);
    if (c?.email) { const f = events.filter((e) => (e.attendees ?? []).some((a) => a.toLowerCase() === c.email!.toLowerCase())); if (f.length) cand = f; }
  }
  const q = (action.title || action.task || "").toLowerCase().trim();
  if (q) { const f = cand.filter((e) => e.summary.toLowerCase().includes(q.split(" ")[0])); if (f.length) cand = f; }
  const e = cand[0];
  return e ? { id: e.id, summary: e.summary, start: e.start, end: e.end } : null;
}

async function rescheduleAction(action: PlannerAction): Promise<string> {
  const { googleConfigured } = await import("@/lib/friday/google/auth");
  if (!googleConfigured()) return "Calendar isn't connected.";
  if (!action.startISO || Number.isNaN(Date.parse(action.startISO))) return "What's the new time?";
  const ev = await resolveEvent(action);
  if (!ev) return `I couldn't find that meeting to reschedule.`;
  const newStart = new Date(action.startISO);
  const origLen = Math.max(15 * 60_000, new Date(ev.end).getTime() - new Date(ev.start).getTime());
  const { updateEvent } = await import("@/lib/friday/google/calendar");
  const res = await updateEvent(ev.id, { startISO: newStart.toISOString(), endISO: new Date(newStart.getTime() + origLen).toISOString() });
  if (!res.ok) return `Couldn't reschedule: ${res.error}`;
  await logEvent("calendar.update", { summary: ev.summary });
  return `📅 Moved "${ev.summary.slice(0, 40)}" to ${newStart.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`;
}

async function cancelAction(action: PlannerAction): Promise<string> {
  const { googleConfigured } = await import("@/lib/friday/google/auth");
  if (!googleConfigured()) return "Calendar isn't connected.";
  const ev = await resolveEvent(action);
  if (!ev) return `I couldn't find that meeting to cancel.`;
  const { deleteEvent } = await import("@/lib/friday/google/calendar");
  const res = await deleteEvent(ev.id);
  if (!res.ok) return `Couldn't cancel: ${res.error}`;
  await logEvent("calendar.delete", { summary: ev.summary });
  return `🗑️ Cancelled "${ev.summary.slice(0, 40)}" and notified attendees.`;
}

async function notifyClientAction(action: PlannerAction): Promise<string> {
  const clients = await listClients();
  let client = action.client ? matchClient(clients, action.client) : null;
  if (!client && action.project) {
    const p = matchProject(await store.projects.all(), action.project);
    if (p) client = await store.clients.get(p.clientId);
  }
  if (!client) return `Which client should I message? (couldn't resolve "${action.client ?? action.project ?? ""}")`;
  const msg = (action.message || "").trim();
  if (!msg) return `What should I tell ${client.name}?`;
  // FRIDAY sends no client text or mail of her own (2026-10): a message to a client is a DRAFT in the owner's
  // approval queue in the OS, and Clara sends it from her mailbox once they approve.
  if (!client.email) return `${client.name} has no email on file, and I no longer text clients. Ask Clara to text or call them.`;
  const { queueClientEmail } = await import("@/lib/friday/osClientEmail");
  const first = client.name.trim().split(/\s+/)[0] || "there";
  const r = await queueClientEmail(client, {
    subject: `Update from ${AGENCY}`, body: `Hi ${first},\n\n${msg}\n\n— ${AGENCY}`,
    ref: `notify:${client.id}:${msg.slice(0, 40)}:${new Date().toISOString().slice(0, 13)}`, summary: `Message to ${client.name}`,
  });
  await logEvent("client.notify", { client: client.name, via: "draft", ok: r.ok });
  return r.ok ? `Drafted for your approval: "${msg.slice(0, 80)}" to ${client.name}. Approve it in your OS inbox (or tell Clara) and she sends it.` : `Couldn't draft that: ${r.error}`;
}

async function deliverDocAction(action: PlannerAction): Promise<string> {
  const { googleConfigured } = await import("@/lib/friday/google/auth");
  if (!googleConfigured()) return "Google isn't connected — connect it in Settings first.";
  const projects = await store.projects.all();
  let project = action.project ? matchProject(projects, action.project) : null;
  if (!project && action.client) {
    const c = matchClient(await listClients(), action.client);
    const cps = c ? projects.filter((p) => p.clientId === c.id) : [];
    project = cps.length === 1 ? cps[0] : null;
  }
  if (!project) return `Which project's deliverable should I turn into a Doc?`;
  const last = (await store.runs.find((r) => r.projectId === project!.id && !!r.result)).sort((a, b) => (b.startedAt < a.startedAt ? -1 : 1))[0];
  if (!last?.result) return `No result yet for ${project.name} to put in a Doc — run something first.`;
  const { createDoc, shareDoc } = await import("@/lib/friday/google/docs");
  const { clientSafeText } = await import("@/lib/friday/deliverables");
  const title = `${project.name} — ${(last.summary || "Report").slice(0, 50)}`;
  // Client-safe body ONLY — the doc is shared with the client, so it must carry the CLIENT SUMMARY,
  // never the raw run output (which carried internal candor + file paths). (1E)
  const doc = await createDoc(title, clientSafeText(last.result));
  if (!doc.ok) return `Couldn't create the Doc (${doc.error}). If this is the first time, re-connect Google — the Docs permission was just added.`;
  const client = await store.clients.get(project.clientId);
  // File the Doc into the project's "Proposals & SOWs" library folder (best-effort).
  if (client && doc.id) {
    try {
      const { ensureCategoryFolder } = await import("@/lib/friday/google/library");
      const { moveFile } = await import("@/lib/friday/google/drive");
      const folderId = await ensureCategoryFolder(client, project, "Proposals & SOWs");
      if (folderId) await moveFile(doc.id, folderId);
    } catch { /* best-effort */ }
  }
  let shared = "";
  if (client?.email && doc.id) { const s = await shareDoc(doc.id, client.email, "reader"); if (s.ok) shared = ` (shared with ${client.email})`; }
  await logEvent("deliver.doc", { project: project.name, ok: true });
  return `📝 Google Doc: ${doc.url}${shared}`;
}

async function handleAction(action: PlannerAction, origin: RequestOrigin): Promise<string | null> {
  switch (action.kind) {
    case "status": return statusReport(action);
    case "deliver_doc": return deliverDocAction(action);
    case "update_task": return updateTaskAction(action);
    case "dispatch_task": return dispatchExistingAction(action);
    case "send_report": return sendReportAction(action);
    case "deploy": return deployAction(action, origin);
    case "schedule": return scheduleAction(action);
    case "schedule_recurring": return scheduleRecurringAction(action);
    case "reschedule": return rescheduleAction(action);
    case "cancel": return cancelAction(action);
    case "notify_client": return notifyClientAction(action);
    case "set_away": return setAwayAction(action);
    case "offboard": return offboardAction(action);
    default: return null;
  }
}

// Offboard a delivered project (2.4): generate a "what we built" summary from its request history,
// archive it (drops from the planner snapshot), and open a 30-day free-bugfix warranty window.
async function offboardAction(action: PlannerAction): Promise<string> {
  const projects = await store.projects.all();
  let project = action.project ? matchProject(projects, action.project) : null;
  if (!project && action.client) {
    const c = matchClient(await listClients(), action.client);
    const cps = c ? projects.filter((p) => p.clientId === c.id) : [];
    project = cps.length === 1 ? cps[0] : null;
  }
  if (!project) return `Which project should I close out? (couldn't resolve "${action.project ?? action.client ?? ""}")`;

  const [reqs, tasks] = await Promise.all([
    store.requests.find((r) => r.projectId === project!.id),
    store.tasks.find((t) => t.projectId === project!.id),
  ]);
  const built = reqs.filter((r) => r.state === "closed" || r.state === "client_accepted").map((r) => `• ${r.title}`);
  const delivered = tasks.filter((t) => t.status === "delivered" || t.status === "completed").map((t) => `• ${t.title}`);
  const summaryLines = (built.length ? built : delivered).slice(0, 20);
  const now = nowISO();
  const warrantyUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();

  const { updateProject } = await import("@/lib/friday/repo");
  await updateProject(project.id, { status: "archived", closedAt: now, warrantyUntil }).catch(() => {});
  await logEvent("project.offboarded", { project: project.name, warrantyUntil }, { projectId: project.id });

  // "What we built" doc into the project's Obsidian log (durable, owner-visible).
  const doc = `# ${project.name} — What we built\n\nDelivered:\n${summaryLines.join("\n") || "(no recorded deliverables)"}\n\nClosed ${now.slice(0, 10)}. Free-bugfix warranty through ${warrantyUntil.slice(0, 10)}.`;
  const { appendProjectLog } = await import("@/lib/persistence/obsidian");
  await appendProjectLog(project, { actor: "FRIDAY", kind: "note", text: doc }).catch(() => {});

  const checklist = [
    `📦 Closed out **${project.name}** — archived, 30-day warranty through ${warrantyUntil.slice(0, 10)}.`,
    `Final-package checklist before you hand off:`,
    `  • Credentials/repo access transferred to the client`,
    `  • "What we built" summary generated (in the project log)${project.deployUrl ? `\n  • Live: ${project.deployUrl}` : ""}`,
    `During warranty: bug reports run free; new features/changes route to a sales draft.`,
  ].join("\n");
  return checklist;
}

async function setAwayAction(action: PlannerAction): Promise<string> {
  const { setAway, setAvailable, returnTimeline, getOwnerStatus } = await import("@/lib/friday/ownerStatus");
  if (action.away === false) {
    const { digest } = await setAvailable();
    return `Welcome back — you're marked available again. ${digest}`.trim();
  }
  await setAway(action.untilISO, action.reason);
  const s = await getOwnerStatus();
  return `Got it — you're marked away${action.reason ? ` (${action.reason})` : ""}. While you're out I'll handle in-scope work, tell clients waiting on your sign-off you'll have an answer by ${returnTimeline(s)}, and only page you for real incidents. Text "back" when you return.`;
}

// ── Auto-QA gate: after a dev/architect/devops/debug run lands in review, auto-run QA and route ──
const AUTO_QA_ROLES = ["dev", "architect", "devops", "debug"];
/** One quick GET of the production URL; true when unset (nothing to probe) or it answers < 500. */
async function productionAnswers(url?: string): Promise<boolean> {
  const u = url?.trim();
  if (!u) return true;
  // deployUrl may be a bare hostname (the uptime job normalizes the same way); fetch("host.com") throws.
  const target = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  try {
    const r = await fetch(target, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(10_000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/**
 * Wait for a triggered Netlify deploy to leave the "building" state so the post-deploy probe tests
 * the NEW build, not the one still being served. Resolves "ready" | "error" | "timeout" | "unknown"
 * (no site id / API failure — caller probes anyway and says so).
 */
async function awaitNetlifyDeploy(projectId: string, deployId: string | undefined, timeoutMs = 6 * 60_000): Promise<"ready" | "error" | "timeout" | "unknown"> {
  if (!deployId) return "unknown";
  const { listNetlifyDeploys } = await import("@/lib/friday/workspace");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = await store.projects.get(projectId).catch(() => null);
    const siteId = fresh?.netlifySiteId;
    if (!siteId) return "unknown";
    const r = await listNetlifyDeploys(siteId, 10).catch(() => ({ ok: false, deploys: [] as Array<{ id: string; state: string }> }));
    const d = r.ok ? r.deploys.find((x) => x.id === deployId) : undefined;
    if (d?.state === "ready") return "ready";
    if (d?.state === "error") return "error";
    await new Promise((res) => setTimeout(res, 20_000));
  }
  return "timeout";
}

async function maybeAutoQA(taskIn: Task, project: Project | null, agent: Agent, verify?: VerifyResult | null): Promise<void> {
  // Owner rule 2026-10-02: local auto-QA is off by default. The only gates that matter are the
  // ones GitHub and CodeRabbit can judge after the PR is open — local verification was false-
  // failing on env-var differences and parking real work in `revisions`. Pass AGENTIC_OS_AUTO_QA=on
  // to opt back in (e.g. a project whose checks must run against the agent's local worktree).
  if ((process.env.AGENTIC_OS_AUTO_QA ?? "off").trim().toLowerCase() !== "on") return;
  if (!project) return;
  // Re-read the task: finalizeRun records prUrl/prHeadRef AFTER executeRun captured its copy, and a
  // stale copy made every QA/fix round lose the PR and open a second one (mai-dash #90/#91).
  const task = (await store.tasks.get(taskIn.id)) ?? taskIn;
  // A coding run that left NO change anywhere did not do the work — and any RED check was already
  // RED before it ran. Self-healing that sent the mAI Dashboard "Total Calls" bug (2026-09-14) on
  // three rounds of test-tooling fixes while the actual fix was never made. Escalate instead.
  if (verify?.noChange && WRITE_ROLES.includes(agent.role) && !/^\s*\[qa\]/i.test(task.title)) {
    const { notifyOwner } = await import("@/lib/friday/notify");
    await updateTask(task.id, { status: "revisions" });
    await logEvent("autoqa.no_change", { task: task.title, agent: agent.id, preexistingRed: verify.hardFail }, { level: "warn", projectId: project.id });
    await notifyOwner({
      kind: "autoqa", priority: "normal",
      text: `"${task.title.slice(0, 50)}" — ${agent.name} finished without changing any code, so nothing was verified, healed, or shipped.${verify.hardFail ? " (This repo's checks were already failing before it ran.)" : ""} Re-dispatch or take a look.`,
      dedupeKey: `nochange:${task.id}`,
    }).catch(() => {});
    return;
  }
  // Full-gate block: the project's OWN checks ran and something is RED (failing test/build/typecheck).
  // That's executed truth — bounce the work to Revisions immediately, no QA LLM opinion needed. Runs
  // for ANY coding role (incl. designer, not in AUTO_QA_ROLES) and even if the daily cap is hit.
  if (verify?.hardFail) {
    if (/^\s*\[qa\]/i.test(task.title)) return; // never verify-loop a QA task itself
    const { notifyOwner } = await import("@/lib/friday/notify");
    const failedChecks = verify.checks.filter((c) => c.ran && !c.ok).map((c) => c.name).join(", ");
    const { title: fixTitle, round } = nextFixTitle(task.title, "checks");
    // Self-heal exhaustion: rounds spent, checks still red → this genuinely needs a human.
    if (round > maxHealRounds()) {
      await updateTask(task.id, { status: "revisions" });
      await logEvent("autoqa.heal_exhausted", { task: task.title, rounds: parseFixRound(task.title), via: "checks" }, { level: "warn", projectId: project.id });
      await notifyOwner({ kind: "autoqa", priority: "normal", text: `Self-heal exhausted (${maxHealRounds()} rounds) on "${task.title.slice(0, 50)}" — checks still failing (${failedChecks}). Needs your eyes.`, dedupeKey: `healmax:${task.id}` }).catch(() => {});
      return;
    }
    // One fix round per run (run-keyed, never title-keyed — see qaHeal.qaAlreadyRanFor).
    if (fixRoundExistsFor(task, await listTasks(project.id))) return;
    const hardFix = await createTask({
      projectId: project.id, title: fixTitle,
      description: `Automated verification RAN the project's own checks and they FAILED. Fix the code so typecheck/build/tests pass, then re-open a PR.\n\n${verify.evidenceMarkdown.slice(0, 6000)}`,
      assignee: AUTO_QA_ROLES.includes(agent.role) ? agent.role : "dev", status: DEFAULT_STAGE, risk: "medium",
      origin: task.origin, originContact: task.originContact, sourceRunId: task.runId,
      ...inheritLineage(task),
    });
    // The fix task carries the request forward — the parent is parked in `revisions`; readiness is
    // judged off the LATEST owned task (see requestReadyForReview).
    if (task.requestId) { const { linkTask } = await import("@/lib/friday/requests"); await linkTask(task.requestId, hardFix.id).catch(() => {}); }
    await updateTask(task.id, { status: "revisions" });
    await logEvent("verify.hardfail", { task: task.title, round, checks: verify.checks.map((c) => `${c.name}:${c.ok ? "pass" : "fail"}`) }, { level: "warn", projectId: project.id });
    if (selfHealEnabled()) {
      // Self-heal round: dispatch the fix straight back to the original role. Rounds are silent —
      // only exhaustion (above) or an eventual QA pass reaches the owner.
      const fixer = await getAgent(AUTO_QA_ROLES.includes(agent.role) ? agent.role : "dev");
      if (fixer) void dispatchRunAsync(fixer, hardFix, project).catch(() => {});
      await logEvent("autoqa.heal_round", { round, task: fixTitle, via: "checks" }, { projectId: project.id });
    } else {
      await notifyOwner({ kind: "autoqa", priority: "normal", text: `"${task.title.slice(0, 50)}" — verification FAILED (${failedChecks}). Bounced to Revisions + opened a fix task.`, dedupeKey: `verifyfail:${task.id}` }).catch(() => {});
    }
    return;
  }
  if (!AUTO_QA_ROLES.includes(agent.role)) return;
  // Respect the daily run budget AND the daily spend cap — auto-dispatch stops when either is hit
  // (manual dispatch still works).
  const { withinRunBudget, dailyRunCap, withinSpendBudget, spendToday, dayMaxCostUsd } = await import("@/lib/friday/usage");
  if (!(await withinRunBudget())) {
    const { notifyOwner } = await import("@/lib/friday/notify");
    await notifyOwner({ kind: "budget", priority: "low", text: `Auto-QA paused — hit the daily run cap (${dailyRunCap()}). Raise AGENTIC_OS_DAILY_RUN_CAP or dispatch manually.`, dedupeKey: `budget:${new Date().toISOString().slice(0, 10)}` }).catch(() => {});
    return;
  }
  if (!(await withinSpendBudget())) {
    const { notifyOwner } = await import("@/lib/friday/notify");
    await notifyOwner({ kind: "spend", priority: "normal", text: `Auto-QA paused — today's model spend hit $${(await spendToday()).toFixed(2)} (cap $${dayMaxCostUsd()}). Raise DAY_MAX_COST_USD or dispatch manually.`, dedupeKey: `spend:${new Date().toISOString().slice(0, 10)}` }).catch(() => {});
    return;
  }
  if (/^\s*\[qa\]/i.test(task.title)) return; // never QA a QA task
  // A fix task DOES re-enter QA when self-heal is on — that's the heal verification. With self-heal
  // off we keep the legacy no-loop behavior (fix tasks stop the chain, a human re-dispatches).
  if (parseFixRound(task.title) > 0 && !selfHealEnabled()) return;
  // One QA per RUN. The old 24-character title-prefix guard silently skipped every repeated title
  // ("[QA] [Deps] acme-aicoach" is exactly 24 chars) — the 2026-09-24 stranded-deps-PRs incident.
  if (qaAlreadyRanFor(task, await listTasks(project.id))) return;
  const qa = await runQaRound(task, project, agent, verify);
  if (!qa) return;
  const { notifyOwner } = await import("@/lib/friday/notify");
  if (!qa.passed) {
    const { title: fixTitle, round } = nextFixTitle(task.title, "qa");
    // Self-heal exhaustion: rounds spent, QA still failing → escalate to the human.
    if (round > maxHealRounds()) {
      await updateTask(task.id, { status: "revisions" });
      await logEvent("autoqa.heal_exhausted", { task: task.title, rounds: parseFixRound(task.title), via: "qa" }, { level: "warn", projectId: project.id });
      await notifyOwner({ kind: "autoqa", priority: "normal", text: `Self-heal exhausted (${maxHealRounds()} rounds) on "${task.title.slice(0, 50)}" — QA still failing. ${(qa.run?.summary || "").slice(0, 120)} Needs your eyes.`, dedupeKey: `healmax:${task.id}` });
      return;
    }
    // Open a fix task that CARRIES the QA findings (description) + links back to the QA run, so the
    // fix agent actually receives what to fix.
    const qaFix = await createTask({
      projectId: project.id, title: fixTitle,
      description: `Address these QA findings:\n\n${(qa.findings || "").slice(0, 5000)}`,
      assignee: AUTO_QA_ROLES.includes(agent.role) ? agent.role : "dev", status: DEFAULT_STAGE, risk: "medium",
      origin: task.origin, originContact: task.originContact, sourceRunId: qa.run?.id,
      ...inheritLineage(task),
    });
    if (task.requestId) { const { linkTask } = await import("@/lib/friday/requests"); await linkTask(task.requestId, qaFix.id).catch(() => {}); }
    await updateTask(task.id, { status: "revisions" });
    if (selfHealEnabled()) {
      // Silent heal round: dispatch the fix to the original role; the fix run re-enters QA on completion.
      const fixer = await getAgent(AUTO_QA_ROLES.includes(agent.role) ? agent.role : "dev");
      if (fixer) void dispatchRunAsync(fixer, qaFix, project).catch(() => {});
      await logEvent("autoqa.heal_round", { round, task: fixTitle, via: "qa" }, { projectId: project.id });
    } else {
      await notifyOwner({ kind: "autoqa", text: `Auto-QA flagged "${task.title.slice(0, 50)}" — opened a fix task. ${(qa.run?.summary || "").slice(0, 140)}`, dedupeKey: `autoqa:${task.id}` });
    }
    return;
  }
  // QA passed. If this was a self-heal fix round, the loop closed itself — say so in the ping.
  const healedRound = parseFixRound(task.title);
  const healedNote = healedRound > 0 ? ` (self-healed, round ${healedRound})` : "";
  if (healedRound > 0) await logEvent("autoqa.healed", { task: task.title, rounds: healedRound }, { projectId: project.id });
  const devRun = (await store.runs.find((r) => r.taskId === task.id && r.status === "done")).sort((a, b) => (b.startedAt < a.startedAt ? -1 : 1))[0];
  const pr = (devRun?.artifacts ?? []).find((a) => a.kind === "pr" && a.url);
  await landPr(task, project, pr?.url ? { url: pr.url, label: pr.label } : undefined, { healedNote, devRun });
}

/**
 * The synchronous [QA] round for a task's latest run: spawns the `[QA]` sibling (run-linked via
 * sourceRunId so qaAlreadyRanFor can see it), runs the QA agent, and reads its FAIL-CLOSED verdict.
 * Stamps `qaPassedAt` on the task when it passes. Returns null when QA could not run at all (no QA
 * agent, no output) — the caller treats that as "nothing decided", not as a pass.
 */
export async function runQaRound(task: Task, project: Project, agent: Agent, verify?: VerifyResult | null): Promise<{ passed: boolean; findings?: string; run?: AgentRun; qaTask: Task } | null> {
  // If FRIDAY already executed the project's checks (typecheck/build/tests) and they passed, hand the
  // QA agent that evidence so its judgment is grounded in real output, not just diff-reading.
  const evidenceBlock = verify?.ran
    ? `\n\nAutomated checks already RAN and passed:\n${verify.evidenceMarkdown.slice(0, 2000)}\nFocus your review on correctness/completeness/safety beyond what these checks cover.`
    : "";
  const qaTask = await createTask({
    projectId: project.id, title: qaRoundTitle(task.title), assignee: "qa",
    // Point QA at the ACTUAL change on the current branch (avoids false "file missing" verdicts) and
    // demand an explicit, parseable verdict instead of us guessing from prose.
    description: "Review the code changes just made on the CURRENT branch of this repo. Run `git status` and `git diff main...HEAD` (or `git show HEAD`) to see EXACTLY what changed — the working tree is already checked out on the feature branch, so do NOT report a file as missing without first checking the branch. Verify the change is correct, complete, and safe to merge. End your reply with EXACTLY one final line: `VERDICT: PASS` (good to merge) or `VERDICT: FAIL — <one-line reason>`." + evidenceBlock,
    status: "qa_testing", origin: task.origin, originContact: task.originContact, sourceRunId: task.runId,
    ...inheritLineage(task),
  });
  await logEvent("autoqa.start", { task: task.title }, { projectId: project.id });
  // Run QA SYNCHRONOUSLY (we need its verdict to decide pass/fail + auto-merge). We're already in a
  // background context (maybeAutoQA is fire-and-forget), so this doesn't block any caller.
  const qaAgent = await getAgent("qa");
  if (!qaAgent) return null;
  const qaRun = await runAgentOnTask(qaAgent, qaTask, project);
  // A QA run that didn't complete (errored, refused by the worm guard, stopped) never counts — even if
  // its partial output happens to contain a VERDICT line.
  if (qaRun.status !== "done") return null;
  const out = qaRun.result || qaRun.summary || "";
  if (!out) return null;
  // FAIL-CLOSED verdict: ONLY an explicit "VERDICT: PASS" line (the exact contract the QA task
  // description demands) counts as a pass. The old default-pass heuristic shipped anything whose
  // wording dodged a small keyword list — "I could not run the application, so the change was not
  // verified" read as passing and could auto-merge + auto-deploy. Ambiguity is a QA failure.
  const verdictPass = /^\s*VERDICT:\s*PASS\b/im.test(out);
  const verdictFail = /^\s*VERDICT:\s*FAIL\b/im.test(out);
  if (!verdictPass && !verdictFail) {
    // No explicit verdict either way — keep the evidence so the missing line is debuggable.
    await logEvent("autoqa.no_verdict", { task: task.title, tail: out.slice(-400) }, { level: "warn", projectId: project.id });
  }
  if (verdictPass) await updateTask(task.id, { qaPassedAt: nowISO() }).catch(() => {});
  await remember({
    project, task, kind: "qa-verdict", title: task.title,
    outcome: verdictPass ? "done" : "failed",
    summary: verdictPass ? "QA passed." : verdictFail ? (out.match(/^\s*VERDICT:\s*FAIL\b.*$/im)?.[0] ?? "QA failed.") : "QA gave no explicit verdict — treated as a failure.",
    findings: verdictPass ? undefined : (qaRun.result ?? "").slice(0, 2500),
    next: verdictPass ? "PR shepherd: review, conflicts and merge." : "A fix round addresses the QA findings on the same pull request.",
    prUrl: task.prUrl,
  });
  return { passed: verdictPass, findings: qaRun.result || undefined, run: qaRun, qaTask };
}

/**
 * Land a task's PR after QA passed: tell a texting client, re-derive authority at the moment of
 * irreversible effect, merge when Tier 1 / low risk / bypass, deploy + verify production, and
 * hand the request to client review. Extracted from maybeAutoQA so the PR shepherd can call it
 * for a PR whose QA ran outside the dispatch flow. Behaviour unchanged.
 */
export async function landPr(
  task: Task,
  project: Project,
  pr: { url: string; label: string } | undefined,
  opts: { healedNote?: string; devRun?: AgentRun } = {},
): Promise<{ merged: boolean; error?: string }> {
  const { notifyOwner } = await import("@/lib/friday/notify");
  const healedNote = opts.healedNote ?? "";
  const devRun = opts.devRun;
  // The client who texted this in hears back HERE — once the work has passed QA — instead of at
  // run end (premature for coding work; see notifyBack.runEndNotifyTarget). Client-safe CLIENT
  // SUMMARY only, under the title they asked about, never the internal "[Fix R2] …" round name.
  // (The client who texted a task in used to hear back here by SMS. FRIDAY has no text channel any more;
  // work that arrives through Clara or the portal reports back through those, not through FRIDAY.)
  // The bypass stamp on the task is HISTORY (what intake decided when the ask arrived); the kill
  // switch and the client's bypassPolicy are the LIVE authority. Re-check both at the moment of
  // irreversible effect — the owner flipping FRIDAY_CLIENT_BYPASS=off mid-run (e.g. a compromised
  // client account) must stop the auto-merge/auto-deploy of work that is already in flight.
  let bypassArmed = false;
  if (task.bypassAuthority) {
    const { clientBypassEnabled } = await import("@/lib/friday/taskIntake");
    const client = project.clientId ? await store.clients.get(project.clientId) : null;
    bypassArmed = clientBypassEnabled() && !!client?.bypassPolicy?.enabled;
    if (!bypassArmed) {
      await logEvent("client.bypass.revoked_inflight", { task: task.title, client: client?.name }, { level: "warn", projectId: project.id });
    }
  }
  // Origin-aware autonomy (2026-09): an owner/CLARA/scheduler-origin task — or a client one inside
  // the approved scope — that just passed QA is Tier 1 work: merge and ship it. Re-derived at the
  // moment of irreversible effect (not read off a stamp) so a dial flip mid-run is honoured, exactly
  // like the bypass re-check above. Critical risk and money text floor it to the approval path.
  const { autonomyPolicy, authorityMode, decideAutonomy, inferOrigin } = await import("@/lib/friday/authority");
  const origin: RequestOrigin = task.requestOrigin ?? inferOrigin(task);
  const scope: ScopeVerdict = origin === "client" ? await taskScopeVerdict(task) : "unknown";
  const taskText = [task.title, task.details, task.description].filter(Boolean).join("\n");
  const autonomy = decideAutonomy({ origin, actionClass: "deploy", risk: task.risk, scope: origin === "client" ? scope : undefined, text: taskText });
  const auto = autonomyPolicy() === "origin" && authorityMode() === "active" && autonomy.tier === 1;
  if (auto) await logEvent("authority.auto_ship_eligible", { task: task.title, origin, scope, reason: autonomy.reason }, { projectId: project.id }).catch(() => {});
  if (pr?.url && (task.risk === "low" || bypassArmed || auto)) {
    // PR shepherd (2026-09-24): the gate — conflicts, checks, review threads, QA — lives there. When
    // it is ACTIVE it owns the merge (and every later tick if something isn't green yet). While it
    // is only observing (dry), the legacy direct merge below keeps today's behaviour.
    const { shepherdOne, shepherdMode } = await import("@/lib/friday/prShepherd");
    if (shepherdMode() === "active") {
      await updateTask(task.id, { prUrl: pr.url }).catch(() => {});
      // Re-read: runQaRound stamped qaPassedAt on the stored row, not on this in-memory copy.
      const fresh = (await store.tasks.get(task.id)) ?? task;
      const res = await shepherdOne(pr.url, { trigger: "qa_pass", project, task: { ...fresh, prUrl: pr.url } });
      if (res.action.kind === "merge" && res.applied) return { merged: true };
      await maybeEnterClientReview(task.requestId);
      return { merged: false, error: res.note ?? res.action.kind };
    }
    // Direct merge (shepherd not active): scan the exact PR head first — fail closed — and merge only
    // that same commit (--match-head-commit), so a head that changed after QA can't slip through.
    const { prReadiness, mergePr, parsePrUrl } = await import("@/lib/friday/prGate");
    const head = await prReadiness(pr.url).catch(() => null);
    const pid = parsePrUrl(pr.url);
    if (!head?.headSha || !pid) return { merged: false, error: "could not read the PR head to scan it — not merging" };
    const { guardPrHead } = await import("@/lib/friday/wormGuard");
    const key = `${pid.owner}/${pid.repo}`.toLowerCase();
    const worm = await guardPrHead({ key, prNumber: head.number, headRef: head.headRefName, headSha: head.headSha, repoUrl: `https://github.com/${key}`, projectId: project.id })
      .catch((err): { kind: "unavailable"; reason: string } => ({ kind: "unavailable", reason: String(err).slice(0, 160) }));
    if (worm.kind !== "clean") {
      await logEvent("security.merge_refused", { pr: pr.url, kind: worm.kind, reason: worm.reason }, { level: "warn", projectId: project.id });
      if (worm.kind === "blocked") await updateTask(task.id, { status: "blocked" });
      return { merged: false, error: worm.reason };
    }
    const m = await mergePr(pr.url, { expectHeadSha: head.headSha });
    if (m.ok) {
      // Dispatched → verified → QA'd → merged: the work itself is COMPLETED. "delivered" stays the
      // manual advance for "client has been told" (completed → delivered in NEXT_STAGE).
      await updateTask(task.id, { status: "completed" });
      if ((task.bypassAuthority && bypassArmed) || auto) {
        // Ships straight to production: the single-client bypass carve-out, or (2026-09) Tier-1
        // origin-aware work under ACTIVE authority. Every other path to production still goes through
        // queueDeployApproval (which itself auto-approves Tier 1). Owner gets a low-priority FYI.
        const via = auto ? `Tier 1, ${autonomy.reason}` : "bypass";
        const { netlifyConfigured } = await import("@/lib/friday/workspace");
        if (netlifyConfigured() && (project.netlifySiteId || project.deployUrl || project.name)) {
          const dep: { handled: boolean; message: string; deployId?: string } = await deployNetlify(project, {}).catch((e) => ({ handled: false, message: `Deploy error: ${String(e).slice(0, 160)}` }));
          // `handled` only means the Netlify path ran; a deploy actually started iff we got a deployId.
          const triggered = dep.handled && Boolean(dep.deployId);
          await logEvent(auto ? "authority.auto_shipped" : "client.bypass.shipped", { task: task.title, origin, ok: triggered, deployId: dep.deployId }, { projectId: project.id }).catch(() => {});
          // deploy.broken (emergency, through CLARA): the deploy failed to start, errored, or production
          // no longer answers once the NEW build is live. A working deploy is a low-priority brief item.
          const built = triggered ? await awaitNetlifyDeploy(project.id, dep.deployId) : "unknown";
          const broken = !triggered || built === "error" || !(await productionAnswers(project.deployUrl));
          if (broken) {
            const why = !triggered ? `The deploy did not go through: ${dep.message || "unknown error"}.`
              : built === "error" ? `Netlify reported the build failed.`
              : `The deploy ${built === "timeout" ? "was still building after 6 minutes and" : "went out but"} ${project.deployUrl} is not answering.`;
            await notifyOwner({
              kind: "deploy.broken", priority: "critical", emergencyCategory: "production",
              headline: `${project.name}: production deploy problem after "${task.title.slice(0, 40)}"`,
              summary: why,
              links: [...(project.deployUrl ? [{ label: "Site", url: project.deployUrl }] : []), ...(pr.url ? [{ label: "Pull request", url: pr.url }] : [])],
              suggestedAction: "Roll back to the previous deploy in Netlify, then re-run the task.",
              text: `${project.name}: deploy problem after "${task.title.slice(0, 40)}" — ${dep.message || "site not answering"}`,
              dedupeKey: `deploybroken:${task.id}`,
            }).catch(() => {});
          }
          await notifyOwner({ kind: auto ? "authority auto" : "client.bypass", priority: "low", text: `Auto-shipped "${task.title.slice(0, 50)}" to production (${via}, no approval) — ${dep.message || "deploy not triggered"}`, dedupeKey: `${auto ? "autoship" : "bypassdeploy"}:${task.id}` }).catch(() => {});
        } else {
          await notifyOwner({ kind: auto ? "authority auto" : "client.bypass", priority: "low", text: `Auto-merged "${task.title.slice(0, 50)}" (${via}) — no Netlify site configured for ${project.name}, nothing deployed.`, dedupeKey: `automerge:${task.id}` }).catch(() => {});
        }
      } else if (task.bypassAuthority) {
        // Bypass revoked while the task ran: the low-risk merge stands, but the deploy now rides
        // the normal gate like every other path to production (queueDeployApproval decides by origin).
        await queueDeployApproval(project, { origin, scope, taskText }).catch(() => {});
        await notifyOwner({ kind: "autoqa", text: `QA passed${healedNote} + auto-merged ${pr.label} for "${task.title.slice(0, 50)}" — bypass was revoked mid-run, so the deploy is queued for your approval.`, dedupeKey: `automerge:${task.id}` });
      } else {
        await notifyOwner({ kind: "autoqa", text: `QA passed${healedNote} + auto-merged ${pr.label} for "${task.title.slice(0, 50)}" — completed.`, dedupeKey: `automerge:${task.id}` });
      }
      await maybeEnterClientReview(task.requestId);
      return { merged: true };
    }
    await updateTask(task.id, { status: "client_review" });
    await notifyOwner({ kind: "autoqa", priority: "normal", ...(pr.url ? { links: [{ label: "Pull request", url: pr.url }] } : {}), text: `QA passed${healedNote} "${task.title.slice(0, 50)}" but auto-merge failed (${m.error}). Merge manually: ${pr.url}`, dedupeKey: `autoqa:${task.id}` });
    await maybeEnterClientReview(task.requestId);
    return { merged: false, error: m.error };
  }
  await updateTask(task.id, { status: "client_review" });
  await notifyOwner({
    kind: "autoqa", priority: "normal",
    ...(pr?.url ? { links: [{ label: "Pull request", url: pr.url }] } : {}),
    text: pr
      ? `QA passed${healedNote} "${task.title.slice(0, 50)}" (${task.risk}). Review + merge: ${pr.url}`
      : `Auto-QA passed${healedNote} "${task.title.slice(0, 50)}" — advanced to Client Review.`,
    dedupeKey: `autoqa:${task.id}`,
  });
  await maybeEnterClientReview(task.requestId);
  return { merged: false, error: pr ? "not eligible" : "no pr" };
}

/** After a deliverable task passes QA, fire the client-review email if its Request is fully done. */
export async function maybeEnterClientReview(requestId?: string): Promise<void> {
  if (!requestId) return;
  try {
    const { enterClientReview } = await import("@/lib/friday/clientReview");
    await enterClientReview(requestId);
  } catch (e) {
    await logEvent("clientreview.hook_error", { requestId, error: String(e).slice(0, 200) }, { level: "warn" });
  }
}

export async function orchestrate(
  message: string,
  opts: {
    projectId?: string; channel?: Channel; from?: string; history?: { role: string; text: string }[];
    // Who is asking (2026-09 origin-aware autonomy). The planner only ever serves the owner directly
    // or CLARA's verified bridge (api/friday/chat decides which), so the default is "owner"; the
    // stamp rides every task it creates and decides whether dispatch/deploy waits for approval.
    requestOrigin?: RequestOrigin;
    // Ground the planner in live Orion data (audit gap 2): the planner call runs on Claude with
    // the READ-ONLY OS MCP tools (projects, project_tasks, tickets, CRs, approvals, runs, …) so an
    // OS-thread question is answered from the OS, not just the local mirror. Never grants writes.
    osRead?: boolean;
  } = {},
): Promise<OrchestrateResult> {
  // OS agent settings: FRIDAY paused/disabled → no planning, no new tasks, no dispatch — say why.
  const { getAgentSettings, refusalFor, applyPersona, settingsFor } = await import("@/lib/friday/agentSettings");
  const settings = await getAgentSettings({ maxWaitMs: 3_000 });
  const pausedReply = refusalFor(settings);
  if (pausedReply) {
    await logEvent("agent_settings.orchestrate_refused", { channel: opts.channel ?? "web" }, { level: "warn", projectId: opts.projectId }).catch(() => {});
    return { reply: pausedReply, intent: "paused", tasks: [], runs: [], approvals: [] };
  }
  await seedAgents();
  const channel = opts.channel ?? "web";
  const requestOrigin: RequestOrigin = opts.requestOrigin ?? "owner";

  await store.messages.append({ id: newId(), channel, role: "user", text: message, ts: nowISO(), projectId: opts.projectId });
  await appendFridayLog({ kind: "chat", actor: "You", text: message });

  // 1 — plan (recent conversation lets FRIDAY run multi-turn flows like client intake)
  const context = await buildContext(opts.projectId);
  let histArr = opts.history ?? [];
  if (!histArr.length && (channel === "sms" || channel === "voice")) {
    // SMS/voice don't carry client-side history — reconstruct it from the stored thread
    // (excluding the just-appended current message) so intake works across texts/turns.
    const recent = await store.messages.tail(12, (m) => m.channel === channel);
    histArr = recent.slice(0, -1).map((m) => ({ role: m.role === "user" ? "user" : "friday", text: m.text }));
  }
  const history = histArr.slice(-10).map((h) => `${h.role === "user" ? OWNER_FIRST : "FRIDAY"}: ${h.text}`).join("\n");
  // Institutional memory: pull semantically-relevant past deliverables/decisions across the business
  // so the planner answers from history, not cold. Scoped to a project when the chat is project-bound.
  // Vault memory first: where each project in play was left off, so the plan continues work instead
  // of re-creating tasks or PRs that already exist.
  const vault = await (await import("@/lib/friday/vaultMemory")).memoryForMessage(message, { projectId: opts.projectId }).catch(() => "");
  const memory = vault + (await recallBlock(message, { projectId: opts.projectId, limit: 4 }).catch(() => ""));
  const osGrounding = opts.osRead
    ? "\n\nYou have READ-ONLY Orion tools (mcp__orion__*_list / *_get / *_search). The OS is the source of truth for projects, project tasks, support tickets, change requests, approvals, code runs and client reviews — the Context above is only FRIDAY's local mirror. Look things up before answering a question about them, and answer from what you found. You cannot change anything through these tools."
    : "";
  const plan = await completeJSON<PlannerOutput>({
    // OS grounding needs the Claude CLI (the only engine wired to the OS MCP); otherwise as before.
    engine: opts.osRead ? "claude" : channel === "voice" ? voiceEngine() : defaultEngine(), // faster local brain on live calls
    system: plannerSystem(teamRoster(), assigneeIds().map((a) => `"${a}"`).join(" | "), (p) => applyPersona(p, settingsFor(settings))) + osGrounding,
    prompt: `Context:\n${context}${memory}\n\n${history ? `Recent conversation:\n${history}\n\n` : ""}${OWNER_FIRST}'s latest message:\n${message}`,
    timeoutMs: channel === "voice" ? 30_000 : opts.osRead ? 240_000 : 120_000,
    ...(opts.osRead ? { os: true, osReadOnly: true } : {}),
  });

  if (!plan) {
    const reply = "I couldn't form a clean plan from that — could you rephrase, or tell me the client and the outcome you want?";
    await store.messages.append({ id: newId(), channel, role: "friday", text: reply, ts: nowISO() });
    return { reply, intent: "chat", tasks: [], runs: [], approvals: [] };
  }

  const result: OrchestrateResult = { reply: plan.reply, intent: plan.intent, tasks: [], runs: [], approvals: [] };
  await store.messages.append({ id: newId(), channel, role: "friday", text: plan.reply, ts: nowISO(), projectId: opts.projectId });
  await appendFridayLog({ kind: "plan", text: plan.reply });

  // Action on EXISTING data (status / update / dispatch / send report) — resolve + reply, create nothing.
  if (plan.action?.kind) {
    const actionReply = await handleAction(plan.action, requestOrigin);
    if (actionReply) {
      result.reply = actionReply;
      result.intent = plan.action.kind;
      await store.messages.append({ id: newId(), channel, role: "friday", text: actionReply, ts: nowISO(), projectId: opts.projectId });
      return result;
    }
  }

  // Intake in progress — FRIDAY is still asking for details. Reply only; create nothing.
  if (plan.intent === "collect_client" || plan.intent === "collect_project") return result;

  // 2 — materialise client (with all the details FRIDAY gathered; fill in gaps on an existing one)
  let client: Client | null = null;
  if (plan.client?.name) {
    const pc = plan.client;
    const details = {
      email: pc.email, phone: pc.phone, company: pc.company, jobTitle: pc.jobTitle,
      addressLine: pc.addressLine, city: pc.city, state: pc.state, postalCode: pc.postalCode,
    };
    const clients = await listClients();
    client = matchClient(clients, pc.name);
    if (!client) {
      client = await createClient({ name: pc.name, ...details });
    } else {
      // fill in any newly-provided details that the existing client is missing
      const cur = client as unknown as Record<string, unknown>;
      const fill = Object.fromEntries(Object.entries(details).filter(([k, v]) => v && !cur[k]));
      if (Object.keys(fill).length) client = (await updateClient(client.id, fill)) ?? client;
    }
    result.client = client;
  }

  // 3 — materialise project
  let project: Project | null = opts.projectId ? await store.projects.get(opts.projectId) : null;
  if (plan.project?.name) {
    const pp = plan.project;
    // resolve the client: from the client FRIDAY just gathered, or by the project's clientName
    let projClient = client;
    if (!projClient && pp.clientName) {
      const clients = await listClients();
      projClient = matchClient(clients, pp.clientName) ?? await createClient({ name: pp.clientName });
    }
    // "get it from the meeting" → pull the client's latest meeting summary as the description
    let description = pp.description;
    if (pp.fromMeeting && !description) {
      description = await meetingDescriptionForClient(projClient?.name);
    }
    // Match an EXISTING project (fuzzily, scoped to the client) before creating a new one — so
    // "coach tool" resolves to the client's "AI Coach Tool" instead of spawning a duplicate.
    const candidates = projClient ? await listProjects(projClient.id) : await store.projects.all();
    project = matchProject(candidates, pp.name);
    if (!project) {
      const clientId = projClient?.id ?? (await ensureUnassignedClient()).id;
      project = await createProject({
        clientId, name: pp.name, description, stack: pp.stack,
        startDate: pp.startDate, targetEndDate: pp.targetEndDate,
        budget: typeof pp.budget === "number" ? pp.budget : undefined,
      });
    }
    result.project = project;
    result.client = result.client ?? projClient ?? undefined;
  }

  // 4 — materialise tasks
  const createdTasks: Task[] = [];
  if (Array.isArray(plan.tasks) && plan.tasks.length && project) {
    for (const t of plan.tasks) {
      const task = await createTask({
        projectId: project.id,
        title: t.title,
        status: DEFAULT_STAGE,
        assignee: resolveAssignee(t.assignee),
        risk: t.risk ?? "low",
        origin: channel,
        originContact: channel === "sms" || channel === "voice" ? opts.from : undefined,
        requestedBy: OWNER, // the planner runs on the owner's own asks
        requestOrigin,
      });
      createdTasks.push(task);
    }
  }
  result.tasks = createdTasks;

  // 5 — dispatch (with approval gate)
  if (plan.dispatch && createdTasks.length) {
    for (const task of createdTasks) {
      if (task.assignee === "human") continue;
      const agent = await pickAgent(task);
      if (!agent) continue;
      // Planner tasks carry only a title, so the request that produced them is scanned too.
      if (dispatchApprovalReason(task, project, message)) {
        result.approvals.push(await queueApproval(task, agent));
      } else {
        result.runs.push(await dispatchRunAsync(agent, task, project, channel));
      }
    }
  }

  // Vault memory: the planning decision itself is a completion — each new task opens its thread.
  for (const task of createdTasks) {
    await remember({
      project, task, kind: "plan", title: task.title, outcome: "info",
      summary: `Planned from ${OWNER_FIRST}'s ${channel} message: "${message.slice(0, 200)}"`,
      next: result.approvals.some((a) => a.taskId === task.id) ? "Waiting on approval before dispatch."
        : result.runs.some((r) => r.taskId === task.id) ? "Dispatched to an agent." : "Queued on the board; not dispatched yet.",
    });
  }

  return result;
}

// Pull a project description from the client's latest Google Meet call, if connected.
async function meetingDescriptionForClient(clientName?: string): Promise<string | undefined> {
  try {
    const { googleConfigured } = await import("@/lib/friday/google/auth");
    if (!googleConfigured()) return undefined;
    const { listRecentMeetings } = await import("@/lib/friday/google/meet");
    const meetings = await listRecentMeetings(21, 8);
    if (!meetings.length) return undefined;
    // prefer a meeting whose transcript/participants mention the client; else the most recent
    const match = (clientName && meetings.find((m) => `${m.text} ${m.participants.join(" ")}`.toLowerCase().includes(clientName.toLowerCase()))) || meetings[0];
    const summary = await complete({
      engine: defaultEngine(),
      system: "Summarise this client meeting into a clear project description: scope, goals, key decisions, and constraints. 4-8 sentences, plain prose.",
      prompt: match.text.slice(0, 12000),
      timeoutMs: 90_000,
    });
    return summary?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Fallback bucket so orphan projects still have a client.
async function ensureUnassignedClient(): Promise<Client> {
  const clients = await listClients();
  const found = clients.find((c) => c.name === "Unassigned");
  if (found) return found;
  return createClient({ name: "Unassigned", status: "active" });
}

// Dispatch a single existing task on demand (from the project board). Respects the
// approval gate: risky/external tasks queue an approval instead of running immediately.
export async function dispatchTask(taskId: string): Promise<{ run?: AgentRun; approval?: Approval; error?: string; started?: boolean }> {
  await seedAgents();
  const task = await store.tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.assignee === "human") return { error: "task is assigned to a human" };
  const agent = await pickAgent(task); // may delegate to an imported specialist
  if (!agent) return { error: `agent ${task.assignee} not found` };
  // OS agent settings: say why up front instead of starting a run executeRun would refuse anyway.
  const settingsRefusal = await (await import("@/lib/friday/usage")).settingsRunRefusal(agent);
  if (settingsRefusal) return { error: settingsRefusal };
  const project = await store.projects.get(task.projectId);

  // SELF-EDIT GATE (0.1). A write-role agent whose working dir IS FRIDAY's own source can modify the
  // live system mid-conversation. The only way that happens is a project whose workspaceDir points at
  // the app root (repos always clone elsewhere), so we check that directly — no clone side effect. This
  // reads the resolved PATH + the risk flag, never the task's text, so an injected "already approved"
  // in the description can't get past it.
  if (project && WRITE_ROLES.includes(agent.role) && isSelfSourceDir(project.workspaceDir)) {
    if (!selfEditEnabled()) {
      await updateTask(task.id, { status: "blocked" });
      await logEvent("selfedit.blocked", { task: task.title, role: agent.role, dir: project.workspaceDir }, { level: "warn", projectId: task.projectId });
      const { notifyOwner } = await import("@/lib/friday/notify");
      await notifyOwner({ kind: "security.finding", priority: "critical", emergencyCategory: "security", headline: `Blocked a self-edit task: ${task.title.slice(0, 50)}`, summary: `${agent.role} tried to work on FRIDAY's own source. Self-edit is gated pending the deploy pipeline (Task 2.1); nothing ran. Set SELF_EDIT_ENABLED=true to override.`, text: `Blocked a self-edit task — "${task.title.slice(0, 50)}" (${agent.role} → FRIDAY's own source). Self-edit is gated pending the deploy pipeline (Task 2.1). Set SELF_EDIT_ENABLED=true to override.`, dedupeKey: `selfedit:${task.id}` }).catch(() => {});
      return { error: "Self-edit is gated pending the deploy pipeline (Task 2.1)." };
    }
    // Override ON: force critical risk + require an explicit approval record before ANY dispatch,
    // regardless of what the planner set. `selfEdit` tells the origin-aware authority this is the
    // self-edit gate (Tier 3 for every origin, owner included) — belt and braces with the critical risk.
    const bumped = task.risk === "critical" ? task : ((await updateTask(task.id, { risk: "critical" })) ?? task);
    return { approval: await queueApproval(bumped, agent, undefined, { selfEdit: true }) };
  }

  if (dispatchApprovalReason(task, project)) return { approval: await queueApproval(task, agent) };
  // Async: return the running run immediately; the agent works in the background and notifies on done.
  return { run: await dispatchRunAsync(agent, task, project, task.origin), started: true };
}

// Approve/reject a queued approval; on approval, run the agent now.
// In-flight decisions, so two near-simultaneous calls (dashboard double-click; email reply racing a
// dashboard click) can't both pass the pending check below. Not a disk-level CAS — the store is a
// single-process load-modify-write — but the serialized store + this Set + human-timescale inputs
// close the race in practice.
const decidingNow = new Set<string>();

export async function decideApproval(
  id: string,
  decision: "approved" | "rejected",
  opts?: { source?: "email" | "sms" | "web" | "os" | "clara"; decidedBy?: string }, // "os" = hub decision (osApprovalsBridge); "clara" = the owner answered through CLARA
): Promise<Approval | null> {
  // FIRST DECISION WINS. Without this, a second call re-fired sendDraft (double client email) or
  // dispatchRunAsync (double agent run) — a live bug reachable from a dashboard double-click alone.
  if (decidingNow.has(id)) return (await store.approvals.get(id)) ?? null;
  const existing = await store.approvals.get(id);
  if (!existing) return null;
  if (existing.status !== "pending") return existing; // already decided/expired — no side effects, ever
  // The OS approval queue is the ONLY authority for an ask that has been raised there (contract §3):
  // a local surface (SMS / email reply / dashboard / CLARA relay) can no longer decide it — the
  // owner decides in the OS and the bridge applies it with source "os".
  if (existing.hubId && (opts?.source ?? "web") !== "os") {
    await logEvent("approval.local_decide_refused", { id, decision, source: opts?.source ?? "web", hubId: existing.hubId }, { level: "warn", projectId: existing.projectId }).catch(() => {});
    return existing;
  }
  decidingNow.add(id);
  try {
    const { approval: decided, won } = await decideApprovalInner(id, decision, opts?.source ?? "web", opts?.decidedBy);
    // Wave-3 OS bridge: this is THE local decide spine, so a successful decision supersedes the
    // hub mirror row here (best-effort, not awaited). Skipped for hub-originated decisions
    // (source "os") — that hub row is already decided and the pull loop acks it; closing would
    // be a pointless round-trip — and for lost CAS races, where the winner's own call already
    // closed the hub row with the decision that actually executed. If the hub decided first AND
    // differently, closeApproval logs the conflict — the local decision already executed and
    // CAS means first-wins.
    if (decided && won && opts?.source !== "os") {
      void (async () => {
        const { closeApproval } = await import("@/lib/friday/osApprovalsBridge");
        await closeApproval(id, decision);
      })().catch(() => {});
    }
    return decided;
  } finally {
    decidingNow.delete(id);
  }
}

async function decideApprovalInner(
  id: string,
  decision: "approved" | "rejected",
  source: string,
  decidedBy?: string,
): Promise<{ approval: Approval | null; won: boolean }> {
  // Disk-level CAS: the status write commits ONLY if the row is still pending at the moment the
  // store's serialized mutation re-reads it. The decidingNow Set guards one JS process's callers;
  // this closes the read-before-effect race between the SAME process's other entry points
  // (dashboard POST, approval-email poller, OS bridge pull, cron-triggered sweeps), any of which
  // can check `pending` and then lose the write. Cross-PROCESS atomicity is explicitly out of
  // scope: FRIDAY runs a single Next process bound to loopback, and the store's cross-process
  // lock is deliberately off (see persistence/store.ts).
  const approval = await store.approvals.update(id, { status: decision, decidedAt: nowISO(), decidedBy: decidedBy ?? source }, { onlyIf: (r) => r.status === "pending" });
  if (!approval) {
    // Row gone, or another caller decided first — return the winner's row, fire NO side effects.
    const current = await store.approvals.get(id);
    if (current) await logEvent("approval.decision_lost_race", { id, decision, source, winner: current.status }, { level: "warn", projectId: current.projectId });
    return { approval: current, won: false };
  }
  await logEvent("approval.decision", { id, decision, source, decidedBy: decidedBy ?? source }, { projectId: approval.projectId });
  if (source === "clara") await logEvent("approval.decided_via_clara", { id, decision, decidedBy }, { projectId: approval.projectId });
  if (approval.projectId) {
    const proj = await store.projects.get(approval.projectId).catch(() => null);
    const t = approval.taskId ? await store.tasks.get(approval.taskId).catch(() => null) : null;
    await remember({
      project: proj, task: t ?? undefined, kind: "approval", title: t?.title ?? approval.action,
      outcome: decision === "approved" ? "done" : "declined",
      summary: `${decision === "approved" ? "Approved" : "Rejected"} by ${decidedBy ?? source}: ${approval.action.slice(0, 300)}`,
    });
  }
  // Format registry (Wave-2 Track B): a HUMAN approve of a format-stamped row grants that
  // (clientId, formatKind) — later instances of the same format ride Tier 2. Auto-approved rows
  // never re-grant (the grant is exactly the human's first-of-kind sign-off); a reject grants
  // nothing. Best-effort: the decision stands regardless.
  if (decision === "approved" && approval.formatKind && !approval.autoApproved) {
    void (async () => {
      let clientId = approval.emailClientId;
      if (!clientId && approval.projectId) {
        clientId = (await store.projects.get(approval.projectId).catch(() => null))?.clientId;
      }
      if (!clientId) return;
      const { grantFormat } = await import("@/lib/friday/formatRegistry");
      await grantFormat(clientId, approval.formatKind!, { approvalId: approval.id });
    })().catch(() => {});
  }
  // GAP-B-2 (2026-07-23): idempotency check on APPROVED decisions BEFORE any side effect fires.
  // Prevents cross-process double-fire (supervisor respawn mid-decideApprovalInner) or a manual
  // re-approve of a rebuilt row from deploying/sending/dispatching a second time. Rejected
  // decisions have no side effects to guard, so skip the check.
  if (decision === "approved" && approval.idempotencyKey) {
    const { idempotencyAlreadyExecuted } = await import("@/lib/friday/idempotency");
    const winner = await idempotencyAlreadyExecuted(approval.idempotencyKey, approval.id);
    if (winner) {
      const note = `idempotent no-op: approval ${winner.id.slice(0, 8)} already executed same intent at ${winner.executedAt} (key ${approval.idempotencyKey})`;
      const patched = await store.approvals.update(id, { executedAt: nowISO(), resultNote: note });
      await logEvent("approval.idempotent_skip", { id, winnerId: winner.id, key: approval.idempotencyKey }, { level: "warn", projectId: approval.projectId });
      return { approval: patched ?? approval, won: true };
    }
  }
  // Close the loop in the approval's email thread (no-op when there is no thread). Fire-and-forget:
  // the decision stands regardless of whether the confirmation lands.
  void (async () => {
    const { noteDecisionInThread } = await import("@/lib/friday/approvalEmail");
    await noteDecisionInThread(approval, decision, source);
  })().catch(() => {});
  // Email-reply approval: approve → send the drafted reply (from FRIDAY, owner already CC'd);
  // reject → discard the draft. No agent dispatch involved.
  if (approval.emailDraftId) {
    const { sendDraft, deleteDraft } = await import("@/lib/friday/google/gmail");
    const acct = approval.emailAccount ?? "friday";
    // Master gate: even an approved reply must not send — FRIDAY no longer emails clients.
    const { clientCommsEnabled } = await import("@/lib/friday/clientComms");
    if (decision === "approved" && !clientCommsEnabled()) {
      await deleteDraft(approval.emailDraftId, acct).catch(() => {});
      await logEvent("email.reply.blocked", { approval: id, reason: "client comms disabled" }, { level: "warn", projectId: approval.projectId });
      await store.approvals.update(id, { status: "rejected", resultNote: "client comms disabled — FRIDAY no longer emails clients; CLARA drafts for the owner" }).catch(() => {});
      const { notifyOwner } = await import("@/lib/friday/notify");
      await notifyOwner({ kind: "email", text: "Client email replies are off for FRIDAY now — CLARA drafts these in your inbox. Discarded the queued reply.", dedupeKey: `emailblocked:${id}` }).catch(() => {});
      return { approval: (await store.approvals.get(id)) ?? approval, won: true };
    }
    if (decision === "approved") {
      const res = await sendDraft(approval.emailDraftId, acct);
      await logEvent("email.reply.sent", { approval: id, ok: res.ok, via: "approval" }, { level: res.ok ? "info" : "warn", projectId: approval.projectId });
      // Now that it actually sent, remember the reply so it shows in the client's Memory panel.
      if (res.ok && approval.emailClientId && approval.emailBody) {
        const { rememberReply } = await import("@/lib/friday/emailAgent");
        const clientName = approval.action.replace(/^Email reply to /, "").split(" — ")[0] || "Client";
        await rememberReply(approval.emailClientId, approval.projectId, clientName, approval.action.split(" — ").slice(1).join(" — ") || "Reply", approval.emailBody).catch(() => {});
      }
      const { notifyOwner } = await import("@/lib/friday/notify");
      await notifyOwner({ kind: "email", text: res.ok ? "✉️ Sent the approved client reply (you're CC'd)." : `⚠️ Couldn't send the approved reply: ${res.error}`, dedupeKey: `emailsent:${id}` }).catch(() => {});
      if (res.ok) {
        await store.approvals.update(id, { executedAt: nowISO() }).catch(() => {});
      } else {
        // The send never happened, so an "approved + executedAt" row would be a lie the UI
        // repeats forever — and status !== "pending" blocks every retry. Return the row to
        // pending so the owner can re-approve once Gmail recovers (no executedAt = the
        // idempotency window never opens for this failed attempt).
        await store.approvals.update(id, { status: "pending", resultNote: `send failed: ${String(res.error ?? "unknown").slice(0, 160)} — returned to pending for retry` }).catch(() => {});
      }
    } else {
      await deleteDraft(approval.emailDraftId, acct).catch(() => {});
      await logEvent("email.reply.discarded", { approval: id }, { projectId: approval.projectId });
    }
    return { approval, won: true };
  }
  // Intent-router gate: approving runs the tool the router queued.
  //
  // This branch is what makes the router's approvals real. A row with no executor branch flips to
  // "approved", tells the owner "running it now", and does nothing — which is worse than refusing,
  // because they stop watching. The tool is re-resolved from the catalog by name rather than being
  // stored as a closure, so a queued approval survives a restart.
  if (approval.intentTool) {
    if (decision === "approved") {
      const { notifyOwner } = await import("@/lib/friday/notify");
      const { TOOLS } = await import("@/lib/friday/intent");
      const tool = TOOLS.find((t) => t.name === approval.intentTool);
      if (!tool) {
        await logEvent("intent.approved_tool_missing", { id, tool: approval.intentTool }, { level: "error" });
        await notifyOwner({ kind: "task", priority: "critical", text: `⚠️ You approved "${approval.action}" but I no longer have a tool called ${approval.intentTool}. NOTHING RAN.`, dedupeKey: `intentmissing:${id}` }).catch(() => {});
        await store.approvals.update(id, { resultNote: `tool ${approval.intentTool} not found — nothing ran` }).catch(() => {});
        return { approval, won: true };
      }
      const out = await tool.run(approval.intentArgs ?? {}, { principal: "owner", source: "sms" })
        .catch((e) => ({ ok: false, line: `${approval.intentTool}: FAILED — ${String(e).slice(0, 200)}` }));
      await logEvent("intent.approved_run", { id, tool: approval.intentTool, ok: out.ok }, { level: out.ok ? "info" : "warn" });
      await notifyOwner({ kind: "task", priority: out.ok ? "normal" : "critical", text: out.line.slice(0, 1200), dedupeKey: `intentrun:${id}` }).catch(() => {});
      // executedAt only when the tool reported success — a failed run may have had partial
      // effects, so it is NOT silently returned to pending (the critical notify above carries
      // the failure); but stamping it "executed" would hide that nothing (fully) ran.
      if (out.ok) await store.approvals.update(id, { executedAt: nowISO(), resultNote: out.line.slice(0, 400) }).catch(() => {});
      else await store.approvals.update(id, { resultNote: `FAILED (not executed): ${out.line.slice(0, 360)}` }).catch(() => {});
    } else {
      await logEvent("intent.rejected", { id, tool: approval.intentTool });
    }
    return { approval, won: true };
  }
  // PR shepherd merge gate: an approved Tier-3 merge goes back to the shepherd with authority
  // satisfied; it re-runs the whole gate (checks/review/conflicts) before landing anything.
  if (approval.mergePrUrl) {
    if (decision === "approved") {
      try {
        const { shepherdOne } = await import("@/lib/friday/prShepherd");
        const res = await shepherdOne(approval.mergePrUrl, { trigger: "approval", approved: true });
        await logEvent("pr.shepherd.approved_merge", { pr: approval.mergePrUrl, action: res.action.kind, applied: res.applied, note: res.note }, { projectId: approval.projectId });
        if (res.applied && res.action.kind === "merge") await store.approvals.update(id, { executedAt: nowISO() }).catch(() => {});
        else await store.approvals.update(id, { resultNote: `not merged yet: ${res.note ?? res.action.kind}` }).catch(() => {});
      } catch (e) {
        await store.approvals.update(id, { resultNote: `merge failed: ${String(e).slice(0, 160)}` }).catch(() => {});
      }
    } else {
      await logEvent("pr.shepherd.merge_rejected", { pr: approval.mergePrUrl }, { projectId: approval.projectId });
    }
    return { approval, won: true };
  }
  // In-process Netlify deploy gate: the build fires ONLY here, on approval, re-reading the row (the
  // update above already flipped status to "approved" atomically, so a double-decision can't re-fire).
  if (approval.deployProjectId) {
    if (decision === "approved") {
      const project = await store.projects.get(approval.deployProjectId);
      const { notifyOwner } = await import("@/lib/friday/notify");
      if (!project) {
        await notifyOwner({ kind: "deploy", priority: "critical", text: `⚠️ Approved deploy, but the project (${approval.deployProjectId}) is gone. Nothing shipped.`, dedupeKey: `deploygone:${id}` }).catch(() => {});
        await store.approvals.update(id, { resultNote: "project missing — nothing shipped" }).catch(() => {});
      } else {
        // A thrown deploy is a deploy that did NOT happen — mapping it to handled:true used to
        // stamp executedAt on a build that never fired, and status !== "pending" then blocked
        // every retry while the UI said "shipped".
        const res = await deployNetlify(project, { clearCache: !!approval.deployClearCache }).catch((e) => ({ handled: false, message: `Deploy error: ${String(e).slice(0, 160)}` }));
        await logEvent("deploy.approved_run", { project: project.id, ok: res.handled }, { projectId: project.id });
        await notifyOwner({ kind: "deploy", priority: res.handled ? "normal" : "critical", text: res.message || `Triggered the deploy for ${project.name}.`, dedupeKey: `deployrun:${id}` }).catch(() => {});
        if (res.handled) await store.approvals.update(id, { executedAt: nowISO() }).catch(() => {});
        else await store.approvals.update(id, { status: "pending", resultNote: `deploy failed: ${String(res.message ?? "unknown").slice(0, 160)} — returned to pending for retry` }).catch(() => {});
      }
    } else {
      await logEvent("deploy.rejected", { project: approval.deployProjectId }, { projectId: approval.projectId });
    }
    return { approval, won: true };
  }
  if (decision === "approved" && approval.taskId) {
    try {
      const task = await store.tasks.get(approval.taskId);
      if (task) {
        // A Tier-3 (owner-approved) client request now advances its lifecycle: logged → in_progress.
        if (task.requestId) {
          const { transition } = await import("@/lib/friday/requests");
          await transition(task.requestId, "in_progress").catch(() => {});
        }
        const agent = await pickAgent(task); // may delegate to an imported specialist
        const project = await store.projects.get(task.projectId);
        if (agent) await dispatchRunAsync(agent, task, project, task.origin);
        await store.approvals.update(id, agent ? { executedAt: nowISO() } : { resultNote: `no agent for assignee ${task.assignee} — nothing dispatched` }).catch(() => {});
      } else {
        await store.approvals.update(id, { resultNote: "task missing — nothing dispatched" }).catch(() => {});
      }
    } catch (e) {
      // A thrown dispatch used to strand the row at approved-without-executedAt — undecidable
      // and unretryable. Return it to pending so a re-approve can retry the dispatch.
      await logEvent("approval.dispatch_failed", { id, error: String(e).slice(0, 200) }, { level: "warn", projectId: approval.projectId });
      await store.approvals.update(id, { status: "pending", resultNote: `dispatch failed: ${String(e).slice(0, 160)} — returned to pending for retry` }).catch(() => {});
    }
  } else if (decision === "rejected" && approval.taskId) {
    await updateTask(approval.taskId, { status: DEFAULT_STAGE });
    const task = await store.tasks.get(approval.taskId);
    if (task?.requestId) {
      const { transition } = await import("@/lib/friday/requests");
      await transition(task.requestId, "cancelled", { closedReason: "cancelled" }).catch(() => {});
    }
  }
  return { approval, won: true };
}

/**
 * Dispatch approval gate. A retainer client's project (retainer.ts — matched by FRIDAY's own project
 * and client records, never by sender text) skips the title-keyword trigger for ordinary product work;
 * risk high/critical and genuinely risky actions still gate (risk.approvalReason). Everyone else keeps
 * needsApproval unchanged.
 */
export function dispatchApprovalReason(task: Task, project: Pick<Project, "id" | "clientId"> | null | undefined, requestText?: string): string | null {
  const retainer = isRetainer({ projectId: project?.id ?? task.projectId, clientId: project?.clientId });
  return approvalReason(task, { retainer, requestText });
}
