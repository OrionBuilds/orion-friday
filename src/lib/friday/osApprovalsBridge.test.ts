// Approvals (audit gap 9, contract §3 + changes §D): the OS queue is the only authority, one 48h
// expiry, `expired` is never a reject, pending local asks migrate idempotently, and a raised ask
// can't be decided from a local surface.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENTIC_OS_FRIDAY_DATA = mkdtempSync(path.join(os.tmpdir(), "friday-approvals-"));

const B = await import("./osApprovalsBridge");
const { store } = await import("@/lib/persistence/store");
type Approval = import("./types").Approval;

const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let pullRows: unknown[] = [];
let mirrorFails = 0;
const text = (v: unknown) => [{ type: "text", text: JSON.stringify(v) }];

before(() => {
  B._setHubCallForTests(async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "agent_approval_mirror") {
      if (mirrorFails > 0) { mirrorFails--; throw new Error("hub down"); }
      return text({ created: true, approval: { id: `hub-${args.external_ref}` } });
    }
    if (tool === "agent_approval_pull_decisions") { const r = pullRows; pullRows = []; return text(r); }
    return text({ ok: true });
  });
});
after(() => B._setHubCallForTests(null));

function ask(id: string, over: Partial<Approval> = {}): Approval {
  return { id, action: `Ask ${id}`, risk: "high", status: "pending", requestedAt: "2026-10-28T15:14:00.000Z", ...over } as Approval;
}

test("one expiry for every risk: requestedAt + 48h", () => {
  for (const risk of ["low", "medium", "high", "critical"] as const) {
    assert.equal(B.expiresAtFor({ requestedAt: "2026-10-28T15:14:00.000Z", ...{ risk } }), "2026-10-30T15:14:00.000Z");
  }
  assert.equal(B.hubIdOf({ approval: { id: "x" } }), "x");
  assert.equal(B.hubIdOf([{ id: "y" }]), "y");
  assert.equal(B.hubIdOf({ created: true }), null);
});

test("raise is synchronous with retries and records the hub id; it fails loudly without one", async () => {
  await store.approvals.insert(ask("a1"));
  mirrorFails = 1;
  assert.equal(await B.raiseApproval((await store.approvals.get("a1"))!, { backoffMs: 1 }), true);
  assert.equal((await store.approvals.get("a1"))!.hubId, "hub-a1");
  const m = calls.filter((c) => c.tool === "agent_approval_mirror").at(-1)!;
  assert.equal(m.args.expires_at, "2026-10-30T15:14:00.000Z");
  await store.approvals.insert(ask("a2"));
  mirrorFails = 5;
  assert.equal(await B.raiseApproval((await store.approvals.get("a2"))!, { attempts: 2, backoffMs: 1 }), false);
  assert.equal((await store.approvals.get("a2"))!.hubId, undefined);
  mirrorFails = 0;
});

test("startup migration raises every pending ask (idempotent), later ticks only the unraised ones", async () => {
  await store.approvals.insert(ask("legacy-1"));
  const before = calls.length;
  await B.pullAndApplyDecisions();
  const raised = calls.slice(before).filter((c) => c.tool === "agent_approval_mirror").map((c) => c.args.external_ref);
  assert.ok(raised.includes("legacy-1") && raised.includes("a2") && raised.includes("a1"), `first tick migrates all pending: ${raised}`);
  const b2 = calls.length;
  await B.pullAndApplyDecisions();
  assert.equal(calls.slice(b2).filter((c) => c.tool === "agent_approval_mirror").length, 0, "nothing unraised left");
});

test("an OS-expired ask becomes `expired`, never `rejected`, and is acked", async () => {
  await store.approvals.insert(ask("e1", { hubId: "hub-e1" }));
  pullRows = [{ id: "hub-e1", external_ref: "e1", status: "expired" }];
  const out = await B.pullAndApplyDecisions();
  assert.match(out, /applied 1/);
  const row = (await store.approvals.get("e1"))!;
  assert.equal(row.status, "expired");
  assert.notEqual(row.status, "rejected");
  assert.ok(calls.some((c) => c.tool === "agent_approval_ack" && (c.args.ids as string[]).includes("hub-e1")));
});

test("a raised ask cannot be decided from a local surface; the OS decision applies", async () => {
  const { decideApproval } = await import("./orchestrator");
  await store.approvals.insert(ask("d1", { hubId: "hub-d1" }));
  for (const source of ["sms", "email", "web", "clara"] as const) {
    const r = await decideApproval("d1", "approved", { source });
    assert.equal(r!.status, "pending", `${source} refused`);
  }
  const r = await decideApproval("d1", "rejected", { source: "os" });
  assert.equal(r!.status, "rejected");
});
