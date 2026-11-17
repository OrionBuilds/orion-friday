// OS agent settings at FRIDAY's entry points: a paused FRIDAY refuses router turns (claimed as
// `clarifying` so callers send the refusal instead of falling through to the planner), and the CLI's
// OS MCP allow-list only ever narrows.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-intent-settings-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;
delete process.env.FRIDAY_AGENT_SETTINGS;

let S: typeof import("./agentSettings");
before(async () => { S = await import("./agentSettings"); });
beforeEach(() => S._resetAgentSettingsCache(null));
after(() => rmSync(TMP, { recursive: true, force: true }));

const snap = (root: Record<string, unknown>, subs: Record<string, unknown>[] = []) =>
  S.parseSettingsResponse({ success: true, data: { agent_key: "friday", ...root, subagents: subs } }, Date.now());

test("runIntent: paused in the OS → refusal reply, no model call, claimed so the planner doesn't run", async () => {
  S._resetAgentSettingsCache(snap({ status: "paused" }));
  const { runIntent } = await import("./intent");
  const out = await runIntent("deploy acme", { principal: "owner", source: "sms" });
  assert.equal(out.failed, false);
  assert.equal(out.clarifying, true);
  assert.equal(out.calls.length, 0);
  assert.match(out.reply, /FRIDAY is paused in the OS/);
});

test("osCliMcpAllow: no settings → full compiled list; denied/allowed narrow it, never widen", async () => {
  const { osCliMcpAllow, OS_CLI_MCP_ALLOW } = await import("./osClient");
  assert.deepEqual(osCliMcpAllow(), OS_CLI_MCP_ALLOW);
  const first = OS_CLI_MCP_ALLOW[0].replace(/^mcp__orion__/, "");
  const second = OS_CLI_MCP_ALLOW[1].replace(/^mcp__orion__/, "");
  S._resetAgentSettingsCache(snap({ tools: { allowed: null, denied: [first] } }));
  assert.ok(!osCliMcpAllow().includes(OS_CLI_MCP_ALLOW[0]));
  assert.equal(osCliMcpAllow().length, OS_CLI_MCP_ALLOW.length - 1);
  S._resetAgentSettingsCache(snap({}, [{ agent_key: "friday.qa", tools: { allowed: [second, "not_a_real_os_tool"], denied: [] } }]));
  assert.deepEqual(osCliMcpAllow("qa"), [OS_CLI_MCP_ALLOW[1]], "a specialist row narrows its own runs; unknown names are never added");
  assert.deepEqual(osCliMcpAllow("dev"), OS_CLI_MCP_ALLOW, "no row → FRIDAY's (unrestricted) list");
});
