// osUsageReport — FRIDAY's model-call ledger → OS agent_usage_report: field mapping, cursor, batching,
// and the allowlist gate (the tool is not in agent-core's FRIDAY_OS_TOOLS yet).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelCall } from "./types";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-usagereport-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;
delete process.env.FRIDAY_OS_USAGE_REPORT;
delete process.env.FRIDAY_OS_USAGE_BACKFILL_DAYS;

let U: typeof import("./osUsageReport");
before(async () => { U = await import("./osUsageReport"); });
beforeEach(() => { U._resetUsageReportWarnings(); rmSync(path.join(TMP, "cursor.json"), { force: true }); });
after(() => rmSync(TMP, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-29T12:00:00Z");
const row = (id: string, ts: string, over: Partial<ModelCall> = {}): ModelCall => ({ id, ts, engine: "claude", ...over });

test("toUsageCall maps engines to provider/auth type and keeps unknown cost as null", () => {
  assert.deepEqual(U.toUsageCall(row("a", "2026-10-29T10:00:00Z", { model: "claude-opus-4-8", tokensIn: 100.4, tokensOut: 20, costUsd: 0.31, taskId: "task-1", agentRole: "dev" })), {
    id: "a", ts: "2026-10-29T10:00:00Z", provider: "anthropic", model: "claude-opus-4-8", auth_type: "subscription",
    engine: "claude", purpose: "dev", input_tokens: 100, output_tokens: 20, cost_usd: 0.31, cost_source: "reported", task_ref: "task-1", status: "ok",
  });
  const codex = U.toUsageCall(row("b", "2026-10-29T10:00:00Z", { engine: "codex", tokensTotal: 5000, runId: "run-9" }));
  assert.equal(codex.provider, "openai");
  assert.equal(codex.auth_type, "subscription");
  assert.equal(codex.cost_usd, null);
  assert.equal(codex.cost_source, undefined);
  assert.equal(codex.task_ref, "run-9");
  const gem = U.toUsageCall(row("c", "2026-10-29T10:00:00Z", { engine: "gemini-api", provider: "google", authType: "api_key", model: "gemini-2.5-pro" }));
  assert.equal(gem.provider, "google");
  assert.equal(gem.auth_type, "api_key");
  assert.equal(U.toUsageCall(row("d", "2026-10-29T10:00:00Z", { engine: "lmstudio" })).auth_type, "local");
  assert.equal(U.toUsageCall(row("e", "2026-10-29T10:00:00Z", { engine: "mystery" })).auth_type, "unknown");
});

test("pendingCalls/advanceCursor: oldest first, ties at the cursor timestamp handled by id", () => {
  const rows = [row("3", "2026-10-29T10:00:02Z"), row("1", "2026-10-29T10:00:00Z"), row("2a", "2026-10-29T10:00:01Z"), row("2b", "2026-10-29T10:00:01Z")];
  const first = U.pendingCalls(rows, null, "2026-10-01T00:00:00Z");
  assert.deepEqual(first.map((r) => r.id), ["1", "2a", "2b", "3"]);
  const c1 = U.advanceCursor(null, first.slice(0, 2)); // pushed 1, 2a
  assert.deepEqual(c1, { ts: "2026-10-29T10:00:01Z", ids: ["2a"] });
  assert.deepEqual(U.pendingCalls(rows, c1, "x").map((r) => r.id), ["2b", "3"]);
  assert.deepEqual(U.pendingCalls(rows, null, "2026-10-29T10:00:01Z").map((r) => r.id), ["2a", "2b", "3"], "backfill floor");
});

test("not allowlisted → nothing sent, one warning, says what to fix", async () => {
  const sent: unknown[] = [];
  const logs: string[] = [];
  const d = {
    allowlist: ["agent_whoami"], enabled: () => true, rows: async () => [row("1", "2026-10-29T10:00:00Z")],
    callTool: async (_n: string, a: Record<string, unknown>) => { sent.push(a); return {}; },
    cursorFile: path.join(TMP, "cursor.json"), log: async (w: string) => { logs.push(w); },
  };
  assert.match(await U.pushModelCallUsage(d), /not in FRIDAY_OS_TOOLS/);
  await U.pushModelCallUsage(d);
  assert.equal(sent.length, 0);
  assert.deepEqual(logs, ["os.usage_report_not_allowlisted"]);
});

test("allowlisted: batches of ≤200, cursor persisted, re-run sends only new rows", async () => {
  const rows: ModelCall[] = Array.from({ length: 250 }, (_, i) => row(`r${i}`, new Date(NOW - (300 - i) * 1000).toISOString(), { costUsd: 0.01 }));
  const batches: Record<string, unknown>[][] = [];
  const cursorFile = path.join(TMP, "cursor.json");
  const d = {
    allowlist: ["agent_usage_report"], enabled: () => true, rows: async () => rows, now: () => NOW, cursorFile,
    callTool: async (name: string, a: Record<string, unknown>) => {
      assert.equal(name, "agent_usage_report");
      const calls = a.calls as Record<string, unknown>[];
      batches.push(calls);
      return { accepted: calls.length, rejected: [] };
    },
  };
  assert.equal(await U.pushModelCallUsage(d), "usage: pushed 250");
  assert.deepEqual(batches.map((b) => b.length), [200, 50]);
  assert.equal(JSON.parse(readFileSync(cursorFile, "utf8")).ts, rows[249].ts);
  assert.equal(await U.pushModelCallUsage(d), "usage: nothing new");
  rows.push(row("new", new Date(NOW).toISOString()));
  assert.equal(await U.pushModelCallUsage(d), "usage: pushed 1");
  assert.equal(batches[2][0].id, "new");
});

test("a failed batch does not advance the cursor and reports the failure", async () => {
  const cursorFile = path.join(TMP, "cursor.json");
  let fail = true;
  const sent: string[] = [];
  const d = {
    allowlist: ["agent_usage_report"], enabled: () => true, now: () => NOW, cursorFile,
    rows: async () => [row("x", new Date(NOW - 1000).toISOString())],
    callTool: async (_n: string, a: Record<string, unknown>) => {
      if (fail) throw new Error("Orion unreachable");
      sent.push(...(a.calls as { id: string }[]).map((c) => c.id));
      return { accepted: 1, rejected: [] };
    },
  };
  assert.match(await U.pushModelCallUsage(d), /usage push failed: Orion unreachable/);
  fail = false;
  assert.equal(await U.pushModelCallUsage(d), "usage: pushed 1");
  assert.deepEqual(sent, ["x"]);
});

test("off switch and not-signed-in short-circuit", async () => {
  process.env.FRIDAY_OS_USAGE_REPORT = "off";
  try { assert.match(await U.pushModelCallUsage({ allowlist: ["agent_usage_report"] }), /off/); } finally { delete process.env.FRIDAY_OS_USAGE_REPORT; }
  assert.equal(await U.pushModelCallUsage({ allowlist: ["agent_usage_report"], enabled: () => false }), "os not connected");
});
