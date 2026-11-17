// notify + channels owner gate (owner rule 2026-09-24): FRIDAY never texts or phones the owner.
//
// Runs via `npm test`. Each test file runs in its own process; the data dir is pointed at a temp
// dir BEFORE the store/channels/notify modules load (dynamic import below), CLARA's base URL is
// pointed at a closed port so an "escalation" can never reach the live CLARA, and global fetch is
// stubbed so nothing reaches Twilio.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-notify-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;
process.env.FRIDAY_CLARA_BASE_URL = "http://127.0.0.1:9"; // closed port: escalation fails fast
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "tokentest";
process.env.TWILIO_FROM_NUMBER = "+15550000000";
process.env.FRIDAY_OWNER_NUMBER = "+15551234567";
delete process.env.FRIDAY_OWNER_SMS;
delete process.env.FRIDAY_OWNER_CALLS;
process.env.FRIDAY_QUIET_HOURS = "0-0"; // never quiet, so timely/emergency paths run

const OWNER = "+15551234567";
type ChannelsMod = typeof import("./channels");
type NotifyMod = typeof import("./notify");
type StoreMod = typeof import("@/lib/persistence/store");
let C: ChannelsMod;
let N: NotifyMod;
let S: StoreMod;

const realFetch = globalThis.fetch;
const fetched: string[] = [];

before(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetched.push(url);
    if (url.includes("api.twilio.com")) return new Response(JSON.stringify({ sid: "SMtest" }), { status: 201, headers: { "content-type": "application/json" } });
    throw new Error(`connect ECONNREFUSED ${url}`);
  }) as typeof fetch;
  C = await import("./channels");
  N = await import("./notify");
  S = await import("@/lib/persistence/store");
});
after(() => {
  globalThis.fetch = realFetch;
  rmSync(TMP, { recursive: true, force: true });
});

describe("retired by default: FRIDAY has no SMS/voice line of her own", () => {
  test("with the rollback switch off nothing reaches Twilio, whoever the number is", async () => {
    delete process.env.FRIDAY_LEGACY_CHANNELS;
    fetched.length = 0;
    for (const to of [OWNER, "+15557778888"]) {
      const r = await C.sendSMS(to, "hello");
      assert.equal(r.ok, false);
    }
    assert.equal((await C.placeCall("+15557778888", "call")).ok, false);
    assert.ok(!fetched.some((u) => u.includes("api.twilio.com")));
    assert.equal(C.twilioConfig(), null);
  });
});

describe("owner SMS gate (only matters if the rollback switch is on)", () => {
  before(() => { process.env.FRIDAY_LEGACY_CHANNELS = "on"; });
  after(() => { delete process.env.FRIDAY_LEGACY_CHANNELS; });

  test("an unprompted text to the owner is blocked and logged, nothing reaches Twilio", async () => {
    fetched.length = 0;
    const r = await C.sendSMS(OWNER, "hello");
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.ok(!fetched.some((u) => u.includes("api.twilio.com")));
    const logs = await S.store.logs.tail(20, (l) => l.event === "owner_sms.blocked");
    assert.ok(logs.length >= 1);
  });

  test("a reply to a text the owner just sent goes through", async () => {
    fetched.length = 0;
    await C.markOwnerInbound(OWNER);
    const r = await C.sendSMS(OWNER, "reply", { inboundReply: { from: OWNER } });
    assert.equal(r.ok, true);
    assert.ok(fetched.some((u) => u.includes("api.twilio.com")));
  });

  test("inboundReply cannot be pointed at a different number", async () => {
    fetched.length = 0;
    await C.markOwnerInbound("+15559990000");
    const r = await C.sendSMS(OWNER, "reply", { inboundReply: { from: "+15559990000" } });
    assert.equal(r.blocked, true);
    assert.ok(!fetched.some((u) => u.includes("api.twilio.com")));
  });

  test("a non-owner number is not gated", async () => {
    fetched.length = 0;
    const r = await C.sendSMS("+15557778888", "client text");
    assert.equal(r.ok, true);
  });

  test("phoning the owner is blocked with no exception", async () => {
    fetched.length = 0;
    const r = await C.placeCall(OWNER, "call");
    assert.equal(r.blocked, true);
    assert.ok(!fetched.some((u) => u.includes("api.twilio.com")));
  });
});

