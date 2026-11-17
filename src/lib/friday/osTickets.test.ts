// osTickets.clarifyRoundOutcome / firstClarifyReply — pure decision helpers for the portal
// ticket/CR clarify-before-route feature (2026-09-18). Pure, so this suite never touches the
// network, an LLM, or the OS.
//
// Runs via `npm test`. The data dir is pointed at a temp dir before the (store-importing) module
// loads, so nothing here reads or writes the live FRIDAY data.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-ostickets-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;

type Mod = typeof import("./osTickets");
let T: Mod;
let C: typeof import("./clientComms");

before(async () => {
  T = await import("./osTickets");
  C = await import("./clientComms");
});
after(() => rmSync(TMP, { recursive: true, force: true }));

describe("clarifyRoundOutcome", () => {
  test("round 1, no longer ambiguous ⇒ resolved", () => {
    assert.equal(T.clarifyRoundOutcome(1, false), "resolved");
  });

  test("round 1, still ambiguous ⇒ ask again", () => {
    assert.equal(T.clarifyRoundOutcome(1, true), "ask_again");
  });

  test("round 2, no longer ambiguous ⇒ resolved", () => {
    assert.equal(T.clarifyRoundOutcome(2, false), "resolved");
  });

  test("round 2, still ambiguous ⇒ force resolve, never a third ask", () => {
    assert.equal(T.clarifyRoundOutcome(2, true), "force_resolve");
  });
});

describe("firstClarifyReply", () => {
  const portal = { channel: "portal" as const, text: "portal answer", atMs: 1000 };
  const email = { channel: "email" as const, text: "email answer", atMs: 2000 };

  test("only portal replied ⇒ portal", () => {
    assert.deepEqual(T.firstClarifyReply(portal, null), portal);
  });

  test("only email replied ⇒ email", () => {
    assert.deepEqual(T.firstClarifyReply(null, email), email);
  });

  test("neither replied ⇒ null", () => {
    assert.equal(T.firstClarifyReply(null, null), null);
  });

  test("both replied, email first ⇒ email wins", () => {
    const laterPortal = { ...portal, atMs: 3000 };
    assert.deepEqual(T.firstClarifyReply(laterPortal, email), email);
  });

  test("both replied, portal first ⇒ portal wins", () => {
    const laterEmail = { ...email, atMs: 3000 };
    assert.deepEqual(T.firstClarifyReply(portal, laterEmail), portal);
  });

  test("exact tie ⇒ portal wins (documented, deterministic)", () => {
    const tiedEmail = { ...email, atMs: portal.atMs };
    assert.deepEqual(T.firstClarifyReply(portal, tiedEmail), portal);
  });
});

// ---------------------------------------------------------------------------
// 2026-09-24 ticket-pipeline fixes (mAI Dashboard: blank titles, parked replies, stalled plans)
// ---------------------------------------------------------------------------

describe("ticketName", () => {
  test("uses the OS title when subject is blank (live row shape)", () => {
    assert.equal(T.ticketName({ title: "Move internal staff to settings", subject: "" }), "Move internal staff to settings");
  });
  test("falls back to subject, then a neutral phrase", () => {
    assert.equal(T.ticketName({ subject: "Old style" }), "Old style");
    assert.equal(T.ticketName({ title: "", subject: "" }), "your request");
    assert.equal(T.ticketName({ title: "   " }), "your request");
  });
});

describe("ticketKind", () => {
  test("normalises the live request_type values", () => {
    assert.equal(T.ticketKind("bug_report"), "bug");
    assert.equal(T.ticketKind("feature_request"), "feature");
    assert.equal(T.ticketKind("configuration_change"), "change");
  });
  test("keeps the older values", () => {
    assert.equal(T.ticketKind("bug_issue"), "bug");
    assert.equal(T.ticketKind("change_request"), "change");
    assert.equal(T.ticketKind("something_else"), "other");
    assert.equal(T.ticketKind(undefined), "other");
  });
});

