// ticketClarify.clarifySilenceAction — the 24h-nudge/72h-escalate silence timer for an outstanding
// portal clarify question (2026-09-18). Pure, so this suite never touches the network, an LLM, SMS,
// or the OS.
//
// Runs via `npm test`. The data dir is pointed at a temp dir before the (store-importing) module
// loads, so nothing here reads or writes the live FRIDAY data.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-ticketclarify-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;

type Mod = typeof import("./ticketClarify");
let T: Mod;

before(async () => {
  T = await import("./ticketClarify");
});
after(() => rmSync(TMP, { recursive: true, force: true }));

const HOUR = 3600_000;

describe("clarifySilenceAction", () => {
  test("under 24h, nothing sent yet ⇒ none", () => {
    const asked = 0;
    const now = 12 * HOUR;
    assert.equal(T.clarifySilenceAction(asked, now, null, null), "none");
  });

  test("at/past 24h, not yet nudged ⇒ nudge", () => {
    const asked = 0;
    const now = 24 * HOUR;
    assert.equal(T.clarifySilenceAction(asked, now, null, null), "nudge");
  });

  test("already nudged, under 72h ⇒ none (don't nudge twice)", () => {
    const asked = 0;
    const nudgedAt = 24 * HOUR;
    const now = 48 * HOUR;
    assert.equal(T.clarifySilenceAction(asked, now, nudgedAt, null), "none");
  });

  test("at/past 72h, not yet escalated ⇒ escalate, even if never nudged", () => {
    const asked = 0;
    const now = 72 * HOUR;
    assert.equal(T.clarifySilenceAction(asked, now, null, null), "escalate");
  });

  test("already escalated ⇒ none", () => {
    const asked = 0;
    const escalatedAt = 72 * HOUR;
    const now = 96 * HOUR;
    assert.equal(T.clarifySilenceAction(asked, now, 24 * HOUR, escalatedAt), "none");
  });
});
