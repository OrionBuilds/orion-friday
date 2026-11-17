import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_OPEN, assess, clipError, originOf, osRequestsMode, pollOsRequests, requestMessage, type Link, type PlanResult, type RequestDeps } from "./osRequests";
import type { AgentRun, Task } from "./types";

const task = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({ id, projectId: "p", title: `T-${id}`, status, assignee: "dev", risk: "low", order: 0, createdAt: "", updatedAt: "", ...extra });
const run = (id: string, status: AgentRun["status"], extra: Partial<AgentRun> = {}): AgentRun => ({ id, agentId: "a", taskId: "t", channel: "web", input: "", status, startedAt: "", ...extra });

// Every claimed request is owner-sourced unless a test says otherwise (requested_by is server-set; a
// missing value is refused — see the trust tests below).
const OWNER = { requested_by: "owner" };
function harness(claims: unknown[][], tasks: Record<string, Task>, runs: Record<string, AgentRun[]> = {}, plan: (m: string) => PlanResult = () => ({ reply: "ok", tasks: [{ id: "t1" }] })) {
  const links = new Map<string, Link>();
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const planned: string[] = [];
  const origins: string[] = [];
  const histories: unknown[] = [];
  let poll = 0;
  const d: RequestDeps = {
    call: async (tool, args) => { calls.push({ tool, args }); return tool === "agent_requests_poll" ? (claims[poll++] ?? []) : {}; },
    orchestrate: async (m, _origin, o) => { planned.push(m); origins.push(_origin); histories.push(o?.history); return plan(m); },
    links: {
      get: async (id) => links.get(id) ?? null,
      insert: async (l) => { links.set(l.id, l); },
      update: async (id, p) => { links.set(id, { ...links.get(id)!, ...p }); },
      all: async () => [...links.values()],
    },
    getTask: async (id) => tasks[id] ?? null,
    runsFor: async (id) => runs[id] ?? [],
    log: async () => {}, now: () => "2026-10-20T00:00:00Z",
  };
  return { d, links, calls, planned, origins, histories };
}

test("mode is off unless explicitly active", () => {
  assert.equal(osRequestsMode({}), "off");
  assert.equal(osRequestsMode({ FRIDAY_OS_REQUESTS: "ACTIVE" }), "active");
  assert.equal(osRequestsMode({ FRIDAY_OS_REQUESTS: "on" }), "off");
});

test("the planner is told it is the owner's ask relayed by Clara, with the request id", () => {
  const m = requestMessage({ id: "r1", title: "Fix login", body: "500 on empty body", kind: "bug", source: OWNER });
  assert.match(m, /Fix login/); assert.match(m, /Relayed by Clara for the owner/); assert.match(m, /r1/);
});

test("assess: done only when every task is done; failure only when nothing is still running", () => {
  const done = assess([task("a", "delivered", { prUrl: "https://github.com/o/r/pull/9" }), task("b", "completed")], { a: [run("r1", "done", { summary: "Fixed null check" })], b: [] });
  assert.equal(done.state, "completed");
  if (done.state === "completed") { assert.match(done.summary, /pull\/9/); assert.match(done.summary, /Fixed null check/); }
  assert.equal(assess([task("a", "completed"), task("b", "in_progress")], { b: [run("r2", "running")] }).state, "working");
  assert.equal(assess([task("a", "in_progress")], { a: [run("r3", "error", { error: "tests red" })] }).state, "failed");
  assert.equal(assess([task("a", "in_progress")], { a: [run("r3", "error"), run("r4", "running")] }).state, "working"); // a retry is running
  assert.equal(assess([task("a", "in_progress")], { a: [run("r3", "awaiting_approval")] }).state, "working"); // waiting on the owner
});

test("a new request is planned once; the same request re-claimed after a lease lapse is NOT planned again", async () => {
  const h = harness([[{ id: "r1", title: "Fix login", body: "x", kind: "bug", source: OWNER }], [{ id: "r1", title: "Fix login", body: "x", kind: "bug", source: OWNER }]], { t1: task("t1", "in_progress") }, { t1: [run("a", "running")] });
  const first = await pollOsRequests(h.d);
  assert.deepEqual([first.claimed, first.started], [1, 1]);
  await pollOsRequests(h.d);
  assert.equal(h.planned.length, 1);
  // Work still running: the lease is extended, nothing reported.
  assert.ok(h.calls.some((c) => c.tool === "agent_request_extend_lease"));
  assert.ok(!h.calls.some((c) => c.tool === "agent_request_report"));
});

