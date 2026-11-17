// clientReview — the portal review loop (contract §2 + contract-changes §F). Everything runs against
// injected fakes (ReviewDeps): an in-memory OS for client_reviews_*, an in-memory request/task store,
// and recorders for dispatch / escalation / owner notices. No store, no engines, no network.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Task, Client, Project } from "./types";

// callOsTool logs misses through the store — keep that out of the live data dir.
process.env.AGENTIC_OS_FRIDAY_DATA = mkdtempSync(path.join(os.tmpdir(), "friday-clientreview-test-"));

type CR = typeof import("./clientReview");
let CR: CR;
before(async () => { CR = await import("./clientReview"); });

const DAY = 24 * 60 * 60_000;
const T0 = Date.parse("2026-10-28T12:00:00Z");

interface World {
  now: number;
  comms: boolean;
  missing: Set<string>;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  reviews: Map<string, Record<string, unknown>>;
  requests: Map<string, Request>;
  tasks: Map<string, Task>;
  dispatched: string[];
  escalated: string[];
  escalateThrows: boolean;
  notices: Array<{ kind: string; text: string; dedupeKey: string }>;
  cursor: string | null;
  osProject: string | undefined;
}

let w: World;
let seq = 0;

function mcp(v: unknown) { return [{ type: "text", text: JSON.stringify(v) }]; }

function makeDeps(): import("./clientReview").ReviewDeps {
  return {
    callTool: async (name, args) => {
      w.calls.push({ name, args });
      if (w.missing.has(name)) throw new Error(`osmcp: tool "${name}" failed: Tool ${name} not found`);
      if (name === "client_reviews_create") {
        const key = `${args.project_id}|${args.request_ref}|${args.round}`;
        const hit = [...w.reviews.values()].find((r) => r.key === key);
        if (hit) return mcp({ id: hit.id, portal_url: hit.portal_url, notified: false });
        const id = `rev-${++seq}`;
        w.reviews.set(id, { id, key, status: "pending", comments: [], portal_url: `https://portal/r/${id}`, ...args });
        return mcp({ id, portal_url: `https://portal/r/${id}`, notified: Boolean(args.notify), ...(args.notify ? {} : { notify_reason: "client_comms_off" }) });
      }
      if (name === "client_reviews_list") return mcp([...w.reviews.values()]);
      if (name === "client_reviews_update") {
        const r = w.reviews.get(String(args.id));
        if (!r) throw new Error("not found");
        if (args.status) r.status = args.status;
        if (args.client_message) (r.comments as unknown[]).push({ author: "FRIDAY", author_type: "agent", body: args.client_message, created_at: new Date(w.now).toISOString() });
        return mcp(r);
      }
      throw new Error(`unexpected tool ${name}`);
    },
    getRequest: async (id) => w.requests.get(id) ?? null,
    updateRequest: async (id, patch) => { const r = w.requests.get(id); if (r) Object.assign(r, patch); return r; },
    transition: async (id, state, patch = {}) => { const r = w.requests.get(id); if (r) Object.assign(r, patch, { state }); },
    linkTask: async (id, taskId) => { const r = w.requests.get(id); if (r && !r.taskIds.includes(taskId)) r.taskIds.push(taskId); },
    findRequests: async (pred) => [...w.requests.values()].filter(pred),
    readyForReview: async () => true,
    getClient: async () => ({ id: "c1", name: "Pat Client", email: "pat@example.com" } as Client),
    getProject: async () => ({ id: "p1", name: "Acme Site", stagingUrl: "https://staging.acme.test" } as Project),
    getTask: async (id) => w.tasks.get(id) ?? null,
    updateTask: async (id, patch) => { const t = w.tasks.get(id); if (t) Object.assign(t, patch); return t; },
    createTask: async (input) => {
      const t = { id: `task-${++seq}`, status: "planning", createdAt: new Date(w.now).toISOString(), ...input } as unknown as Task;
      w.tasks.set(t.id, t);
      return t;
    },
    osProjectId: async () => w.osProject,
    dispatch: async (taskId) => { w.dispatched.push(taskId); },
    escalate: async (taskId) => { if (w.escalateThrows) throw new Error("queue down"); w.escalated.push(taskId); },
    notifyOwner: async (o) => { w.notices.push(o); },
    commsEnabled: async () => w.comms,
    compose: async () => null, // deterministic fallback copy
    cursor: { get: async () => w.cursor, set: async (iso) => { w.cursor = iso; } },
    log: async () => {},
    now: () => w.now,
  };
}