describe("parkDecision (re-proposal cap)", () => {
  const H = 3600_000;
  const now = Date.parse("2026-09-24T12:00:00Z");
  const mark = (hoursAgo: number, extra = "") => ({ is_internal: true, author_name: "FRIDAY", body: `note ${T.ACK_PARKED} ${extra}`, created_at: new Date(now - hoursAgo * H).toISOString() });
  test("never parked ⇒ park", () => {
    assert.equal(T.parkDecision([], T.ACK_PARKED, now), "park");
  });
  test("fresh park ⇒ wait", () => {
    assert.equal(T.parkDecision([mark(2)], T.ACK_PARKED, now), "wait");
  });
  test("one stale park ⇒ re-propose once", () => {
    assert.equal(T.parkDecision([mark(30)], T.ACK_PARKED, now), "repropose");
  });
  test("stale after the retry ⇒ escalate to the owner, never a third park", () => {
    assert.equal(T.parkDecision([mark(60), mark(30)], T.ACK_PARKED, now), "escalate");
    assert.equal(T.parkDecision([mark(200), mark(170), mark(140), mark(110), mark(80), mark(50), mark(26)], T.ACK_PARKED, now), "escalate");
  });
  test("already escalated ⇒ wait (raised once, not every sweep)", () => {
    assert.equal(T.parkDecision([mark(60), mark(30), mark(29, T.REPLY_ESCALATED)], T.ACK_PARKED, now), "wait");
  });
  test("markers for a different reply don't count", () => {
    assert.equal(T.parkDecision([mark(60), mark(30)], T.RESOLUTION_PARKED, now), "park");
  });
});

describe("draftTicketResolution", () => {
  test("names the ticket, says live only when merged, no undefined", () => {
    const live = T.draftTicketResolution({ client_name: "Taylor Client", title: "Display data for leads", subject: "" }, true);
    assert.match(live, /^Hi Taylor,/);
    assert.match(live, /"Display data for leads", is finished and live/);
    assert.doesNotMatch(live, /undefined|""/);
    const notLive = T.draftTicketResolution({ client_name: "", title: "X report", subject: "" }, false);
    assert.doesNotMatch(notLive, /live/);
  });
});

describe("pickLinkedTask", () => {
  test("the newest task that isn't on hold speaks for the ticket", () => {
    const hits = [
      { id: "plan", status: "on_hold", createdAt: "2026-09-15T00:00:00Z" },
      { id: "build", status: "planning", createdAt: "2026-09-25T00:00:00Z" },
    ] as const;
    assert.equal(T.pickLinkedTask([...hits])?.id, "build");
  });
  test("falls back to on-hold tasks when nothing else exists", () => {
    assert.equal(T.pickLinkedTask([{ id: "a", status: "on_hold", createdAt: "x" }])?.id, "a");
    assert.equal(T.pickLinkedTask([]), null);
  });
});

describe("needsBuildFollowUp", () => {
  const base = { role: "pm", taskDetails: "Add timestamps [os-ticket:ba6c4156-755c-4912-b4e2-f1187e14b4e6]", runHasPr: false, projectHasRepo: true, existingFollowUp: false };
  test("a pm plan on a ticket with code to build ⇒ follow up", () => {
    assert.equal(T.needsBuildFollowUp(base), true);
  });
  test("only once, only pm, only without a PR, only with a repo, only for tickets", () => {
    assert.equal(T.needsBuildFollowUp({ ...base, existingFollowUp: true }), false);
    assert.equal(T.needsBuildFollowUp({ ...base, role: "dev" }), false);
    assert.equal(T.needsBuildFollowUp({ ...base, runHasPr: true }), false);
    assert.equal(T.needsBuildFollowUp({ ...base, projectHasRepo: false }), false);
    assert.equal(T.needsBuildFollowUp({ ...base, taskDetails: "no marker here" }), false);
  });
});

