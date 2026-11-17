// authority — the origin-aware autonomy decision (2026-09) and the evaluateAuthority wrapper that
// layers the master switch (authority dial) and the policy selector (autonomy_policy dial) on top.
//
// Runs via `npm test` (node's built-in runner, same harness as golden.test.ts). Each test file runs
// in its own process, so the data dir is pointed at a throwaway temp dir BEFORE the store/dials
// modules load (dynamic import below) — a live dials.json must never leak into these assertions.
// Dials resolve dial > env > default; with an empty data dir the env var decides, and
// invalidateDialCache() makes each env change visible to the next synchronous read.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-authority-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;

type AuthorityMod = typeof import("./authority");
type DialsMod = typeof import("./dials");
let A: AuthorityMod;
let D: DialsMod;

const ENV_KEYS = ["FRIDAY_AUTHORITY", "FRIDAY_AUTONOMY_POLICY", "FRIDAY_CLIENT_COMMS"] as const;
const saved: Record<string, string | undefined> = {};

function setEnv(k: (typeof ENV_KEYS)[number], v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  D.invalidateDialCache();
}

before(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  A = await import("./authority");
  D = await import("./dials");
});

after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(TMP, { recursive: true, force: true });
});

describe("decideAutonomy — origin matrix", () => {
  const cases: Array<[string, Parameters<AuthorityMod["decideAutonomy"]>[0], 1 | 3]> = [
    // Owner-sanctioned origins auto-run ordinary work — including production deploys.
    ["owner dispatch", { origin: "owner", actionClass: "task_dispatch", risk: "medium" }, 1],
    ["owner prod deploy (high risk)", { origin: "owner", actionClass: "deploy", risk: "high" }, 1],
    ["clara email reply", { origin: "clara", actionClass: "email_reply", risk: "medium" }, 1],
    ["scheduler weekly update", { origin: "scheduler", actionClass: "weekly_update", risk: "low" }, 1],
    ["scheduler deploy", { origin: "scheduler", actionClass: "deploy", risk: "high" }, 1],
    ["owner ignores scope (new)", { origin: "owner", actionClass: "task_dispatch", risk: "low", scope: "new" }, 1],
    // Client work: in approved scope only.
    ["client in_scope dispatch", { origin: "client", actionClass: "task_dispatch", risk: "medium", scope: "in_scope" }, 1],
    ["client in_scope deploy", { origin: "client", actionClass: "deploy", risk: "high", scope: "in_scope" }, 1],
    ["client in_scope reply", { origin: "client", actionClass: "email_reply", risk: "medium", scope: "in_scope" }, 1],
    ["client new scope", { origin: "client", actionClass: "task_dispatch", risk: "low", scope: "new" }, 3],
    ["client unknown scope", { origin: "client", actionClass: "task_dispatch", risk: "low", scope: "unknown" }, 3],
    ["client scope absent ⇒ unknown", { origin: "client", actionClass: "client_notify", risk: "low" }, 3],
    // The owner's own ask (or CLARA relaying it) is the approval — critical risk included (owner rule
    // 2026-09-15). Money and self-edit still stop every origin.
    ["owner critical risk", { origin: "owner", actionClass: "task_dispatch", risk: "critical" }, 1],
    ["clara-relayed critical risk", { origin: "clara", actionClass: "deploy", risk: "critical" }, 1],
    // Floors — work nobody asked for, and clients.
    ["scheduler critical risk", { origin: "scheduler", actionClass: "deploy", risk: "critical" }, 3],
    ["client in_scope critical", { origin: "client", actionClass: "task_dispatch", risk: "critical", scope: "in_scope" }, 3],
    ["owner self-edit", { origin: "owner", actionClass: "task_dispatch", risk: "low", selfEdit: true }, 3],
    ["clara self-edit", { origin: "clara", actionClass: "task_dispatch", risk: "low", selfEdit: true }, 3],
    ["owner costsMoney flag", { origin: "owner", actionClass: "task_dispatch", risk: "low", costsMoney: true }, 3],
    ["owner money text (refund)", { origin: "owner", actionClass: "task_dispatch", risk: "low", text: "Issue a refund to the client" }, 3],
    ["scheduler money text (ad spend)", { origin: "scheduler", actionClass: "task_dispatch", risk: "low", text: "raise the ad spend on the campaign" }, 3],
    ["client in_scope money text (invoice)", { origin: "client", actionClass: "task_dispatch", risk: "medium", scope: "in_scope", text: "fix the invoice total on the checkout page" }, 3],
    ["client in_scope bank account", { origin: "client", actionClass: "email_reply", risk: "low", scope: "in_scope", text: "update our bank account details" }, 3],
    ["benign text passes", { origin: "owner", actionClass: "task_dispatch", risk: "medium", text: "Update the homepage hero copy and ship it" }, 1],
  ];
  for (const [name, input, tier] of cases) {
    test(`${name} → tier ${tier}`, () => {
      const d = A.decideAutonomy(input);
      assert.equal(d.tier, tier, d.reason);
      assert.ok(d.reason.length > 0);
    });
  }

  test("check order: self-edit, then money, then the owner's ask, then the critical floor", () => {
    assert.equal(A.decideAutonomy({ origin: "owner", actionClass: "deploy", risk: "critical", selfEdit: true, text: "refund" }).reason, "self-edit gate");
    assert.equal(A.decideAutonomy({ origin: "owner", actionClass: "deploy", risk: "critical", text: "refund" }).reason, "costs money");
    // Contracts/signatures always ask, whoever asked (2026-09-24).
    assert.equal(A.decideAutonomy({ origin: "owner", actionClass: "task_dispatch", risk: "low", text: "send the SOW for signature" }).tier, 3);
    assert.equal(A.decideAutonomy({ origin: "clara", actionClass: "email_reply", risk: "low", text: "attach the NDA and the master services agreement" }).reason, "contract/signature");
    assert.equal(A.decideAutonomy({ origin: "scheduler", actionClass: "task_dispatch", risk: "low", touchesContract: true }).tier, 3);
    assert.equal(A.decideAutonomy({ origin: "owner", actionClass: "task_dispatch", risk: "low", text: "sign-in page is broken" }).tier, 1);
    assert.match(A.decideAutonomy({ origin: "owner", actionClass: "deploy", risk: "critical" }).reason, /the owner asked/);
    assert.equal(A.decideAutonomy({ origin: "scheduler", actionClass: "deploy", risk: "critical" }).reason, "critical risk floor");
  });
});