function seedRequest(over: Partial<Request> = {}): Request {
  const task: Task = { id: "t1", title: "Add a pricing page", status: "completed", projectId: "p1", createdAt: "2026-10-27T00:00:00Z" } as Task;
  w.tasks.set(task.id, task);
  const req = {
    id: "req1", projectId: "p1", clientId: "c1", title: "Add a pricing page", state: "in_progress",
    scope: "in_scope", revisionRound: 0, taskIds: ["t1"], createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z",
    ...over,
  } as Request;
  w.requests.set(req.id, req);
  return req;
}

beforeEach(async () => {
  w = {
    now: T0, comms: false, missing: new Set(), calls: [], reviews: new Map(), requests: new Map(), tasks: new Map(),
    dispatched: [], escalated: [], escalateThrows: false, notices: [], cursor: null, osProject: "os-proj-1",
  };
  CR._setReviewDeps(makeDeps());
  const { _resetOsToolState } = await import("./osTool");
  _resetOsToolState();
});

const names = () => w.calls.map((c) => c.name);

test("enterClientReview files ONE portal review (request_ref = request id, round 1) and notify follows the comms switch", async () => {
  seedRequest();
  await CR.enterClientReview("req1");
  const create = w.calls.find((c) => c.name === "client_reviews_create")!;
  assert.ok(create, "client_reviews_create called");
  assert.equal(create.args.project_id, "os-proj-1");
  assert.equal(create.args.request_ref, "req1");
  assert.equal(create.args.round, 1);
  assert.equal(create.args.notify, false, "comms off ⇒ notify false");
  assert.equal(create.args.preview_url, "https://staging.acme.test");
  assert.match(String(create.args.summary), /Add a pricing page/);
  const req = w.requests.get("req1")!;
  assert.equal(req.state, "client_review");
  assert.ok(req.reviewOsId);

  // Re-entering (already in review) does nothing.
  await CR.enterClientReview("req1");
  assert.equal(names().filter((n) => n === "client_reviews_create").length, 1);

  w.comms = true;
  seedRequest({ id: "req2" });
  await CR.enterClientReview("req2");
  assert.equal(w.calls.filter((c) => c.name === "client_reviews_create").at(-1)!.args.notify, true);
});

test("a missing client_reviews_create tool: request waits in qa_passed, no attempt burned, no other channel tried", async () => {
  seedRequest();
  w.missing.add("client_reviews_create");
  await CR.enterClientReview("req1");
  const req = w.requests.get("req1")!;
  assert.equal(req.state, "qa_passed");
  assert.equal(req.reviewAttempts ?? 0, 0);
  assert.deepEqual([...new Set(names())], ["client_reviews_create"], "only the portal tool is ever tried");
  // Once the tool exists, crash recovery files it.
  w.missing.clear();
  assert.equal(await CR.resendPendingReviews(), 1);
  assert.equal(w.requests.get("req1")!.state, "client_review");
});

test("an unmapped project never files a review and counts the attempt", async () => {
  seedRequest();
  w.osProject = undefined;
  await CR.enterClientReview("req1");
  assert.ok(!names().includes("client_reviews_create"));
  assert.equal(w.requests.get("req1")!.reviewAttempts, 1);
});

