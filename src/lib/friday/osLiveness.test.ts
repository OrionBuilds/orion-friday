// osLiveness — an OS auth-failure streak (refresh_token_already_used) longer than 10 minutes raises
// an alarm that does not depend on the broken OS session (2026-10-28 audit: FRIDAY was cut off for
// 2.5 days with no alarm).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-osliveness-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;

let L: typeof import("./osLiveness");
let T: typeof import("./osTool");
before(async () => { T = await import("./osTool"); L = await import("./osLiveness"); });
beforeEach(() => T._resetOsToolState());
after(() => rmSync(TMP, { recursive: true, force: true }));

const AUTH = new Error('Orion token refresh 400: {"error_code":"refresh_token_already_used"}');
const reply = (v: unknown) => [{ type: "text", text: JSON.stringify(v) }];

test("isOsAuthError classifies the 2026-10-21 failure; ordinary errors are not auth", () => {
  assert.equal(T.isOsAuthError(AUTH), true);
  assert.equal(T.isOsAuthError(new Error("osmcp: tool \"x\" failed: timeout")), false);
});

test("alarmDue only after a >10 min streak", () => {
  const now = Date.now();
  assert.equal(L.alarmDue(null, now), false);
  assert.equal(L.alarmDue({ firstAt: now - 5 * 60_000 }, now), false);
  assert.equal(L.alarmDue({ firstAt: now - 11 * 60_000 }, now), true);
});

test("a short streak reports but does not alarm; a long one writes the alarm file and notifies once; recovery clears it", async () => {
  const notified: string[] = [];
  const notify = async (i: { dedupeKey: string }) => { notified.push(i.dedupeKey); return {}; };
  const failing = { callTool: async () => { throw AUTH; } };
  const locals: string[] = [];
  const localAlert = async (title: string) => { locals.push(title); };
  const t0 = Date.now();

  const r1 = await L.checkOsAuthLiveness({ client: failing, notify, localAlert, now: t0 });
  assert.match(r1, /failing/);
  assert.equal(await L.readOsAuthAlarm(), null);

  const r2 = await L.checkOsAuthLiveness({ client: failing, notify, localAlert, now: t0 + 11 * 60_000 });
  assert.match(r2, /OS AUTH BROKEN/);
  const alarm = await L.readOsAuthAlarm();
  assert.ok(alarm);
  assert.match(alarm!.lastError, /refresh_token_already_used/);
  assert.equal(notified.length, 1);

  await L.checkOsAuthLiveness({ client: failing, notify, localAlert, now: t0 + 16 * 60_000 });
  assert.equal(notified.length, 1, "still broken ⇒ alarm stays, no second notification");
  assert.equal(locals.length, 1, "the OS-independent alert fired once, with the OS notice");

  await L.checkOsAuthLiveness({ client: failing, notify, localAlert, now: t0 + 7 * 3_600_000 });
  assert.equal(notified.length, 2, "re-alert after 6 h while still broken");
  assert.equal(locals.length, 2);

  const healthy = { callTool: async () => reply({ user_id: "u", organization_id: "o" }) };
  const r3 = await L.checkOsAuthLiveness({ client: healthy, notify, localAlert, now: t0 + 20 * 60_000 });
  assert.match(r3, /recovered/);
  assert.equal(existsSync(path.join(TMP, "os-auth-alarm.json")), false);
});

test("non-auth failures never start a streak", async () => {
  const flaky = { callTool: async () => { throw new Error("osmcp: tool \"agent_whoami\" failed: 502"); } };
  await L.checkOsAuthLiveness({ client: flaky, now: Date.now() });
  assert.equal(T.osAuthFailureState(), null);
});
