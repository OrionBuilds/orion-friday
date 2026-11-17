// Tests for the pure half of project status: subject resolution precedence, health derivation,
// assembly from gathered inputs, portfolio roll-up, and the prose renderer's channel caps and hygiene.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSubjectFrom, deriveHealth, assembleProjectStatus, assemblePortfolio, renderStatusProse, ago,
  type StatusInputs,
} from "./statusReport";
import type { Project, Task, AgentRun, Approval, Client } from "./types";

const NOW = new Date("2026-09-24T14:05:00Z");
const iso = (minsAgo: number) => new Date(NOW.getTime() - minsAgo * 60_000).toISOString();

const clients: Client[] = [
  { id: "c1", name: "Dana Roof", company: "Globex Inc", createdAt: iso(9000), updatedAt: iso(9000) } as Client,
  { id: "c2", name: "Eli M", company: "Acme Capital", createdAt: iso(9000), updatedAt: iso(9000) } as Client,
];
const projects: Project[] = [
  { id: "p-globex", clientId: "c1", name: "Globex Website", status: "active", createdAt: iso(9000), updatedAt: iso(9000) } as Project,
  { id: "p-roofapp", clientId: "c1", name: "Globex Estimator App", status: "paused", createdAt: iso(9000), updatedAt: iso(9000) } as Project,
  { id: "p-coach", clientId: "c2", name: "AI Coach Tool", status: "active", createdAt: iso(9000), updatedAt: iso(9000) } as Project,
];

const task = (over: Partial<Task>): Task => ({
  id: "t", projectId: "p-globex", title: "Add the lead form", status: "in_progress", assignee: "friday", risk: "low", order: 1,
  createdAt: iso(600), updatedAt: iso(60), ...over,
} as Task);
const run = (over: Partial<AgentRun> & { updatedAt?: string }): AgentRun => ({
  id: "r", agentId: "friday", projectId: "p-globex", channel: "web", input: "Build the pricing page", status: "done",
  summary: "Pricing page built and live", artifacts: [{ id: "a", kind: "pdf", label: "Report", url: "https://docs.google.com/x", createdAt: iso(30) }],
  createdAt: iso(120), updatedAt: iso(30), ...over,
} as unknown as AgentRun);

function inputs(over: Partial<StatusInputs> = {}): StatusInputs {
  return {
    now: NOW, since: iso(7 * 24 * 60), project: projects[0], client: clients[0],
    tasks: [task({})], runs: [run({})], approvals: [],
    commits: [{ date: iso(90), message: "feat(landers): video hero" }],
    deploys: [{ id: "d1", state: "ready", branch: "main", createdAt: iso(45), deployUrl: "https://globex.example" }],
    portal: [{ at: iso(20), title: "Pages tailored to your Google Ads", detail: "Visitors see matching pages. Live now.", live: true }],
    log: [{ at: "2026-09-24T09:12", text: "run: QA passed" }],
    sources: [
      { name: "tasks", fetchedAt: iso(0), ok: true }, { name: "portal", fetchedAt: iso(0), ok: true },
      { name: "github", fetchedAt: iso(0), ok: false, note: "timeout" },
    ],
    ...over,
  };
}

// ── resolution ──────────────────────────────────────────────────────────────

test("resolves by id, exact name, and fuzzy tokens; prefers the active project on a partial match", () => {
  const byId = resolveSubjectFrom({ type: "project", id: "p-coach" }, projects, clients);
  assert.ok(byId && "project" in byId && byId.project.id === "p-coach");
  const exact = resolveSubjectFrom({ type: "project", name: "globex website" }, projects, clients);
  assert.ok(exact && "project" in exact && exact.project.id === "p-globex");
  const partial = resolveSubjectFrom({ type: "project", name: "globex" }, projects, clients);
  assert.ok(partial && "project" in partial && partial.project.id === "p-globex", "active project wins a partial match");
  const fuzzy = resolveSubjectFrom({ type: "project", name: "coach tool status" }, projects, clients);
  assert.ok(fuzzy && "project" in fuzzy && fuzzy.project.id === "p-coach");
});

test("ambiguous matches return candidates; client names resolve to their projects", () => {
  const both: Project[] = [...projects, { ...projects[1], id: "p-roof2", status: "active" } as Project];
  const amb = resolveSubjectFrom({ type: "project", name: "globex" }, both, clients);
  assert.ok(amb && "candidates" in amb && amb.candidates.length === 2);
  assert.ok(amb.candidates.every((c) => c.client === "Globex Inc"));
  const client = resolveSubjectFrom({ type: "client", name: "ACME" }, projects, clients);
  assert.ok(client && "project" in client && client.project.id === "p-coach");
  assert.equal(resolveSubjectFrom({ type: "project", name: "zzz" }, projects, clients), null);
});

