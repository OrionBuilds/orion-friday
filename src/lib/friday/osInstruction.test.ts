// osInstruction — the generic "friday.instruction" OS task handler. Dependency-injected (planner,
// orchestrate, link table), so this suite never touches the store, an engine, or the OS.
// Runs via `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DueRun, PollContext, ResolvedRun } from "@autom8ionlab/agent-core";
import {
  deliverInstruction,
  externalEffects,
  instructionPrompt,
  instructionTask,
  normalizePlan,
  type InstructionDeps,
  type InstructionLink,
  type InstructionPlan,
  type OrchestrateOutcome,
} from "./osInstruction";

const due = (over: Partial<DueRun> = {}, config: Record<string, unknown> = {}): DueRun => ({
  run_id: "run-1",
  schedule_id: "sched-1",
  task_key: "friday.instruction",
  subject_id: null,
  title: "Weekly SEO check",
  config: { instructions: "Check the top 10 keywords for every client site and list movers.", ...config },
  scheduled_for: "2026-10-28T14:00:00Z",
  mode: "active",
  risk_tier: "owner_review",
  output_kind: "owner_briefing",
  approval_required: false,
  lease_expires_at: "2026-10-28T14:10:00Z",
  attempt: 1,
  ...over,
});

const ctx = (mode: PollContext["mode"] = "active"): PollContext => ({
  osClient: { callTool: async () => { throw new Error("OS must not be called by this handler"); } } as unknown as PollContext["osClient"],
  orgId: "org",
  agentUserId: "friday",
  mode,
});

const PLAN: InstructionPlan = { summary: "Pull keyword ranks and report movers.", steps: ["Fetch ranks", "Diff vs last week"], draft: "Hi team, movers this week: ..." };

function harness(opts: { plan?: InstructionPlan | null; orchestrate?: (m: string) => OrchestrateOutcome | Promise<OrchestrateOutcome> } = {}) {
  const links = new Map<string, InstructionLink>();
  const planned: string[] = [];
  const orchestrated: string[] = [];
  const d: InstructionDeps = {
    plan: async (p) => { planned.push(p); return opts.plan === undefined ? PLAN : opts.plan; },
    orchestrate: async (m) => {
      orchestrated.push(m);
      return opts.orchestrate ? opts.orchestrate(m) : { reply: "On it.", intent: "build", projectId: "p1", taskIds: ["t1", "t2"], runIds: ["r1"], approvalIds: [] };
    },
    links: {
      get: async (id) => links.get(id) ?? null,
      insert: async (l) => { links.set(l.id, l); },
      update: async (id, p) => { links.set(id, { ...links.get(id)!, ...p }); },
    },
    now: () => "2026-10-28T14:00:05Z",
  };
  return { d, links, planned, orchestrated };
}

test("missing or empty instructions fail the run with a clear message, before any model call", async () => {
  for (const config of [{ instructions: undefined }, { instructions: "   " }, { instructions: ["a"] }]) {
    const h = harness();
    await assert.rejects(instructionTask(due({}, config), ctx(), h.d), /config\.instructions is (missing|empty|a list)/);
    assert.equal(h.planned.length + h.orchestrated.length, 0);
  }
});

test("shadow (env gate or schedule) plans read-only and never orchestrates", async () => {
  for (const [c, r] of [[ctx("shadow"), due()], [ctx("active"), due({ mode: "shadow" })]] as const) {
    const h = harness();
    const out = await instructionTask(r, c, h.d);
    assert.equal(h.orchestrated.length, 0);
    assert.equal(h.planned.length, 1);
    assert.match(out.summary ?? "", /^Shadow plan — Weekly SEO check: Pull keyword ranks/);
    assert.equal(out.requestApproval, undefined);
    assert.deepEqual((out.result as { plan: InstructionPlan }).plan, PLAN);
    assert.equal(h.links.size, 0);
  }
});

test("shadow survives a dead planner — summary says so, run does not fail", async () => {
  const h = harness({ plan: null });
  const out = await instructionTask(due(), ctx("shadow"), h.d);
  assert.match(out.summary ?? "", /plan unavailable/);
  assert.equal(h.orchestrated.length, 0);
});

test("approval_required parks the plan + draft and does nothing outward", async () => {
  const h = harness();
  const out = await instructionTask(due({ approval_required: true }), ctx(), h.d);
  assert.equal(h.orchestrated.length, 0, "orchestrate must wait for the deliver handler");
  assert.ok(out.requestApproval);
  assert.equal(out.requestApproval!.draft_content.draft, PLAN.draft);
  assert.match(out.summary ?? "", /^Awaiting approval/);
  const ins = (out.result as { instruction: { prompt: string; plan_text: string } }).instruction;
  assert.match(ins.prompt, /Check the top 10 keywords/);
  assert.match(ins.plan_text, /1\. Fetch ranks/);
});