test("accepted in the portal → tasks delivered, request closed, OS row closed, owner told once; no client message with comms off", async () => {
  seedRequest();
  await CR.enterClientReview("req1");
  const id = w.requests.get("req1")!.reviewOsId!;
  w.reviews.get(id)!.status = "accepted";
  const out = await CR.pollClientReviewReplies();
  assert.match(out, /1 accepted/);
  const req = w.requests.get("req1")!;
  assert.equal(req.state, "closed");
  assert.equal(req.closedReason, "accepted");
  assert.equal(w.tasks.get("t1")!.status, "delivered");
  const upd = w.calls.filter((c) => c.name === "client_reviews_update");
  assert.equal(upd.length, 1);
  assert.equal(upd[0].args.status, "closed");
  assert.equal("client_message" in upd[0].args, false, "comms off ⇒ nothing client-visible");
  assert.equal(w.notices.filter((n) => n.dedupeKey === "reviewaccept:req1").length, 1);
  // A second poll does not re-process the settled request.
  await CR.pollClientReviewReplies();
  assert.equal(w.calls.filter((c) => c.name === "client_reviews_update").length, 1);
});

test("changes_requested → a revision task is dispatched; round 3 escalates and is NOT dispatched", async () => {
  w.comms = true;
  seedRequest();
  await CR.enterClientReview("req1");
  let id = w.requests.get("req1")!.reviewOsId!;
  Object.assign(w.reviews.get(id)!, { status: "changes_requested", client_comment: "Make the header bigger" });
  await CR.pollClientReviewReplies();
  let req = w.requests.get("req1")!;
  assert.equal(req.state, "in_progress");
  assert.equal(req.revisionRound, 1);
  assert.equal(w.dispatched.length, 1);
  const rev = w.tasks.get(w.dispatched[0])!;
  assert.match(rev.title, /^\[Revision 1\]/);
  assert.match(String(rev.details), /header bigger/);
  const msg = w.calls.filter((c) => c.name === "client_reviews_update").at(-1)!;
  assert.match(String(msg.args.client_message), /On it/);

  // Round 2 → resubmitted as round 2, then changes again → dispatched (2 rounds auto-loop).
  w.tasks.get(w.dispatched[0])!.status = "completed";
  await CR.enterClientReview("req1");
  assert.equal(w.calls.filter((c) => c.name === "client_reviews_create").at(-1)!.args.round, 2);
  id = w.requests.get("req1")!.reviewOsId!;
  Object.assign(w.reviews.get(id)!, { status: "changes_requested", client_comment: "Make it blue" });
  await CR.pollClientReviewReplies();
  assert.equal(w.dispatched.length, 2);

  // Round 3 → over the cap: escalated (parked for the owner), never dispatched.
  w.tasks.get(w.dispatched[1])!.status = "completed";
  await CR.enterClientReview("req1");
  id = w.requests.get("req1")!.reviewOsId!;
  Object.assign(w.reviews.get(id)!, { status: "changes_requested", client_comment: "Make it green" });
  await CR.pollClientReviewReplies();
  req = w.requests.get("req1")!;
  assert.equal(req.state, "changes_requested");
  assert.equal(req.revisionRound, 3);
  assert.equal(w.dispatched.length, 2, "round 3 is not dispatched");
  assert.equal(w.escalated.length, 1);
  assert.equal(w.notices.filter((n) => n.dedupeKey.startsWith("reviewescalate:")).length, 0, "the approval queue notifies — no second page");
});

test("escalation falls back to a direct owner notice only when parking the approval fails", async () => {
  seedRequest({ revisionRound: 2, state: "client_review", reviewOsId: "rev-x", reviewSentAt: new Date(T0).toISOString() });
  w.reviews.set("rev-x", { id: "rev-x", status: "changes_requested", client_comment: "again", comments: [] });
  w.escalateThrows = true;
  await CR.pollClientReviewReplies();
  assert.equal(w.dispatched.length, 0);
  assert.equal(w.notices.filter((n) => n.dedupeKey === "reviewescalate:req1:3").length, 1);
});

