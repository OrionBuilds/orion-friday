// clientChannel.activeClarifyStreak — the clarify-loop bound (2026-09-17, Taylor incident). Pure,
// so this suite never touches the network, an LLM, or the store.
//
// Runs via `npm test`.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-clientchannel-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;

type Mod = typeof import("./clientChannel");
let T: Mod;

before(async () => {
  T = await import("./clientChannel");
});
after(() => rmSync(TMP, { recursive: true, force: true }));

describe("activeClarifyStreak", () => {
  test("no streak on record ⇒ 0", () => {
    assert.equal(T.activeClarifyStreak(undefined, undefined, Date.now()), 0);
  });

  test("streak with no timestamp ⇒ 0 (can't be dated, treated as absent)", () => {
    assert.equal(T.activeClarifyStreak(1, undefined, Date.now()), 0);
  });

  test("recent streak ⇒ the recorded count", () => {
    const now = Date.now();
    assert.equal(T.activeClarifyStreak(1, new Date(now - 5 * 60_000).toISOString(), now), 1);
  });

  test("streak older than the window ⇒ 0 (a new conversation, not a continuation)", () => {
    const now = Date.now();
    const threeHoursAgo = new Date(now - 3 * 60 * 60_000).toISOString();
    assert.equal(T.activeClarifyStreak(1, threeHoursAgo, now), 0);
  });

  test("streak right at the window boundary ⇒ still active", () => {
    const now = Date.now();
    const justUnder = new Date(now - (T.CLARIFY_STREAK_WINDOW_MS - 1000)).toISOString();
    assert.equal(T.activeClarifyStreak(1, justUnder, now), 1);
  });
});

describe("normalizeRequests", () => {
  test("well-formed request array ⇒ passed through", () => {
    const plan = { reply: "ok", intent: "request" as const, requests: [{ title: "Add a tab", kind: "feature" as const }] };
    assert.deepEqual(T.normalizeRequests(plan), plan.requests);
  });

  test("blank-titled request ⇒ dropped (Taylor incident #2, 2026-09-18)", () => {
    // The forced clarify-bound resolution can get intent:"request" back with an empty title when
    // the model can't summarize the ask — this must NOT look like a compliant request, or the
    // caller uses it instead of the guaranteed-safe raw-text fallback.
    const plan = { reply: "ok", intent: "request" as const, requests: [{ title: "", kind: "other" as const }] };
    assert.deepEqual(T.normalizeRequests(plan), []);
  });

  test("whitespace-only title ⇒ dropped", () => {
    const plan = { reply: "ok", intent: "request" as const, requests: [{ title: "   ", kind: "other" as const }] };
    assert.deepEqual(T.normalizeRequests(plan), []);
  });

  test("mixed array ⇒ only the blank one is dropped", () => {
    const good = { title: "Fix login", kind: "bug" as const };
    const blank = { title: "", kind: "other" as const };
    const plan = { reply: "ok", intent: "request" as const, requests: [good, blank] };
    assert.deepEqual(T.normalizeRequests(plan), [good]);
  });

  test("legacy single-object shape with blank summary ⇒ dropped", () => {
    const plan = { reply: "ok", intent: "request" as const, request: { summary: "  ", kind: "other" as const } };
    assert.deepEqual(T.normalizeRequests(plan), []);
  });

  test("legacy single-object shape with real summary ⇒ normalized", () => {
    const plan = { reply: "ok", intent: "request" as const, request: { summary: "Add a tab", kind: "feature" as const } };
    assert.deepEqual(T.normalizeRequests(plan), [{ title: "Add a tab", details: undefined, kind: "feature", projectName: undefined }]);
  });

  test("null plan ⇒ empty", () => {
    assert.deepEqual(T.normalizeRequests(null), []);
  });
});