// ── health ──────────────────────────────────────────────────────────────────

test("health: red on a failed run in 24h, failed deploy or blocked task; amber on approvals/waiting/stale; else green", () => {
  assert.equal(deriveHealth(inputs()), "green");
  assert.equal(deriveHealth(inputs({ runs: [run({ status: "error", updatedAt: iso(30) })] })), "red");
  assert.equal(deriveHealth(inputs({ deploys: [{ id: "d", state: "error" }] })), "red");
  assert.equal(deriveHealth(inputs({ tasks: [task({ status: "blocked" })] })), "red");
  assert.equal(deriveHealth(inputs({ approvals: [{ id: "a", action: "Send the report", status: "pending", risk: "low", requestedAt: iso(200) } as unknown as Approval] })), "amber");
  assert.equal(deriveHealth(inputs({ tasks: [task({ status: "waiting_on_client" })] })), "amber");
  assert.equal(deriveHealth(inputs({ tasks: [task({ updatedAt: iso(10 * 24 * 60) })] })), "amber");
  assert.equal(deriveHealth(inputs({ runs: [run({ status: "error", updatedAt: iso(3 * 24 * 60) })] })), "green", "an old failure does not stay red");
});

// ── assembly ────────────────────────────────────────────────────────────────

test("assembles recent items newest-first across sources with provenance, and a one-sentence headline", () => {
  const sr = assembleProjectStatus(inputs());
  assert.equal(sr.ok, true);
  assert.equal(sr.subject.name, "Globex Website");
  assert.equal(sr.subject.client, "Globex Inc");
  assert.equal(sr.summary.health, "green");
  assert.match(sr.summary.headline, /^Globex Website is in .+ and on track\. Latest: Pages tailored to your Google Ads \(20 min ago\)\.$/);
  assert.deepEqual(sr.recent.map((r) => r.source).slice(0, 4), ["portal", "run", "deploy", "git"]);
  assert.equal(sr.recent.find((r) => r.source === "run")?.link, "https://docs.google.com/x");
  assert.equal(sr.sources.length, 3);
});

test("blocked, next up and approvals are surfaced in plain words", () => {
  const sr = assembleProjectStatus(inputs({
    tasks: [task({ id: "t1", status: "blocked", title: "Connect the CRM" }), task({ id: "t2", status: "planning", title: "Spanish version", order: 3 }), task({ id: "t3", status: "planning", title: "Reviews widget", order: 1 })],
    approvals: [{ id: "a1", action: "Send Dana the Globex report", status: "pending", risk: "low", requestedAt: iso(200) } as unknown as Approval],
  }));
  assert.equal(sr.summary.health, "red");
  assert.deepEqual(sr.blocked.map((b) => b.headline), ["Connect the CRM — blocked"]);
  assert.deepEqual(sr.nextUp.map((n) => n.headline), ["Reviews widget", "Spanish version"]);
  assert.deepEqual(sr.approvalsPending.map((a) => a.headline), ["Needs your OK: Send Dana the Globex report"]);
});

test("portfolio roll-up orders worst health first and prefixes items with the project name", () => {
  const a = assembleProjectStatus(inputs());
  const b = assembleProjectStatus(inputs({ project: projects[2], client: clients[1], tasks: [task({ projectId: "p-coach", status: "blocked", title: "Fix scoring" })] }));
  const pf = assemblePortfolio([a, b], NOW, iso(7 * 24 * 60));
  assert.equal(pf.subject.type, "portfolio");
  assert.equal(pf.summary.health, "red");
  assert.match(pf.summary.headline, /^2 active projects: AI Coach Tool needs attention now; the rest are on track\.$/);
  assert.ok(pf.recent.every((r) => /^(Globex Website|AI Coach Tool): /.test(r.headline)));
  assert.deepEqual(pf.blocked.map((x) => x.headline), ["AI Coach Tool: Fix scoring — blocked"]);
});

// ── prose ───────────────────────────────────────────────────────────────────