describe("inferOrigin", () => {
  test("explicit stamp wins; else requesterClientId ⇒ client; else owner", () => {
    assert.equal(A.inferOrigin({ requestOrigin: "scheduler", requesterClientId: "c1" }), "scheduler");
    assert.equal(A.inferOrigin({ requesterClientId: "c1" }), "client");
    assert.equal(A.inferOrigin({}), "owner");
  });
});

describe("evaluateAuthority — master switch and policy dial", () => {
  test("authority=off ⇒ tier 3 for every origin (module inert)", async () => {
    setEnv("FRIDAY_AUTHORITY", "off");
    setEnv("FRIDAY_AUTONOMY_POLICY", undefined);
    const d = await A.evaluateAuthority({ actionClass: "deploy", risk: "high", origin: "owner" });
    assert.equal(d.mode, "off");
    assert.equal(d.tier, 3);
    assert.equal(d.wouldAuto, false);
  });

  test("origin policy (default) under active ⇒ decideAutonomy tier, reason prefixed origin-policy:", async () => {
    setEnv("FRIDAY_AUTHORITY", "active");
    setEnv("FRIDAY_AUTONOMY_POLICY", undefined);
    assert.equal(A.autonomyPolicy(), "origin");
    const owner = await A.evaluateAuthority({ actionClass: "deploy", risk: "high", origin: "owner" });
    assert.equal(owner.mode, "active");
    assert.equal(owner.tier, 1);
    assert.equal(owner.wouldAuto, true);
    assert.match(owner.reason, /^origin-policy: /);
    const client = await A.evaluateAuthority({ actionClass: "task_dispatch", risk: "medium", origin: "client" });
    assert.equal(client.tier, 3);
    assert.equal(client.scope, "unknown");
    const money = await A.evaluateAuthority({ actionClass: "task_dispatch", risk: "low", origin: "owner", text: "wire transfer to vendor" });
    assert.equal(money.tier, 3);
  });

  test("fail closed: an UNSTAMPED caller under the origin policy gets the legacy table, not owner", async () => {
    setEnv("FRIDAY_AUTHORITY", "active");
    setEnv("FRIDAY_AUTONOMY_POLICY", "origin");
    // No origin ⇒ no origin lane. A client-driven path that forgot to stamp must not auto-run as owner.
    const d = await A.evaluateAuthority({ actionClass: "email_reply", risk: "medium" });
    assert.equal(d.tier, 3);
    assert.equal(d.wouldAuto, false);
    assert.doesNotMatch(d.reason, /origin-policy/);
    const stamped = await A.evaluateAuthority({ actionClass: "email_reply", risk: "medium", origin: "owner" });
    assert.equal(stamped.tier, 1, "the same call stamped owner auto-runs");
  });

  test("shadow still computes the origin tier (callers only log it)", async () => {
    setEnv("FRIDAY_AUTHORITY", "shadow");
    setEnv("FRIDAY_AUTONOMY_POLICY", "origin");
    const d = await A.evaluateAuthority({ actionClass: "task_dispatch", risk: "medium", origin: "scheduler" });
    assert.equal(d.mode, "shadow");
    assert.equal(d.tier, 1);
    assert.equal(d.wouldAuto, true);
  });

  test("autonomy_policy=legacy ⇒ the profile × action-class table (deploy hard floor)", async () => {
    setEnv("FRIDAY_AUTHORITY", "active");
    setEnv("FRIDAY_AUTONOMY_POLICY", "legacy");
    assert.equal(A.autonomyPolicy(), "legacy");
    const deploy = await A.evaluateAuthority({ actionClass: "deploy", risk: "high", origin: "owner" });
    assert.equal(deploy.tier, 3);
    assert.equal(deploy.reason, "deploy × conservative → tier 3"); // already 3, so the floor note is absent
    const dispatch = await A.evaluateAuthority({ actionClass: "task_dispatch", risk: "low", origin: "owner" });
    assert.equal(dispatch.tier, A.classifyActionTier("task_dispatch", "conservative"));
    assert.doesNotMatch(dispatch.reason, /origin-policy/);
  });
});

