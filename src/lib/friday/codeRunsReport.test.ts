// Code runs → OS (audit gap 6, contract §1): start and finish are upserted with external_id = run id,
// only on status transitions, in order, and a missing OS tool never throws into the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENTIC_OS_FRIDAY_DATA = mkdtempSync(path.join(os.tmpdir(), "friday-coderuns-"));

const { CodeRunsReporter, buildCodeRunReport, mapRunStatus, runKind, codeRunsReportEnabled } = await import("./codeRunsReport");
type AgentRun = import("./types").AgentRun;
type Task = import("./types").Task;

const task: Task = { id: "t1", projectId: "p1", title: "[Fix] login 500", status: "in_progress", assignee: "dev", risk: "low", order: 0, createdAt: "", updatedAt: "", prUrl: "https://github.com/example-org/x/pull/7", requestId: "req-1" };
const deps = {
  getTask: async (id: string) => (id === "t1" ? task : null),
  osProjectId: async (id: string) => (id === "p1" ? "os-proj-1" : null),
  osTaskId: async (id: string) => (id === "t1" ? "os-task-1" : null),
};
const baseRun: AgentRun = { id: "run-1", agentId: "dev", projectId: "p1", taskId: "t1", channel: "web", input: "[Fix] login 500", status: "running", startedAt: "2026-10-28T20:00:00Z" };

test("payload follows the contract: external_id = run id, OS ids resolved, terminal fields only at the end", async () => {
  const start = await buildCodeRunReport(baseRun, deps);
  assert.deepEqual(start, {
    external_id: "run-1", kind: "fix", status: "running", started_at: "2026-10-28T20:00:00Z",
    project_id: "os-proj-1", project_task_id: "os-task-1", request_ref: "req-1",
    summary: "[Fix] login 500", pr_url: "https://github.com/example-org/x/pull/7",
  });
  const done = await buildCodeRunReport({ ...baseRun, status: "error", error: "tests red", endedAt: "2026-10-28T20:20:00Z", servedEngine: "claude" }, deps);
  assert.equal(done.status, "failed");
  assert.equal(done.finished_at, "2026-10-28T20:20:00Z");
  assert.equal(done.error, "tests red");
  assert.equal(done.engine, "claude");
});

test("status and kind mapping", () => {
  assert.equal(mapRunStatus("done"), "succeeded");
  assert.equal(mapRunStatus("awaiting_approval"), "running");
  assert.equal(mapRunStatus("cancelled"), "cancelled");
  assert.equal(runKind("qa", "anything"), "qa");
  assert.equal(runKind("dev", "[Review] PR 4"), "review");
  assert.equal(runKind("dev", "Deploy the site"), "deploy");
  assert.equal(runKind("dev", "Build the pricing page"), "build");
  assert.equal(codeRunsReportEnabled({ FRIDAY_CODE_RUNS_REPORT: "off" }), false);
  assert.equal(codeRunsReportEnabled({}), true);
});

test("reporter: one upsert at start, one at finish, none for non-status patches, in order", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const client = { callTool: async (_n: string, a: Record<string, unknown> = {}) => { await new Promise((r) => setTimeout(r, a.status === "running" ? 20 : 0)); sent.push(a); return [{ type: "text", text: "{\"id\":\"x\"}" }]; } };
  const r = new CodeRunsReporter(deps, { client });
  const p1 = r.onRunChange(baseRun, { inserted: true });
  assert.equal(r.onRunChange({ ...baseRun, live: { headline: "x" } }, { inserted: false, patch: { live: { headline: "x" } } }), null, "live progress is not a transition");
  assert.equal(r.onRunChange(baseRun, { inserted: false, patch: { status: "running" } }), null, "same status twice is not re-sent");
  const p2 = r.onRunChange({ ...baseRun, status: "done", endedAt: "2026-10-28T20:05:00Z", summary: "Fixed" }, { inserted: false, patch: { status: "done" } });
  await Promise.all([p1, p2]);
  assert.deepEqual(sent.map((s) => s.status), ["running", "succeeded"], "the slow start upsert still lands first");
  assert.equal(sent[1].summary, "Fixed");
});

test("a missing OS tool degrades silently (no throw into the run write)", async () => {
  const client = { callTool: async () => { throw new Error('osmcp: tool "agent_code_runs_report" failed: Tool agent_code_runs_report not found'); } };
  const r = new CodeRunsReporter(deps, { client });
  await r.onRunChange({ ...baseRun, id: "run-2" }, { inserted: true });
  // reaching here without a rejection is the assertion
});