test("prose: answer first, provenance second; sms/voice capped at 6 lines and 600 chars; voice drops links", () => {
  const sr = assembleProjectStatus(inputs({
    approvals: [{ id: "a1", action: "Send Dana the Globex report #A1B2", status: "pending", risk: "low", requestedAt: iso(200) } as unknown as Approval],
  }));
  const chat = renderStatusProse(sr, { channel: "chat", now: NOW });
  const lines = chat.split("\n");
  assert.match(lines[0], /^Globex Website is in/);
  assert.match(lines[1], /^As of \d{1,2}:\d{2} (AM|PM) today: tasks just now, portal just now; github unreachable\.$/);
  assert.ok(chat.includes("https://docs.google.com/x"), "chat keeps links");
  assert.doesNotMatch(chat, /#A1B2/, "codes are stripped");
  assert.doesNotMatch(chat, /[\u{1F300}-\u{1FAFF}]/u);

  const sms = renderStatusProse(sr, { channel: "sms", now: NOW });
  assert.ok(sms.split("\n").length <= 6, sms);
  assert.ok(sms.length <= 600);
  const voice = renderStatusProse(sr, { channel: "voice", now: NOW });
  assert.doesNotMatch(voice, /https?:\/\//);
});

test("ago() reads naturally", () => {
  assert.equal(ago(iso(1), NOW), "just now");
  assert.equal(ago(iso(20), NOW), "20 min ago");
  assert.equal(ago(iso(120), NOW), "2 hours ago");
  assert.equal(ago(iso(3 * 24 * 60), NOW), "3 days ago");
});

test("health is unknown when a store read that feeds it failed, not green", () => {
  const failed = inputs({ sources: [{ name: "tasks", fetchedAt: NOW.toISOString(), ok: false, note: "timeout" }] });
  assert.equal(deriveHealth(failed), "unknown");
  const fine = inputs({ sources: [{ name: "netlify", fetchedAt: NOW.toISOString(), ok: false, note: "no site" }] });
  // Unreadable vault memory can hide blockers, so it also makes health unknown.
  assert.equal(deriveHealth(inputs({ sources: [{ name: "memory", fetchedAt: NOW.toISOString(), ok: false, note: "EACCES" }] })), "unknown");
  assert.equal(deriveHealth(fine), "green");
});

test("client ids resolve to that client's projects", () => {
  const r = resolveSubjectFrom({ type: "client", id: clients[0].id }, projects, clients);
  assert.ok(r && "project" in r && r.project.clientId === clients[0].id);
});

test("short prose keeps decisions and blockers ahead of recent activity", () => {
  const sr = assembleProjectStatus(inputs({
    tasks: [task({ status: "blocked", title: "Waiting on DNS from the client" })],
    approvals: [{ id: "a", action: "Send the report to Dana", status: "pending", risk: "low", requestedAt: iso(200) } as unknown as Approval],
    portal: [1, 2, 3, 4].map((i) => ({ at: iso(i * 60), title: `Portal update ${i}` })),
  }));
  const out = renderStatusProse(sr, { channel: "sms" });
  const lines = out.split("\n");
  assert.ok(lines.length <= 6, out);
  assert.ok(out.includes("Waiting on you:") && out.includes("Blocked:"), out);
  assert.ok(lines.indexOf("Waiting on you:") < (lines.indexOf("Recent:") === -1 ? 99 : lines.indexOf("Recent:")), out);
});

test("recent activity honours the requested window for portal, deploy and log entries", () => {
  const old = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
  const sr = assembleProjectStatus(inputs({
    portal: [{ at: old, title: "Ancient portal note" }],
    deploys: [{ id: "d", state: "ready", createdAt: old }],
    log: [{ at: old.slice(0, 16), text: "old log line" }],
  }));
  assert.equal(sr.recent.some((i) => /Ancient|old log|Deploy ready/.test(i.headline)), false, JSON.stringify(sr.recent));
});

test("vault memory threads that failed or got stuck show up as blockers; healthy ones do not", () => {
  const sr = assembleProjectStatus(inputs({
    memory: [
      { thread: "add-lead-markers", line: "failed — needs attention · qa-verdict: Markers overlap (2026-09-24 09:40)" },
      { thread: "blocked-task", line: "blocked · run: Waiting on worktree (2026-09-24 09:20)" },
      { thread: "stuck-task", line: "stuck — handed to the owner · gave-up: Owner follow-up needed (2026-09-24 09:10)" },
      { thread: "pricing-page", line: "live · deploy: Pricing page is live (2026-09-24 08:00)" },
    ],
  }));
  assert.deepEqual(sr.blocked.map((b) => b.headline).sort(), [
    "add lead markers — failed — needs attention · qa-verdict: Markers overlap",
    "blocked task — blocked · run: Waiting on worktree",
    "stuck task — stuck — handed to the owner · gave-up: Owner follow-up needed",
  ]);
  const when = Object.fromEntries(sr.blocked.map((b) => [b.headline.split(" — ")[0], b.when]));
  assert.deepEqual(when, { "add lead markers": "2026-09-24T09:40", "blocked task": "2026-09-24T09:20", "stuck task": "2026-09-24T09:10" });
});