describe("direct posting for any in-scope ticket kind", () => {
  type Call = { name: string; args: Record<string, unknown> };
  const fakeClient = () => {
    const calls: Call[] = [];
    return {
      calls,
      client: { callTool: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return [{ type: "text", text: "[]" }]; } },
    };
  };
  const ticket = { id: "t1", org_id: "o", project_id: "p", title: "Move internal staff to settings", subject: "", description: "rename to My team", status: "in_review", request_type: "feature_request", client_name: "Taylor Client" };
  let saved: Record<string, string | undefined> = {};
  before(() => {
    saved = { c: process.env.FRIDAY_CLIENT_COMMS, a: process.env.FRIDAY_AUTHORITY };
    process.env.FRIDAY_CLIENT_COMMS = "on";
    process.env.FRIDAY_AUTHORITY = "active";
    C._setOsClientCommsSwitch(true); // contract §6: the OS org switch must also be on
  });
  after(() => {
    C._setOsClientCommsSwitch(null);
    if (saved.c === undefined) delete process.env.FRIDAY_CLIENT_COMMS; else process.env.FRIDAY_CLIENT_COMMS = saved.c;
    if (saved.a === undefined) delete process.env.FRIDAY_AUTHORITY; else process.env.FRIDAY_AUTHORITY = saved.a;
  });

  test("a feature ticket's ack posts directly when the gate passes", async () => {
    const f = fakeClient();
    const ok = await T.tryDirectTicketAck(f.client as never, true, ticket as never, { reply: "Hi Taylor", next_status: "in_progress" }, "Move internal staff to settings\nrename to My team");
    assert.equal(ok, true);
    assert.ok(f.calls.some((c) => c.name === "project_ticket_comment_create" && c.args.is_internal === false && c.args.body === "Hi Taylor"));
    assert.ok(f.calls.some((c) => c.name === "project_support_tickets_update" && c.args.status === "in_progress"));
  });

  test("the gate refusing (run not active) posts nothing, so the caller parks", async () => {
    const f = fakeClient();
    assert.equal(await T.tryDirectTicketAck(f.client as never, false, ticket as never, { reply: "x", next_status: "in_progress" }, "text"), false);
    assert.equal(f.calls.length, 0);
  });

  test("money text is still refused by the gate", async () => {
    const f = fakeClient();
    assert.equal(await T.tryDirectTicketAck(f.client as never, true, ticket as never, { reply: "x", next_status: "in_progress" }, "please issue a refund to our credit card"), false);
    assert.equal(f.calls.length, 0);
  });

  test("the completion note posts directly, resolves, and leaves a RESOLUTION_POSTED marker", async () => {
    const f = fakeClient();
    const ok = await T.tryDirectTicketResolution(f.client as never, true, ticket as never, { reply: "done", next_status: "resolved" }, "Move internal staff");
    assert.equal(ok, true);
    assert.ok(f.calls.some((c) => c.name === "project_support_tickets_update" && c.args.status === "resolved"));
    assert.ok(f.calls.some((c) => c.args.is_internal === true && String(c.args.body).includes(T.RESOLUTION_POSTED)));
  });
});

