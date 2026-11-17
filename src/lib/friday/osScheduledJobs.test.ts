// OS-scheduled SEO / AI-visibility jobs (2026-10-28): the moved schedules fire through the same
// runner as local schedules, are shadow-safe, skip a still-running prior run, and the local copies
// stand down while FRIDAY_SEO_SCHEDULES_IN_OS=1 (the lead-research job never fires again).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-osscheduled-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;

let J: typeof import("./osScheduledJobs");
let D: typeof import("./scheduledDispatch");
let store: typeof import("@/lib/persistence/store").store;
before(async () => {
  J = await import("./osScheduledJobs");
  D = await import("./scheduledDispatch");
  store = (await import("@/lib/persistence/store")).store;
  await store.projects.insert({ id: "loc-globex", name: "Globex Website", status: "active", createdAt: "", updatedAt: "" } as never);
});
after(() => rmSync(TMP, { recursive: true, force: true }));

const reply = (v: unknown) => [{ type: "text", text: JSON.stringify(v) }];
const ctx = (mode: "active" | "shadow", meta: unknown[] = []) => ({
  osClient: { callTool: async (name: string) => (name === "project_agent_meta_get" ? reply(meta) : reply([])) },
  orgId: "o", agentUserId: "u", mode,
}) as never;
const run = (over: Record<string, unknown> = {}) => ({
  run_id: "r1", schedule_id: "s1", task_key: "friday.seo_weekly_audit", subject_id: "os-globex", title: "Weekly SEO audit",
  config: { local_project_id: "loc-globex", assignee: "seo", risk: "low", title_template: "Weekly on-site SEO audit — {project}", prompt: "Audit {project}." },
  scheduled_for: "", mode: "active", risk_tier: "autonomous", output_kind: "owner_briefing", approval_required: false, lease_expires_at: "", attempt: 1,
  ...over,
}) as never;

function deps(overrides: Partial<import("./osScheduledJobs").OsSeoJobDeps> = {}) {
  const dispatched: Array<Record<string, unknown>> = [];
  const d: import("./osScheduledJobs").OsSeoJobDeps = {
    budgetBlock: async () => null,
    dispatch: async (spec) => { dispatched.push(spec as never); return { taskId: "t1", runId: "run-1", gated: false }; },
    runStillRunning: async () => false,
    ...overrides,
  };
  return { d, dispatched };
}

test("the schedules JSON handed to the OS agent uses exactly the task_keys FRIDAY registers", () => {
  const f = path.join(os.homedir(), "backups", "orion", "friday-seo-schedules.json");
  let jobs: Array<{ task_key: string; config: { legacy_local_schedule_id: string } }> = [];
  try { jobs = JSON.parse(readFileSync(f, "utf8")).jobs; } catch { return; } // file only exists on the ops box
  for (const j of jobs) assert.ok((J.OS_SEO_TASK_KEYS as readonly string[]).includes(j.task_key), j.task_key);
  assert.deepEqual(jobs.map((j) => j.config.legacy_local_schedule_id).sort(), [...D.MIGRATED_SEO_SCHEDULE_IDS].sort());
});

test("active run dispatches through the shared runner with the configured title/prompt/assignee", async () => {
  const { d, dispatched } = deps();
  const r = await J.runOsSeoJob(run(), ctx("active"), d);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0], { projectId: "loc-globex", projectName: "Globex Website", titleTemplate: "Weekly on-site SEO audit — {project}", description: "Audit {project}.", assignee: "seo", risk: "low" });
  assert.deepEqual(r.result, { task_id: "t1", run_id: "run-1", gated: false, project_id: "loc-globex" });
});

test("shadow (either side) only reports what it would dispatch", async () => {
  const { d, dispatched } = deps();
  const a = await J.runOsSeoJob(run(), ctx("shadow"), d);
  const b = await J.runOsSeoJob(run({ mode: "shadow" }), ctx("active"), d);
  assert.equal(dispatched.length, 0);
  assert.match(a.summary ?? "", /\[shadow\] would dispatch "Weekly on-site SEO audit — Globex Website"/);
  assert.equal(b.result?.["would_dispatch"], true);
});

test("a still-running previous run for the same project+key is skipped; budget block throws", async () => {
  const { d, dispatched } = deps({ runStillRunning: async (id) => id === "run-1" });
  const r = await J.runOsSeoJob(run(), ctx("active"), d);
  assert.equal(dispatched.length, 0);
  assert.match(r.summary ?? "", /still running/);
  const { d: d2 } = deps({ budgetBlock: async () => "spend cap", runStillRunning: async () => false });
  await assert.rejects(J.runOsSeoJob(run({ task_key: "friday.ai_visibility_monthly" }), ctx("active"), d2), /spend cap/);
});

test("project resolution falls back to subject_id via project_agent_meta, and an unknown project fails the run", async () => {
  const { d, dispatched } = deps();
  await J.runOsSeoJob(run({ config: {}, task_key: "friday.ai_visibility_monthly" }), ctx("active", [{ project_id: "os-globex", local_project_id: "loc-globex" }]), d);
  assert.equal(dispatched[0]["titleTemplate"], "Monthly AI-search visibility check — {project}");
  assert.equal(dispatched[0]["assignee"], "seo");
  await assert.rejects(J.runOsSeoJob(run({ config: {}, subject_id: "nope" }), ctx("active"), d), /no local FRIDAY project/);
});

test("localScheduleRetired: retired ids always; migrated SEO ids only while FRIDAY_SEO_SCHEDULES_IN_OS=1", () => {
  const env = { FRIDAY_RETIRED_SCHEDULE_IDS: "retired-1", FRIDAY_MIGRATED_SCHEDULE_IDS: "seo-1, seo-2" };
  assert.equal(D.localScheduleRetired({ id: "retired-1" }, env), true);
  const seo = { id: "seo-1" };
  assert.equal(D.localScheduleRetired(seo, env), false);
  assert.equal(D.localScheduleRetired(seo, { ...env, FRIDAY_SEO_SCHEDULES_IN_OS: "1" }), true);
  assert.equal(D.localScheduleRetired({ id: "user-made" }, { ...env, FRIDAY_SEO_SCHEDULES_IN_OS: "1" }), false);
});