describe("dials", () => {
  test("client_comms defaults off; env on flips it only while the OS org switch is on", async () => {
    const { clientCommsEnabled, _setOsClientCommsSwitch } = await import("./clientComms");
    _setOsClientCommsSwitch(true);
    setEnv("FRIDAY_CLIENT_COMMS", undefined);
    assert.equal(clientCommsEnabled(), false);
    setEnv("FRIDAY_CLIENT_COMMS", "on");
    assert.equal(clientCommsEnabled(), true);
    setEnv("FRIDAY_CLIENT_COMMS", "bogus");
    assert.equal(clientCommsEnabled(), false);
    // OS switch off (or unknown) ⇒ off, whatever env says.
    setEnv("FRIDAY_CLIENT_COMMS", "on");
    _setOsClientCommsSwitch(false);
    assert.equal(clientCommsEnabled(), false);
    _setOsClientCommsSwitch(null);
    assert.equal(clientCommsEnabled(), false, "unknown OS switch ⇒ off");
    setEnv("FRIDAY_CLIENT_COMMS", undefined);
  });

  test("client_comms: a dial 'on' can never override an env or OS 'off'", async () => {
    const { clientCommsEnabled, _setOsClientCommsSwitch, parseOsClientCommsSwitch } = await import("./clientComms");
    await D.setDial("client_comms", "on", "test");
    _setOsClientCommsSwitch(true);
    setEnv("FRIDAY_CLIENT_COMMS", "off");
    assert.equal(clientCommsEnabled(), false, "env off beats dial on");
    setEnv("FRIDAY_CLIENT_COMMS", undefined);
    _setOsClientCommsSwitch(false);
    assert.equal(clientCommsEnabled(), false, "OS off beats dial on");
    _setOsClientCommsSwitch(true);
    assert.equal(clientCommsEnabled(), true, "all three on ⇒ on");
    await D.setDial("client_comms", "off", "test");
    assert.equal(clientCommsEnabled(), false);
    _setOsClientCommsSwitch(null);
    assert.equal(parseOsClientCommsSwitch({ agent_client_comms_enabled: true }), true);
    assert.equal(parseOsClientCommsSwitch([{ settings: { agent_client_comms_enabled: false } }]), false);
    assert.equal(parseOsClientCommsSwitch({}), null);
  });
});

describe("inheritLineage", () => {
  test("an auto-round keeps the client origin, the requester and the chain root", () => {
    const parent = { id: "root", requestOrigin: "client" as const, requesterClientId: "c1", bypassAuthority: false, requestId: "req1", sourceTaskId: undefined, prUrl: "https://github.com/o/r/pull/5" };
    const l = A.inheritLineage(parent);
    assert.equal(l.requestOrigin, "client");
    assert.equal(l.requesterClientId, "c1");
    assert.equal(l.requestId, "req1");
    assert.equal(l.sourceTaskId, "root");
    assert.equal(l.prUrl, "https://github.com/o/r/pull/5");
    // a round of a round still points at the ROOT
    assert.equal(A.inheritLineage({ ...parent, id: "fix1", sourceTaskId: "root" }).sourceTaskId, "root");
  });
  test("without a stamp the origin is inferred (client when a requester is set, owner otherwise)", () => {
    assert.equal(A.inheritLineage({ id: "a", requesterClientId: "c9" }).requestOrigin, "client");
    assert.equal(A.inheritLineage({ id: "b" }).requestOrigin, "owner");
  });
});

test("contract gate also catches verb forms of accepting/approving a proposal", async () => {
  const { touchesContract } = await import("./risk");
  for (const t of ["accept the Acme proposal", "approve the proposal for Globex", "accepting their proposal today", "proposal accepted, go ahead"]) {
    assert.equal(touchesContract(t), true, t);
  }
  for (const t of ["fix the sign-in page", "draft a proposal for Acme", "the proposal draft looks good"]) {
    assert.equal(touchesContract(t), false, t);
  }
});
