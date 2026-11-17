// ownerCommands — plain-language approvals (2026-09-24): the owner names the row in words; a
// unique name match decides, an ambiguous one asks, a question never approves, and no reply ever
// carries a code.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-ownercmd-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;
process.env.FRIDAY_CLIENT_COMMS = "off";
process.env.FRIDAY_CLARA_BASE_URL = "http://127.0.0.1:9";

type Cmd = typeof import("./ownerCommands");
type Store = typeof import("@/lib/persistence/store");
let M: Cmd;
let S: Store;

const realFetch = globalThis.fetch;

before(async () => {
  globalThis.fetch = (async () => { throw new Error("no network in tests"); }) as typeof fetch;
  M = await import("./ownerCommands");
  S = await import("@/lib/persistence/store");
});
after(() => {
  globalThis.fetch = realFetch;
  rmSync(TMP, { recursive: true, force: true });
});

function row(id: string, action: string, extra: Record<string, unknown> = {}) {
  return { id, action, risk: "low", status: "pending", requestedAt: new Date(Date.now() - 60_000).toISOString(), ...extra } as unknown as import("./types").Approval;
}

describe("matchByName (pure)", () => {
  test("a unique ≥2-token overlap selects the row; one token is not enough", () => {
    const rows = [row("a", "Send the Globex monthly report to Dana"), row("b", "Deploy mAI Dashboard hotfix")];
    assert.deepEqual(M.matchByName("go ahead with the globex report", rows).map((r) => r.id), ["a"]);
    assert.deepEqual(M.matchByName("yes, the mai dashboard one", rows).map((r) => r.id), ["b"]);
    assert.deepEqual(M.matchByName("approve the report", rows), []);
  });
  test("client and project names from facts count", () => {
    const rows = [row("a", "Dispatch Developer", { facts: { kind: "client_request", clientName: "Eli Miller", requestKind: "feature", summary: "lead export", projectName: "Globex", agentName: "Developer", taskTitle: "Lead export", risk: "low" } })];
    assert.deepEqual(M.matchByName("do it for eli miller", rows).map((r) => r.id), ["a"]);
  });
});

describe("handleOwnerApproval", () => {
  test("nothing pending → not a command", async () => {
    assert.equal(await M.handleOwnerApproval("approve the report"), null);
  });

  test("a question never decides, even with one pending", async () => {
    await S.store.approvals.insert(row("q1", "Send the Globex monthly report to Dana"));
    assert.equal(await M.handleOwnerApproval("can you do it tomorrow?"), null);
    assert.equal((await S.store.approvals.get("q1"))?.status, "pending");
    await S.store.approvals.remove("q1");
  });

  test("ambiguous with several pending → asks by name, no codes", async () => {
    await S.store.approvals.insert(row("r1", "Send the Globex monthly report to Dana"));
    await S.store.approvals.insert(row("r2", "Deploy mAI Dashboard hotfix"));
    const reply = await M.handleOwnerApproval("yes");
    assert.ok(reply && /Which one/.test(reply), reply ?? "null");
    assert.doesNotMatch(reply!, /#[0-9A-F]{3,6}\b/i);
    assert.equal((await S.store.approvals.get("r1"))?.status, "pending");
    assert.equal((await S.store.approvals.get("r2"))?.status, "pending");
    await S.store.approvals.remove("r1"); await S.store.approvals.remove("r2");
  });

  test("a rejection by name decides only that row and names it back without a code", async () => {
    await S.store.approvals.insert(row("n1", "Send the Globex monthly report to Dana"));
    await S.store.approvals.insert(row("n2", "Deploy mAI Dashboard hotfix"));
    const reply = await M.handleOwnerApproval("hold off on the globex report");
    assert.ok(reply && /^Rejected/.test(reply), reply ?? "null");
    assert.doesNotMatch(reply!, /#[0-9A-F]{3,6}\b/i);
    assert.equal((await S.store.approvals.get("n1"))?.status, "rejected");
    assert.equal((await S.store.approvals.get("n1"))?.decidedBy, "owner via sms");
    assert.equal((await S.store.approvals.get("n2"))?.status, "pending");
    await S.store.approvals.remove("n1"); await S.store.approvals.remove("n2");
  });

  test("pendingApprovalsBlock lists names, never codes", async () => {
    await S.store.approvals.insert(row("p1", "Send the Globex monthly report to Dana"));
    const block = await M.pendingApprovalsBlock();
    assert.match(block, /Globex monthly report/);
    assert.doesNotMatch(block, /#[0-9A-F]{3,6}\b/i);
    await S.store.approvals.remove("p1");
  });
});