test("finished work is reported completed exactly once, with the PR link", async () => {
  const h = harness([[{ id: "r1", title: "Fix login", body: "x", kind: "bug", source: OWNER }]], { t1: task("t1", "delivered", { prUrl: "https://github.com/o/r/pull/3" }) }, { t1: [run("a", "done", { summary: "Added guard" })] });
  const r = await pollOsRequests(h.d);
  assert.equal(r.reported, 1);
  const rep = h.calls.find((c) => c.tool === "agent_request_report")!;
  assert.equal(rep.args.status, "completed");
  assert.match(String(rep.args.summary), /pull\/3/);
  await pollOsRequests(h.d);
  assert.equal(h.calls.filter((c) => c.tool === "agent_request_report").length, 1);
});

test("a plain answer is reported COMPLETED; only a genuine question (collect_*) is needs_input; a planner crash is a failure", async () => {
  const a = harness([[{ id: "r0", title: "what projects are you connected to", body: "?", kind: "task", source: OWNER }]], {}, {}, () => ({ reply: "18 active projects: …", intent: "chat", tasks: [] }));
  await pollOsRequests(a.d);
  const ans = a.calls.find((c) => c.tool === "agent_request_report")!;
  assert.deepEqual([ans.args.status, ans.args.summary], ["completed", "18 active projects: …"]);
  const act = harness([[{ id: "r9", title: "status of globex", body: "?", kind: "task", source: OWNER }]], {}, {}, () => ({ reply: "Globex: 2 PRs open", intent: "status", tasks: [] }));
  await pollOsRequests(act.d);
  assert.equal(act.calls.find((c) => c.tool === "agent_request_report")!.args.status, "completed");
  const q = harness([[{ id: "r1", title: "Do the thing", body: "?", kind: "task", source: OWNER }]], {}, {}, () => ({ reply: "Which repo do you mean?", intent: "collect_project", tasks: [] }));
  await pollOsRequests(q.d);
  const rep = q.calls.find((c) => c.tool === "agent_request_report")!;
  assert.deepEqual([rep.args.status, rep.args.summary], ["needs_input", "Which repo do you mean?"]);
  assert.equal(q.links.get("r1")!.question, "Which repo do you mean?");
  const boom = harness([[{ id: "r2", title: "X", body: "y", kind: "code", source: OWNER }]], {}, {}, () => { throw new Error("planner down"); });
  await pollOsRequests(boom.d);
  assert.equal(boom.calls.find((c) => c.tool === "agent_request_report")!.args.status, "failed");
});

test("a report the OS refuses is retried, not forgotten", async () => {
  const h = harness([[{ id: "r1", title: "A", body: "b", kind: "task", source: OWNER }]], { t1: task("t1", "completed") });
  const orig = h.d.call;
  let fail = true;
  h.d.call = async (tool, args) => { if (tool === "agent_request_report" && fail) { fail = false; throw new Error("not claimed by this identity"); } return orig(tool, args); };
  assert.equal((await pollOsRequests(h.d)).reported, 0);
  assert.equal(h.links.get("r1")!.reported, undefined);
  assert.equal((await pollOsRequests(h.d)).reported, 1);
});

test("it stops claiming when MAX_OPEN requests are already in flight", async () => {
  const h = harness([[]], { t1: task("t1", "in_progress") }, { t1: [run("a", "running")] });
  for (let i = 0; i < MAX_OPEN; i++) await h.d.links.insert({ id: `l${i}`, title: "x", taskIds: ["t1"], createdAt: "" });
  await pollOsRequests(h.d);
  assert.ok(!h.calls.some((c) => c.tool === "agent_requests_poll"));
});

