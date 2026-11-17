// FRIDAY deliverables — turns a finished agent run into durable, visible outputs:
//   • QA/review roles → a client-ready PDF report (pdf-lib)
//   • coding roles     → a GitHub PR link + a per-repo change summary
// then records a short summary + artifacts on the run, mirrors them to the activity feed and
// the project's Obsidian log, and — if the task came in over SMS/voice — texts the result back.
// Everything here is best-effort; callers wrap it so a failure never un-completes the run.

import { store, logEvent } from "@/lib/persistence/store";
import { renderReportPdf } from "@/lib/friday/pdf";
import { saveArtifact, linkArtifact } from "@/lib/friday/artifacts";
import { summarizeCodeRun, prState } from "@/lib/friday/codeSummary";
import { isSelfSourceDir } from "@/lib/friday/delivery";
import { twilioConfig } from "@/lib/friday/channels";
import { notifyOwner } from "@/lib/friday/notify";
import { baseTitle, runEndNotifyTarget } from "@/lib/friday/notifyBack";
import type { Agent, AgentRun, Artifact, Project, Task } from "@/lib/friday/types";

const CODING_ROLES = ["architect", "dev", "devops", "debug", "designer"];
const ALL_CODING_ROLES = [...CODING_ROLES, "qa", "review"];

// "https://github.com/owner/repo/pull/42" → "owner/repo#42"
function prLabel(url: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : "Pull request";
}

// The delimiter deliverable agents append their client-facing recap under (see agents.ts prompts).
// Everything BELOW it is safe to show a client; everything above is internal candor (file paths,
// "VERDICT: FAIL", blocker/should-fix notes) that must never reach them.
export const CLIENT_SUMMARY_MARKER = /(^|\n)\s*#{0,3}\s*\**\s*client[\s_-]*summary\s*:?\**\s*(\n|$)/i;

/**
 * Extract ONLY the client-safe portion of an agent's raw output — the text under its `## CLIENT
 * SUMMARY` marker. Returns null if the agent didn't emit one (caller must then fall back to a derived
 * safe summary, NEVER the raw blob).
 */
export function clientSafeBlock(raw: string): string | null {
  const m = raw.match(CLIENT_SUMMARY_MARKER);
  if (!m || m.index == null) return null;
  const after = raw.slice(m.index + m[0].length).trim();
  return after.length >= 8 ? after : null;
}

/**
 * The text to render into any client-facing artifact. Prefers the agent's CLIENT SUMMARY block;
 * degrades to a one-line derived summary (the first substantive line, already markdown-stripped) plus
 * a neutral note — so a missing block yields a thin-but-safe deliverable, never leaked raw candor.
 */
export function clientSafeText(raw: string): string {
  const block = clientSafeBlock(raw);
  if (block) return block;
  const line = deriveSummary(raw);
  return `${line}\n\nFull details are available on request.`;
}

// A short human recap of the result: the first substantive line, cleaned of markdown.
function deriveSummary(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    const clean = l.replace(/^#+\s*/, "").replace(/^[-*+]\s*/, "").replace(/[*_`>]/g, "").trim();
    if (clean.length >= 12) return clean.slice(0, 240);
  }
  return text.trim().slice(0, 240) || "Done.";
}

function humanDate(): string {
  try { return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }); }
  catch { return ""; }
}