describe("in-scope change requests start work on their own", () => {
  type Call = { name: string; args: Record<string, unknown> };
  // A stateful fake OS: tracks the CR status through updates, the OS task list, and comments.
  const fakeOs = (startStatus: string, comments: Array<Record<string, unknown>> = []) => {
    const calls: Call[] = [];
    const state = { status: startStatus, tasks: [] as Array<{ description: string }>, comments: [...comments] };
    const reply = (v: unknown) => [{ type: "text", text: JSON.stringify(v) }];
    return {
      calls, state,
      client: {
        callTool: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          if (name === "project_change_requests_list") return reply([{ id: "cr1", status: state.status }]);
          if (name === "project_change_requests_update") { state.status = String(args.status); return reply({ ok: true }); }
          if (name === "project_tasks_list") return reply(state.tasks);
          if (name === "project_tasks_create") { state.tasks.push({ description: String(args.description) }); return reply({ ok: true }); }
          if (name === "project_change_request_comments_list") return reply(state.comments);
          if (name === "project_change_request_comments_create") { state.comments.push(args); return reply({ ok: true }); }
          return reply([]);
        },
      },
    };
  };
  const cr = { id: "cr1", org_id: "o", project_id: "p", title: "be able to update/change addresses", description: "change pickup address after ordering", status: "under_review", client_name: "Jackson Example", priority: "medium" };
  let saved: Record<string, string | undefined> = {};
  before(() => {
    saved = { c: process.env.FRIDAY_CLIENT_COMMS, a: process.env.FRIDAY_AUTHORITY };
    process.env.FRIDAY_CLIENT_COMMS = "on";
    process.env.FRIDAY_AUTHORITY = "active";
    C._setOsClientCommsSwitch(true); // contract §6: the OS org switch must also be on
  });
  after(() => {
    C._setOsClientCommsSwitch(null);
    if (saved.c === undefined) delete process.env.FRIDAY_CLIENT_COMMS; else process.env.FRIDAY_CLIENT_COMMS = saved.c;
    if (saved.a === undefined) delete process.env.FRIDAY_AUTHORITY; else process.env.FRIDAY_AUTHORITY = saved.a;
  });

  test("hops follow the OS state machine", () => {
    assert.deepEqual(T.crHopsToApproved("under_review"), ["quoted_awaiting_approval", "approved"]);
    assert.deepEqual(T.crHopsToApproved("quoted_awaiting_approval"), ["approved"]);
    assert.deepEqual(T.crHopsToApproved("approved"), []);
  });

  test("an in-scope CR is approved, gets one pipeline task, moves to in_progress, and the client is told once", async () => {
    const f = fakeOs("under_review");
    let routed = 0;
    let linked: unknown = null;
    const deps = { route: async () => { routed++; linked = { id: "task1" }; return "task1"; }, findLinked: async () => linked as never };
    assert.equal(await T.startInScopeCr(f.client as never, true, cr as never, "local1", `${cr.title}\n${cr.description}`, deps), "started");
    const hops = f.calls.filter((c) => c.name === "project_change_requests_update").map((c) => c.args.status);
    assert.deepEqual(hops, ["quoted_awaiting_approval", "approved", "in_progress"]);
    assert.equal(routed, 1);
    assert.equal(f.state.tasks.length, 1);
    assert.equal(f.state.comments.filter((c) => c.is_internal === false).length, 1);
    // A second pass (already in_progress) creates nothing new and says nothing new.
    assert.equal(await T.startInScopeCr(f.client as never, true, cr as never, "local1", `${cr.title}\n${cr.description}`, deps), "started");
    assert.equal(routed, 1);
    assert.equal(f.state.tasks.length, 1);
    assert.equal(f.state.comments.filter((c) => c.is_internal === false).length, 1);
  });

  test("money text is not started", async () => {
    const f = fakeOs("under_review");
    let routed = 0;
    const r = await T.startInScopeCr(f.client as never, true, cr as never, "local1", "please refund the charge to our credit card", { route: async () => { routed++; return "x"; }, findLinked: async () => null });
    assert.equal(r, "blocked");
    assert.equal(routed, 0);
    assert.equal(f.calls.length, 0);
  });

  test("an inactive run is not started", async () => {
    const f = fakeOs("under_review");
    assert.equal(await T.startInScopeCr(f.client as never, false, cr as never, "local1", "text", { route: async () => "x", findLinked: async () => null }), "blocked");
    assert.equal(f.calls.length, 0);
  });

  test("reviewedInScope: acked in-scope CRs qualify; out-of-scope (scope-parked) ones do not", () => {
    const inScope = [{ is_internal: true, body: 'FRIDAY review: "x" (design, medium) — in scope. No contract scope index. [os-cr:cr1]' }];
    assert.equal(T.reviewedInScope(inScope), true);
    const outScope = [...inScope, { is_internal: true, body: `FRIDAY scope review: OUT OF SCOPE. ${T.SCOPE_PARKED}`, created_at: new Date().toISOString() }];
    assert.equal(T.reviewedInScope(outScope), false);
    assert.equal(T.reviewedInScope([{ is_internal: false, body: "Hi Jackson" }]), false);
  });
});

describe("retired projects", () => {
  test("moved rows with a foreign local id are retired; real FRIDAY projects never are", () => {
    const isFriday = (id: string) => id === "local-f1";
    const ids = T.retiredProjectIds(
      [
        { project_id: "p-friday", local_project_id: "local-f1" },   // FRIDAY's own project
        { project_id: "p-moved", local_project_id: "retired-local" }, // migrated row, another agent's local id
        { project_id: "p-unmapped", local_project_id: null },       // FRIDAY project with no repo: reply-only as before
      ],
      isFriday,
    );
    assert.deepEqual([...ids].sort(), ["p-moved"]);
  });

  test("osToLocalProjectMap only maps local ids FRIDAY actually has", async () => {
    const { store } = await import("@/lib/persistence/store");
    const now = new Date().toISOString();
    await store.projects.insert({ id: "local-known", name: "Known", status: "active", createdAt: now, updatedAt: now } as never);
    const reply = (v: unknown) => [{ type: "text", text: JSON.stringify(v) }];
    const ctx = { osClient: { callTool: async () => reply([
      { project_id: "p1", local_project_id: "local-known" },
      { project_id: "p2", local_project_id: "retired-local-id" },
    ]) } } as never;
    const map = await T.osToLocalProjectMap(ctx);
    assert.deepEqual([...map.entries()], [["p1", "local-known"]]);
  });
});