test("a client's email is planned as CLIENT-origin and says so; an owner relay stays owner-tier", async () => {
  const c = harness([[{ id: "r1", title: "Client Acme — fix checkout", body: "x", kind: "task", source: { requested_by: "client", client_name: "Acme" } }]], { t1: task("t1", "in_progress") }, { t1: [run("a", "running")] });
  await pollOsRequests(c.d);
  assert.deepEqual(c.origins, ["client"]);
  assert.match(c.planned[0], /CLIENT email from Acme/);
  assert.match(c.planned[0], /not the owner's/);
  const o = harness([[{ id: "r2", title: "Fix login", body: "x", kind: "bug", source: { channel: "sms", requested_by: "owner" } }]], { t1: task("t1", "in_progress") }, { t1: [run("a", "running")] });
  await pollOsRequests(o.d);
  assert.deepEqual(o.origins, ["clara"]);
});

test("requested_by is trusted from the server and anything not owner/client is refused, never treated as owner", async () => {
  assert.equal(originOf({ source: { requested_by: "owner" } }), "clara");
  assert.equal(originOf({ source: { requested_by: "client" } }), "client");
  for (const by of ["team", "", "OWNER ", "friday", undefined]) {
    if (by === "OWNER ") { assert.equal(originOf({ source: { requested_by: by } }), "clara", "case/space-insensitive owner"); continue; }
    assert.equal(originOf({ source: by === undefined ? {} : { requested_by: by } }), null, `requested_by=${by}`);
  }
  const t = harness([[{ id: "r3", title: "Deploy prod", body: "x", kind: "task", source: { requested_by: "team" } }], [{ id: "r4", title: "Do it", body: "x", kind: "task" }]], {});
  await pollOsRequests(t.d);
  await pollOsRequests(t.d);
  assert.equal(t.planned.length, 0, "never planned");
  const reps = t.calls.filter((c) => c.tool === "agent_request_report");
  assert.deepEqual(reps.map((c) => c.args.status), ["failed", "failed"]);
  assert.match(String(reps[0].args.summary), /only takes work from the owner/);
});

test("payload.history reaches the planner as conversation context (last 10, roles mapped)", async () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "owner", text: `turn ${i}`, at: "2026-10-28T00:00:00Z" }));
  const h = harness([[{ id: "r1", title: "and the other one?", body: "and the other one?", kind: "task", source: OWNER, payload: { history } }]], {}, {}, () => ({ reply: "ok", intent: "chat", tasks: [] }));
  await pollOsRequests(h.d);
  const got = h.histories[0] as { role: string; text: string }[];
  assert.equal(got.length, 10);
  assert.deepEqual(got[0], { role: "user", text: "turn 2" });
  assert.deepEqual(got[1], { role: "friday", text: "turn 3" });
});

test("a needs_input answer arriving as a NEW request (payload.in_reply_to) resumes the original plan", async () => {
  const h = harness(
    [
      [{ id: "r1", title: "Fix the site", body: "it's broken", kind: "task", source: OWNER }],
      [{ id: "r2", title: "Re: Fix the site", body: "the Globex one", kind: "task", source: OWNER, payload: { in_reply_to: "r1" } }],
    ],
    { t1: task("t1", "in_progress") }, { t1: [run("a", "running")] },
    (m) => (/Globex/.test(m) ? { reply: "On it", intent: "add_tasks", tasks: [{ id: "t1" }] } : { reply: "Which site?", intent: "collect_project", tasks: [] }),
  );
  await pollOsRequests(h.d);
  await pollOsRequests(h.d);
  assert.equal(h.planned.length, 2);
  assert.match(h.planned[1], /Original ask:[\s\S]*Fix the site/);
  assert.match(h.planned[1], /You asked: Which site\?/);
  assert.match(h.planned[1], /the Globex one/);
  assert.equal(h.links.get("r1")!.resumedBy, "r2");
  assert.deepEqual(h.links.get("r2")!.taskIds, ["t1"]);
});

test("the SAME row re-queued after FRIDAY reported needs_input is re-planned, not skipped", async () => {
  const req = { id: "r1", title: "Fix the site", body: "it's broken", kind: "task", source: OWNER };
  let n = 0;
  const h = harness([[req], [{ ...req, body: "it's broken\n\nAnswer: the Globex one" }]], { t1: task("t1", "in_progress") }, { t1: [run("a", "running")] },
    () => (n++ === 0 ? { reply: "Which site?", intent: "collect_project", tasks: [] } : { reply: "On it", intent: "add_tasks", tasks: [{ id: "t1" }] }));
  await pollOsRequests(h.d);
  assert.equal(h.links.get("r1")!.reported, "needs_input");
  const second = await pollOsRequests(h.d);
  assert.equal(h.planned.length, 2);
  assert.equal(second.started, 1);
  assert.equal(h.links.get("r1")!.reported, undefined);
});