test("external_effects (true / non-empty list) forces approval; false / [] / 'none' do not", async () => {
  assert.deepEqual(externalEffects({ external_effects: false }), []);
  assert.deepEqual(externalEffects({ external_effects: [] }), []);
  assert.deepEqual(externalEffects({ external_effects: "none" }), []);
  assert.deepEqual(externalEffects({ external_effects: ["", "None"] }), []);
  assert.deepEqual(externalEffects({ external_effects: ["email the client"] }), ["email the client"]);
  assert.equal(externalEffects({ external_effects: true }).length, 1);

  const h = harness();
  const out = await instructionTask(due({}, { external_effects: ["email the client a summary"] }), ctx(), h.d);
  assert.equal(h.orchestrated.length, 0);
  assert.match(out.requestApproval!.description ?? "", /email the client a summary/);
  assert.deepEqual(out.requestApproval!.draft_content.external_effects, ["email the client a summary"]);
});

test("approval-required shadow runs still return requestApproval (no contract_gap; agent-core reports it shadow)", async () => {
  const h = harness();
  const out = await instructionTask(due({ approval_required: true }), ctx("shadow"), h.d);
  assert.ok(out.requestApproval);
  assert.match(out.summary ?? "", /^Shadow plan/);
  assert.equal(h.orchestrated.length, 0);
});

test("active runs orchestrate the full brief and report created ids", async () => {
  const h = harness();
  const out = await instructionTask(due({}, { scope: "client sites only", success_criteria: ["every site checked"], output_destination: "owner briefing" }), ctx(), h.d);
  assert.equal(h.planned.length, 0);
  assert.equal(h.orchestrated.length, 1);
  const m = h.orchestrated[0];
  for (const want of [/Check the top 10 keywords/, /Scope: client sites only/, /Success criteria: every site checked/, /Output destination: owner briefing/, /2026-10-28T14:00:00Z/, /run run-1/]) assert.match(m, want);
  assert.deepEqual((out.result as { task_ids: string[] }).task_ids, ["t1", "t2"]);
  assert.match(out.summary ?? "", /2 task\(s\) created, 1 dispatched/);
  assert.equal(h.links.get("run-1")?.status, "done");
});

test("a re-presented run replays its recorded outcome instead of orchestrating twice", async () => {
  const h = harness();
  await instructionTask(due(), ctx(), h.d);
  const again = await instructionTask(due({ attempt: 2 }), ctx(), h.d);
  assert.equal(h.orchestrated.length, 1);
  assert.equal((again.result as { replayed: boolean }).replayed, true);
  assert.deepEqual((again.result as { task_ids: string[] }).task_ids, ["t1", "t2"]);
});

test("a run that died mid-orchestrate is reported with an alert, not re-run", async () => {
  const h = harness();
  h.links.set("run-1", { id: "run-1", status: "started", startedAt: "2026-10-28T14:00:01Z" });
  const out = await instructionTask(due({ attempt: 2 }), ctx(), h.d);
  assert.equal(h.orchestrated.length, 0);
  assert.equal((out.result as { alerts: Array<{ kind: string }> }).alerts[0].kind, "instruction.interrupted");
});

test("orchestrate failure fails the run and is remembered", async () => {
  const h = harness({ orchestrate: () => { throw new Error("planner down"); } });
  await assert.rejects(instructionTask(due(), ctx(), h.d), /planner down/);
  assert.equal(h.links.get("run-1")?.status, "failed");
});

test("deliver executes exactly the approved prompt/plan/draft, once per run", async () => {
  const h = harness();
  const parked = await instructionTask(due({ approval_required: true }), ctx(), h.d);
  const resolved: ResolvedRun = { run_id: "run-1", task_key: "friday.instruction", status: "approved", result: parked.result!, deliverable_file_id: null };
  const out = await deliverInstruction(resolved, ctx(), h.d);
  assert.equal(h.orchestrated.length, 1);
  assert.match(h.orchestrated[0], /Check the top 10 keywords/);
  assert.match(h.orchestrated[0], /APPROVED/);
  assert.match(h.orchestrated[0], /Hi team, movers this week/);
  assert.deepEqual(out.delivery?.task_ids, ["t1", "t2"]);
  // deliver_confirm lost → re-presented → no second orchestrate
  await deliverInstruction(resolved, ctx(), h.d);
  assert.equal(h.orchestrated.length, 1);
});

test("deliver with no instruction payload is a no-op; a previously failed delivery is confirmed with its error", async () => {
  const h = harness();
  const empty = await deliverInstruction({ run_id: "run-x", task_key: "friday.instruction", status: "approved", result: {}, deliverable_file_id: null }, ctx(), h.d);
  assert.match(String(empty.delivery?.note), /nothing to deliver/);
  h.links.set("deliver:run-y", { id: "deliver:run-y", status: "failed", startedAt: "x", error: "boom" });
  const failed = await deliverInstruction({ run_id: "run-y", task_key: "friday.instruction", status: "approved", result: { instruction: { prompt: "do it" } }, deliverable_file_id: null }, ctx(), h.d);
  assert.deepEqual(failed.delivery, { failed: true, error: "boom" });
  assert.equal(h.orchestrated.length, 0);
});

test("normalizePlan / instructionPrompt edge cases", () => {
  assert.equal(normalizePlan(null), null);
  assert.equal(normalizePlan({ summary: "", steps: [] }), null);
  assert.deepEqual(normalizePlan({ steps: ["a", "", "b"] }), { summary: "a", steps: ["a", "b"], draft: "" });
  const p = instructionPrompt(due({ title: "" }), "Do the thing");
  assert.match(p, /"untitled"/);
  assert.doesNotMatch(p, /Scope:|External effects:/);
});