test("partitionSweep: retired items are filtered out BEFORE the per-run limit; a failed lookup fails closed", () => {
  const items = [
    { project_id: "ret", id: "1" }, { project_id: "ret", id: "2" }, { project_id: "ret", id: "3" },
    { project_id: "fri", id: "4" }, { project_id: "other", id: "5" },
  ];
  const ok = T.partitionSweep(items, new Set(["ret"]), (id) => id === "fri", 2);
  assert.deepEqual(ok.retired.map((i) => i.id), ["1", "2", "3"]);
  assert.deepEqual(ok.work.map((i) => i.id), ["4", "5"], "retired items never use up the limit");
  const failed = T.partitionSweep(items, null, (id) => id === "fri", 10);
  assert.deepEqual(failed.retired, [], "nothing is referred on a failed lookup");
  assert.deepEqual(failed.work.map((i) => i.id), ["4"], "only known FRIDAY projects are worked");
  assert.equal(failed.deferred, 4);
});

test("clarifyFallbackAllowed: never for a retired project; unmapped records wait when the lookup failed", () => {
  assert.equal(T.clarifyFallbackAllowed({ osProjectId: "ret", localProjectId: "x" }, new Set(["ret"])), false);
  assert.equal(T.clarifyFallbackAllowed({ osProjectId: "fri", localProjectId: "x" }, new Set(["ret"])), true);
  assert.equal(T.clarifyFallbackAllowed({ osProjectId: "fri", localProjectId: "x" }, null), true);
  assert.equal(T.clarifyFallbackAllowed({ osProjectId: "other" }, null), false);
});

describe("stuck change-request escalation (audit gap 5)", () => {
  const DAY = 86_400_000;
  const now = Date.parse("2026-10-28T12:00:00Z");
  const cr = (id: string, status: string, daysAgo: number, project_id = "p1") =>
    ({ id, project_id, title: `CR ${id}`, status, updated_at: new Date(now - daysAgo * DAY).toISOString() });

  test("findStuckCrs: only in_progress/under_review older than 7 days, not yet escalated, not excluded", async () => {
    const { findStuckCrs } = await import("./crStuck");
    const rows = [
      cr("a", "in_progress", 23), cr("b", "under_review", 65), cr("c", "in_progress", 3),
      cr("d", "approved", 30), cr("e", "in_progress", 10), cr("f", "in_progress", 9, "retired"),
    ];
    const out = findStuckCrs(rows, now, new Set(["e"]), { exclude: (r) => r.project_id === "retired" });
    assert.deepEqual(out.map((r) => r.id), ["a", "b"]);
    assert.equal(out[0].stuckDays, 23);
  });

  test("crStateSince takes the latest status timestamp", async () => {
    const { crStateSince } = await import("./crStuck");
    assert.equal(crStateSince({ id: "x", project_id: "p", status: "in_progress", updated_at: "2026-10-01T00:00:00Z", approved_at: "2026-10-05T00:00:00Z" }), Date.parse("2026-10-05T00:00:00Z"));
    assert.equal(crStateSince({ id: "x", project_id: "p", status: "in_progress" }), null);
  });

  test("escalateStuckCrs pages once per CR (dedupe key cr-stuck:<id>) and the ledger survives a 'restart'", async () => {
    const { escalateStuckCrs } = await import("./crStuck");
    const sent: Array<{ dedupeKey: string; text: string }> = [];
    const notify = async (i: { dedupeKey: string; text: string }) => { sent.push(i); return { email: true, queued: false }; };
    const rows = [cr("s1", "in_progress", 23), cr("s2", "under_review", 65), cr("ok", "in_progress", 1)];
    const first = await escalateStuckCrs(rows, { now, notify, projectName: () => "Acme" });
    assert.equal(first.escalated, 2);
    assert.deepEqual(sent.map((s) => s.dedupeKey).sort(), ["cr-stuck:s1", "cr-stuck:s2"]);
    assert.match(sent[0].text, /Acme/);
    const second = await escalateStuckCrs(rows, { now, notify });
    assert.equal(second.escalated, 0, "already escalated ⇒ no second page");
    assert.equal(sent.length, 2);
  });

  test("a failed notification is not recorded, so the next sweep retries", async () => {
    const { escalateStuckCrs } = await import("./crStuck");
    let calls = 0;
    const failing = async () => { calls++; throw new Error("os down"); };
    const rows = [cr("retry-me", "in_progress", 12)];
    const r1 = await escalateStuckCrs(rows, { now, notify: failing });
    assert.equal(r1.escalated, 0);
    const r2 = await escalateStuckCrs(rows, { now, notify: async () => ({ email: false, queued: true }) });
    assert.equal(r2.escalated, 1, "queued-for-retry counts as escalated");
    assert.equal(calls, 1);
  });
});