test("a Knowledge-tab refresh request is handled directly (never planned), reported with its counts, owner-only", async () => {
  const req = { id: "k1", title: "Refresh project knowledge: Acme", body: "b", kind: "task", source: OWNER, payload: { type: "project_knowledge_refresh", project_id: "osp1", slugs: ["billing"] } };
  const h = harness([[req]], {});
  const seen: unknown[] = [];
  h.d.knowledgeRefresh = async (p) => { seen.push(p); return { ok: true, message: "2 note(s) rewritten", refreshed: 2, stale: 1, skipped: 0 }; };
  const r = await pollOsRequests(h.d);
  assert.equal(r.reported, 1);
  assert.deepEqual(h.planned, []);
  assert.deepEqual(seen, [{ projectId: "osp1", repoUrl: undefined, slugs: ["billing"] }]);
  const rep = h.calls.find((c) => c.tool === "agent_request_report")!;
  assert.equal(rep.args.status, "completed");
  assert.deepEqual(rep.args.result, { refreshed: 2, stale: 1, skipped: 0 });

  // Not the owner → refused before anything runs.
  const bad = harness([[{ ...req, id: "k2", source: { requested_by: "team" } }]], {});
  let ran = false;
  bad.d.knowledgeRefresh = async () => { ran = true; return { ok: true, message: "", refreshed: 0, stale: 0, skipped: 0 }; };
  await pollOsRequests(bad.d);
  assert.equal(ran, false);
  assert.equal(bad.calls.find((c) => c.tool === "agent_request_report")!.args.status, "failed");

  // A throw is reported as failed, not left to expire.
  const boom = harness([[{ ...req, id: "k3" }]], {});
  boom.d.knowledgeRefresh = async () => { throw new Error("x"); };
  await pollOsRequests(boom.d);
  assert.equal(boom.calls.find((c) => c.tool === "agent_request_report")!.args.status, "failed");
});

// ── OS factory steps (channel 'factory') ───────────────────────────────────────────────────
const FACTORY = { requested_by: "owner", channel: "factory", factory_step_run_id: "sr1", deliverable: "doc", role: "sales-engineer" };

test("a factory document step is written (never planned) and reported with output, evidence and gate", async () => {
  const h = harness([[{ id: "r1", title: "Technical scope", body: "handoff", kind: "task", source: FACTORY }]], {});
  h.d.writeFactoryDeliverable = async () => ({ ok: true, output: "## Scope\n3 phases", evidence: [{ source: "Discovery recap" }], gate: { passed: true, checks: [{ criterion: "Phases", met: true }] } });
  const r = await pollOsRequests(h.d);
  assert.equal(h.planned.length, 0);
  assert.equal(r.reported, 1);
  const rep = h.calls.find((c) => c.tool === "agent_request_report")!;
  assert.equal(rep.args.status, "completed");
  assert.equal((rep.args.result as { output: string }).output, "## Scope\n3 phases");
  assert.equal((rep.args.result as { gate: { passed: boolean } }).gate.passed, true);
});

test("a factory CODE step still goes to the planner", async () => {
  const h = harness([[{ id: "r1", title: "Build it", body: "x", kind: "code", source: { ...FACTORY, deliverable: "code" } }]], { t1: task("t1", "in_progress") }, { t1: [run("a", "running")] });
  h.d.writeFactoryDeliverable = async () => { throw new Error("must not be called"); };
  await pollOsRequests(h.d);
  assert.equal(h.planned.length, 1);
});

test("a factory step from a non-owner is still refused before anything is written", async () => {
  const h = harness([[{ id: "r1", title: "Scope", body: "x", kind: "task", source: { ...FACTORY, requested_by: "team" } }]], {});
  let wrote = false;
  h.d.writeFactoryDeliverable = async () => { wrote = true; return { ok: false, error: "x" }; };
  await pollOsRequests(h.d);
  assert.equal(wrote, false);
  assert.equal(h.calls.find((c) => c.tool === "agent_request_report")!.args.status, "failed");
});

test("clipError keeps the end of an engine error, where the real reason is", () => {
  const raw = `Error: codex CLI failed (code 1): ${"\"risk_level\": \"low\", ".repeat(40)}\nERROR: Your workspace is out of credits. Add credits to continue.`;
  const out = clipError(raw, 300);
  assert.ok(out.length <= 300);
  assert.ok(out.startsWith("Error: codex CLI failed (code 1)"));
  assert.ok(out.endsWith("Your workspace is out of credits. Add credits to continue."));
  assert.equal(clipError("short error", 300), "short error");
});