describe("notifyOwner (delivered through the OS)", () => {
  const sent: import("./notify").OwnerMessage[] = [];
  let osUp = true;
  before(() => {
    N._setOwnerTransport(async (m) => { if (!osUp) return false; sent.push(m); return true; });
  });
  after(() => N._setOwnerTransport(null));

  test("critical without an allowlisted kind is timely: critical to the OS with NO category, no escalation", async () => {
    sent.length = 0; fetched.length = 0;
    const r = await N.notifyOwner({ kind: "autoqa", priority: "critical", text: "finished without changing code", dedupeKey: `t:${Date.now()}` });
    assert.equal(r.sms, false);
    assert.ok(!r.escalated);
    assert.equal(r.email, true);
    assert.deepEqual([sent.length, sent[0].priority, sent[0].category], [1, "critical", undefined]);
    assert.ok(!fetched.some((u) => u.includes("api.twilio.com")));
  });

  test("critical + category but non-allowlisted kind still does not escalate", async () => {
    sent.length = 0;
    const r = await N.notifyOwner({ kind: "engine.auth", priority: "critical", emergencyCategory: "production", text: "auth lapsed", dedupeKey: `e:${Date.now()}` });
    assert.ok(!r.escalated);
    assert.equal(sent[0].category, undefined);
  });

  test("an allowlisted emergency goes to the OS as critical WITH its category, never to Twilio or a CLARA app", async () => {
    sent.length = 0; fetched.length = 0;
    const r = await N.notifyOwner({ kind: "uptime.down", priority: "critical", emergencyCategory: "production", headline: "Site down", text: "site down", dedupeKey: `u:${Date.now()}` });
    assert.equal(r.sms, false);
    assert.equal(r.escalated, true);
    assert.deepEqual([sent[0].priority, sent[0].category, sent[0].kind], ["critical", "production", "uptime.down"]);
    assert.match(sent[0].text, /^Site down/);
    assert.ok(!fetched.some((u) => u.includes("api.twilio.com") || u.includes("127.0.0.1:9")));
  });

  test("normal priority is handed to the OS as normal (held for the brief), with the structured payload", async () => {
    sent.length = 0;
    const r = await N.notifyOwner({ kind: "run.done", text: "x", headline: "Task done", summary: "We did the thing.", links: [{ label: "Pull request", url: "https://github.com/x/y/pull/1" }], dedupeKey: `n:${Date.now()}` });
    assert.equal(r.queued, true);
    assert.equal(sent[0].priority, "normal");
    assert.match(sent[0].text, /We did the thing\./);
    assert.match(sent[0].text, /github\.com\/x\/y\/pull\/1/);
  });

  test("when the OS is unreachable nothing is lost: it queues locally and the digest retries it", async () => {
    sent.length = 0; osUp = false;
    const key = `down:${Date.now()}`;
    const r = await N.notifyOwner({ kind: "uptime.down", priority: "critical", emergencyCategory: "production", text: "site down again", dedupeKey: key });
    assert.equal(r.queued, true);
    assert.ok((await N.peekQueuedNotifications()).some((i) => i.kind === "uptime.down"));
    osUp = true;
    const flushed = await N.flushDigest();
    assert.match(flushed, /handed to the OS/);
    assert.ok(sent.some((m) => m.text.includes("site down again")));
    assert.ok(!(await N.peekQueuedNotifications()).some((i) => i.text === "site down again"));
  });
});

describe("stripEmoji", () => {
  test("removes pictographs, keeps ASCII, accents and punctuation", () => {
    assert.equal(N.stripEmoji("🔔 FRIDAY digest (16) ✅ done — café, naïve; 100% ok!"), "FRIDAY digest (16) done — café, naïve; 100% ok!");
    assert.equal(N.stripEmoji("no emoji here"), "no emoji here");
  });
});