export async function finalizeRun(run: AgentRun, task: Task, project: Project | null, agent: Agent): Promise<Artifact[]> {
  const result = run.result ?? "";
  const artifacts: Artifact[] = [];

  // Deploy write-back: a devops "deploy" run that reports a live URL updates Project.deployUrl.
  if (project && agent.role === "devops" && /\bdeploy|ship|go ?live|netlify\b/i.test(task.title)) {
    const url = result.match(/https?:\/\/[^\s)"']*netlify\.app[^\s)"']*/i)?.[0]
      ?? result.match(/(?:live|deploy(?:ed)?|production|url)[^\n]*?(https?:\/\/[^\s)"']+)/i)?.[1];
    if (url) {
      const { updateProject } = await import("@/lib/friday/repo");
      await updateProject(project.id, { deployUrl: url.replace(/[.,;)]+$/, "") }).catch(() => {});
      artifacts.push(linkArtifact("file", "Live site", url.replace(/[.,;)]+$/, "")));
    }
  }

  // Code deliverables: PR link + change summary from the real checkout — VERIFIED against reality.
  // A coding agent that only produced prose (or hallucinated a PR URL) must not yield a fake PR
  // artifact. We accept a PR only if `gh` can actually see it, and flag the run when a write role
  // shows neither a real PR nor any real git change.
  let verificationFailed = false;
  if (project && CODING_ROLES.includes(agent.role)) {
    try {
      // A shepherd round ran in a PR-branch worktree — summarize THAT checkout, not the owner's.
      // Any worktree run (PR round or fresh task) — summarize THAT checkout, not the owner's.
      const { isWorktreeDir, taskRepoFor } = await import("@/lib/friday/delivery");
      const inWorktree = !!run.cwd && isWorktreeDir(run.cwd);
      const cs = await summarizeCodeRun(project, result, inWorktree ? { dirs: [{ url: task.prUrl ?? taskRepoFor(project) ?? run.cwd!, dir: run.cwd! }] } : {});
      const prVerified = cs.prUrl ? await prState(cs.prUrl) : ""; // "OPEN"|"MERGED"|"CLOSED"|""
      if (cs.prUrl && prVerified) {
        artifacts.push(linkArtifact("pr", prLabel(cs.prUrl), cs.prUrl));
        // Lineage: the task now knows which PR its work lives on AND its head branch, so every
        // follow-up round (QA fix, review, rebase) runs on that branch instead of opening a second
        // PR (mai-dash #90/#91, 2026-09-25: the fix round had no prUrl/prHeadRef and cut a new PR).
        const { updateTask } = await import("@/lib/friday/repo");
        const { prReadiness } = await import("@/lib/friday/prGate");
        const head = await prReadiness(cs.prUrl).then((r) => r?.headRefName).catch(() => undefined);
        await updateTask(task.id, { prUrl: cs.prUrl, ...(head ? { prHeadRef: head } : {}) }).catch(() => {});
        task.prUrl = cs.prUrl;
        if (head) task.prHeadRef = head;
      }
      if (cs.changeSummary) {
        artifacts.push(await saveArtifact(run.id, {
          kind: "summary", label: "change-summary", ext: ".md", mime: "text/markdown",
          bytes: Buffer.from(`# Code changes — ${task.title}\n\n${cs.changeSummary}\n`, "utf8"),
        }));
      }
      // Claimed a PR gh can't see, OR produced no PR and no real git change → not real work.
      verificationFailed = (!!cs.prUrl && !prVerified) || (!cs.prUrl && !cs.changeSummary);
    } catch { /* best-effort — a git/gh failure shouldn't crash finalize; leave unflagged */ }
  }

  // Client-ready PDF reports. Each producing role maps to a deliverable type + a Drive library folder.
  // (debug is a coding role, but its diagnosis IS a client-facing "Bug Report" — render + file it too.)
  const REPORT_LABEL: Partial<Record<string, string>> = {
    qa: "QA Report", review: "Code Review", seo: "SEO Audit", "research-qa": "Research", debug: "Bug Report",
  };
  if (REPORT_LABEL[agent.role] && result.trim().length > 40) {
    try {
      const client = project ? await store.clients.get(project.clientId) : null;
      // Render from ONLY the client-safe block — a QA report PDF must carry the client-facing recap,
      // never the raw "VERDICT: FAIL / blocker / <file paths>" candor the agent also produces.
      const pdf = await renderReportPdf({
        title: task.title, bodyMarkdown: clientSafeText(result),
        project: project?.name, client: client?.name, date: humanDate(),
      });
      artifacts.push(await saveArtifact(run.id, {
        kind: "pdf", label: `${task.title} — ${REPORT_LABEL[agent.role]}`, ext: ".pdf", mime: "application/pdf", bytes: pdf,
      }));
      // NOTE: the raw PDF is NO LONGER auto-filed to the client's Drive on every run. Deliverables reach
      // the client only through a reviewed path (client-review email / an owner send_report), so an
      // unreviewed intermediate never lands in their library. (1E: kill the silent Drive auto-file.)
    } catch { /* best-effort */ }
  }

  let summary = deriveSummary(result);
  // A coding run that couldn't be verified (no real PR/commit) is flagged, not trusted — the summary
  // says so, the run is marked, and the owner is told. Prevents fabricated "done" from looking real.
  if (verificationFailed) {
    summary = `UNVERIFIED — no real PR/commit found for this coding task. ${summary}`;
    await logEvent("deliver.unverified", { agent: agent.id, task: task.title, engine: run.servedEngine ?? agent.engine }, { level: "warn", runId: run.id, projectId: task.projectId });
    await notifyOwner({ kind: "run.error", priority: "normal", text: `"${task.title.slice(0, 50)}" — ${agent.name} reported done but no real PR/commit exists. Likely didn't actually run.`, dedupeKey: `unverified:${run.id}` }).catch(() => {});
  }
  // Heads-up: this task ran in FRIDAY's own source folder — flag it so the feed, Obsidian log,
  // and SMS/voice notify-back all make clear the running OS itself was worked on.
  const selfSrc = !!project && isSelfSourceDir(project.workspaceDir) && ALL_CODING_ROLES.includes(agent.role);
  if (selfSrc) {
    summary = `Worked on FRIDAY's own source — ${summary}`;
    await logEvent("selfsource.edit", { agent: agent.id, task: task.title }, { level: "warn", runId: run.id, projectId: task.projectId });
  }
  // Every report is a Google Drive document (owner rule 2026-09-24): file the PDF / change summary /
  // CSV artifacts into the project's library and, when nothing carries the narrative, the run's own
  // result as a "Run report" Doc. Mutates `artifacts` (url + driveFileId). Best-effort.
  let filed: import("@/lib/friday/driveDeliverables").PublishResult = { links: [], filed: 0 };
  if (project && result.trim()) {
    try {
      const { publishRunToDrive } = await import("@/lib/friday/driveDeliverables");
      const client = await store.clients.get(project.clientId).catch(() => null);
      filed = await publishRunToDrive({ run, task, project, client, agent, artifacts, result });
    } catch (e) {
      await logEvent("drive.file.failed", { runId: run.id, error: String(e).slice(0, 200) }, { level: "warn", runId: run.id, projectId: task.projectId });
    }
  }
  await store.runs.update(run.id, { artifacts, summary, verificationFailed });

  // Institutional memory: remember this deliverable (summary + result), project-scoped, so future
  // planning/QA can recall what was built. Best-effort, non-blocking.
  if (result.trim().length > 20) {
    const { indexMemory, clientIdForProject } = await import("@/lib/friday/memory");
    const clientId = await clientIdForProject(task.projectId).catch(() => undefined);
    void indexMemory({ id: `run:${run.id}`, kind: "run", text: `${summary}\n${result}`.slice(0, 1900), projectId: task.projectId, clientId, ts: run.endedAt ?? new Date().toISOString() }).catch(() => {});
  }

  // Durable memory (vault memory contract v1): the full outcome goes into the task's thread file so
  // the next run on this work reads what was done and where it was left off. It also writes the
  // project memory, the client note and the daily project log.
  if (project) {
    const { recordOutcome } = await import("@/lib/friday/vaultMemory");
    const isPlan = agent.role === "pm" || agent.role === "architect";
    const isReport = ["qa", "review", "debug", "seo", "research-qa"].includes(agent.role);
    const prArt = artifacts.find((a) => a.kind === "pr");
    await recordOutcome({
      project, task, kind: isPlan ? "plan" : isReport ? agent.role : "build",
      title: task.title,
      outcome: verificationFailed ? "failed" : "done",
      summary: isPlan ? `${summary}\n\nPlan:\n${result.slice(0, 3000)}` : summary,
      findings: isReport ? result.slice(0, 2500) : undefined,
      leftOff: verificationFailed ? `${agent.name} reported done but no real PR or commit exists — the work was not actually done.` : undefined,
      next: prArt ? "QA, then the PR shepherd takes it through review and merge." : undefined,
      links: artifacts.filter((a) => a.url).map((a) => ({ label: a.label, url: a.url! })),
      prUrl: prArt?.url,
    }).catch(() => {});
  }

  // Activity feed — now carries the summary + artifact metadata (not just the event name).
  await logEvent("dispatch.done", {
    agent: agent.id, task: task.title, summary,
    artifacts: artifacts.map((a) => ({ kind: a.kind, label: a.label, url: a.url })),
  }, { runId: run.id, projectId: task.projectId });

  // Report-up: the run's outcome reaches the OS through agent_code_runs_report (codeRunsReport.ts,
  // hooked on the runs collection). The old POST to the CLARA app (127.0.0.1:3939/api/report) was
  // removed 2026-10-28 — that app is retired and every report went nowhere.

  // Notify-back: a task that came in over SMS/voice gets the result texted to its origin (or the
  // owner as a fallback). Web-dispatched runs stay in-app only. WHO is decided by
  // runEndNotifyTarget (notifyBack.ts): auto-QA/heal rounds are silent, and a client's coding task
  // is texted on QA pass (orchestrator), not here.
  // (The weekly lead-research → Google Sheet hook was removed 2026-10-28: lead-gen is cut, its
  // schedule is deleted, and the sheet's Google account is gone. leadPipeline.ts is deleted.)
  const leadNote = "";

  const pr = artifacts.find((a) => a.kind === "pr");
  // The owner's links: the PR, then every Drive-filed document (Report (Google Doc) first).
  const ownerLinks: Array<{ label: string; url: string }> = [
    ...(pr?.url ? [{ label: "Pull request", url: pr.url }] : []),
    ...filed.links,
  ];
  const plainSummary = summary.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").replace(/\s+/g, " ").trim().slice(0, 600);
  const tail = ownerLinks.map((l) => `\n${l.label}: ${l.url}`).join("") + leadNote;
  if ((run.channel === "sms" || run.channel === "voice") && twilioConfig()) {
    const target = runEndNotifyTarget({ title: task.title, role: agent.role, hasClientContact: !!task.originContact });
    if (target === "client" && task.originContact) {
      // (Proactive client text retired: FRIDAY has no text channel. Client-origin sms/voice runs can no longer
      // be created; anything that still reaches this branch is dropped rather than sent.)
    } else if (target === "owner") {
      // No client origin → the owner, but through the brief like every other run (owner rule
      // 2026-09-24: no texts). Same shape as the web case below.
      await notifyOwner({ kind: "run.done", priority: "normal", headline: `${task.title.slice(0, 80)} — done`, summary: plainSummary, links: ownerLinks, text: (`${task.title} — done. ${plainSummary}` + tail).slice(0, 900), dedupeKey: `rundone:${run.id}` }).catch(() => {});
    }
  } else if (run.channel === "web") {
    // Web-dispatched runs used to be silent — push the owner so you're informed from anywhere.
    await notifyOwner({ kind: "run.done", priority: "normal", headline: `${task.title.slice(0, 80)} — done`, summary: plainSummary, links: ownerLinks, text: (`${task.title} — ${plainSummary}` + tail).slice(0, 900), dedupeKey: `rundone:${run.id}` }).catch(() => {});
  }

  // A planning run on a client ticket that produced no PR hands off to a build task (osTickets).
  if (agent.role === "pm" && (task.details ?? "").includes("[os-ticket:")) {
    const { maybeDispatchBuildFollowUp } = await import("@/lib/friday/osTickets");
    await maybeDispatchBuildFollowUp(task, { result, artifacts }, agent.role);
  }

  return artifacts;
}