test("client comments: answered once in the portal with comms on; own agent/staff comments never answered; comms off ⇒ owner told, nothing posted", async () => {
  w.comms = true;
  seedRequest();
  await CR.enterClientReview("req1");
  const id = w.requests.get("req1")!.reviewOsId!;
  const r = w.reviews.get(id)!;
  w.now = T0 + 60_000;
  (r.comments as unknown[]).push(
    { author: "Pat", author_type: "client", body: "Where is the FAQ?", created_at: new Date(T0 + 30_000).toISOString() },
    { author: "Staffer", author_type: "staff", body: "internal note", created_at: new Date(T0 + 31_000).toISOString() },
    { author: "FRIDAY", author_type: "agent", body: "earlier agent reply", created_at: new Date(T0 + 32_000).toISOString() },
  );
  await CR.pollClientReviewReplies();
  const replies = w.calls.filter((c) => c.name === "client_reviews_update" && c.args.client_message);
  assert.equal(replies.length, 1, "one client comment ⇒ one portal reply; staff/agent comments get none");
  const answers = replies.filter((c) => /Good question/.test(String(c.args.client_message)));
  assert.equal(answers.length, 1, "exactly one answer to the one client comment");
  // Second poll: the floor stops a re-answer.
  await CR.pollClientReviewReplies();
  assert.equal(w.calls.filter((c) => c.name === "client_reviews_update" && /Good question/.test(String(c.args.client_message))).length, 1);

  // Comms off: a new comment goes to the owner, nothing posted.
  w.comms = false;
  (r.comments as unknown[]).push({ author: "Pat", author_type: "client", body: "Hello?", created_at: new Date(T0 + 50_000).toISOString() });
  const before = w.calls.filter((c) => c.name === "client_reviews_update").length;
  await CR.pollClientReviewReplies();
  assert.equal(w.calls.filter((c) => c.name === "client_reviews_update").length, before);
  assert.ok(w.notices.some((n) => n.dedupeKey.startsWith(`reviewcomment:${id}:`)));
});

test("silence: day-3 nudge once (comms on), day-7 closes the OS row then the request; comms off closes silently", async () => {
  w.comms = true;
  seedRequest();
  await CR.enterClientReview("req1");
  const id = w.requests.get("req1")!.reviewOsId!;
  w.now = T0 + 3 * DAY + 1000;
  assert.match(await CR.reviewSilenceSweep(), /1 nudged/);
  assert.match(await CR.reviewSilenceSweep(), /0 nudged/, "the nudge is once");
  w.comms = false;
  w.now = T0 + 7 * DAY + 1000;
  assert.match(await CR.reviewSilenceSweep(), /1 auto-closed/);
  const close = w.calls.filter((c) => c.name === "client_reviews_update").at(-1)!;
  assert.equal(close.args.id, id);
  assert.equal(close.args.status, "closed");
  assert.equal("client_message" in close.args, false, "comms off ⇒ silent close");
  assert.equal(w.requests.get("req1")!.state, "closed");
  assert.equal(w.requests.get("req1")!.closedReason, "silence");
  assert.equal(w.tasks.get("t1")!.status, "delivered");
});

test("day-7 close: a failed OS close leaves the request open for the next sweep", async () => {
  seedRequest({ state: "client_review", reviewOsId: "rev-gone", reviewSentAt: new Date(T0).toISOString() });
  w.now = T0 + 8 * DAY;
  await CR.reviewSilenceSweep();
  assert.equal(w.requests.get("req1")!.state, "client_review");
});

test("a legacy Gmail-era review (no portal row) is closed locally at day 7 with no OS call", async () => {
  seedRequest({ state: "client_review", reviewThreadId: "gmail-thread", reviewSentAt: new Date(T0).toISOString() });
  w.now = T0 + 8 * DAY;
  await CR.reviewSilenceSweep();
  assert.equal(w.requests.get("req1")!.state, "closed");
  assert.deepEqual(names(), []);
});

test("a missing client_reviews_list degrades to a status string, never throws", async () => {
  w.missing.add("client_reviews_list");
  assert.match(await CR.pollClientReviewReplies(), /unavailable/);
});

test("classifyClientReview keeps its conservative bias (eval harness)", () => {
  assert.equal(CR.classifyClientReview("looks good!"), "accept");
  assert.equal(CR.classifyClientReview("great, but move the header"), "changes");
  assert.equal(CR.classifyClientReview("why is the footer different?"), "question");
  assert.equal(CR.isClientComment({ author_type: "agent", author: "Pat" }), false);
  assert.equal(CR.isClientComment({ author: "Pat" }), false, "no author_type ⇒ not answered");
});
