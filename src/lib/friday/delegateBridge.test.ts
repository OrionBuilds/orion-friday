// delegateBridge: every FRIDAY→Clara hand-off now goes through the OS owner-notification channel
// (or says honestly that it is unavailable). Nothing may touch the retired CLARA app on :3939.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-delegate-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;
delete process.env.FRIDAY_CLARA_BASE_URL;
process.env.FRIDAY_QUIET_HOURS = "0-0";

type Bridge = typeof import("./delegateBridge");
type NotifyMod = typeof import("./notify");
let B: Bridge;
let N: NotifyMod;
const realFetch = globalThis.fetch;
const urls: string[] = [];
const sent: Array<{ kind: string; priority: string; text: string; dedupeKey: string; category?: string }> = [];

before(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    throw new Error("network is off in this test");
  }) as typeof fetch;
  B = await import("./delegateBridge");
  N = await import("./notify");
  N._setOwnerTransport(async (m) => { sent.push(m); return true; });
});
after(() => {
  N._setOwnerTransport(null);
  globalThis.fetch = realFetch;
  rmSync(TMP, { recursive: true, force: true });
});

describe("delegateBridge", () => {
  test("status texts go to the OS owner channel; failures are timely, the rest wait for the brief", async () => {
    await B.textOwnerAboutCr({ kind: "cr_received", text: "Got CR 1", dedupeKey: "cr1" });
    await B.textOwnerAboutCr({ kind: "cr_pr_failed", text: "PR failed", dedupeKey: "cr2" });
    await B.textOwnerAboutOps({ kind: "ops_branch_cleaned", text: "cleaned", dedupeKey: "o1" });
    await B.textOwnerAboutMigrations({ kind: "migrations_push_failed", text: "push failed", dedupeKey: "m1" });
    const by = Object.fromEntries(sent.map((m) => [m.kind, m.priority]));
    assert.equal(by["cr_received"], "normal");
    assert.equal(by["cr_pr_failed"], "critical");
    assert.equal(by["ops_branch_cleaned"], "normal");
    assert.equal(by["migrations_push_failed"], "critical");
    assert.deepEqual(urls, []);
  });

  test("scope meeting: tells the owner (client comms are off), does not email, retries are deduped", async () => {
    const r = await B.requestScopeMeetingEmail({ clientEmail: "c@x.com", clientName: "Cee", projectName: "P", crTitle: "More", dedupeKey: "[os-cr:1]" });
    assert.equal(r.ok, true);
    const m = sent.find((x) => x.kind === "scope_meeting");
    assert.ok(m);
    assert.match(m.text, /Schedule a scope call/);
    assert.match(m.text, /nothing was sent/);
    const again = await B.requestScopeMeetingEmail({ clientEmail: "c@x.com", dedupeKey: "[os-cr:1]" });
    assert.equal(again.ok, true);
    assert.equal(sent.filter((x) => x.kind === "scope_meeting").length, 1);
    assert.deepEqual(urls, []);
  });

  test("scope meeting reports failure (so the CR is retried) when the owner can't be reached", async () => {
    N._setOwnerTransport(async () => false);
    const r = await B.requestScopeMeetingEmail({ clientEmail: "d@x.com", dedupeKey: "[os-cr:2]" });
    assert.equal(r.ok, false);
    N._setOwnerTransport(async (m) => { sent.push(m); return true; });
  });

  test("delegating to Clara without an endpoint is an honest refusal, not a dead-port call", async () => {
    const r = await B.delegateFromFriday("clara", "call the client");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /retired/);
    assert.deepEqual(urls, []);
  });

  test("emergency escalation rides the OS with its category", async () => {
    const r = await B.escalateToClara({ category: "production", headline: "Site down", detail: "x is down", dedupeKey: "e1", kind: "uptime.down" });
    assert.equal(r.ok, true);
    const m = sent.find((x) => x.kind === "uptime.down");
    assert.ok(m);
    assert.equal(m.priority, "critical");
    assert.equal(m.category, "production");
  });
});
