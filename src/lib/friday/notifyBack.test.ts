import { test } from "node:test";
import assert from "node:assert/strict";
import { baseTitle, isAutoRoundTitle, runEndNotifyTarget } from "./notifyBack";

const ORIGINAL = "Fix incorrect Total Calls count on dashboard";

test("auto-QA / self-heal rounds are recognised", () => {
  assert.equal(isAutoRoundTitle(`[QA] [Fix R3] failing checks — ${ORIGINAL}`), true);
  assert.equal(isAutoRoundTitle(`[Fix R1] failing checks — ${ORIGINAL}`), true);
  assert.equal(isAutoRoundTitle(`[Fix R2] issues from QA — ${ORIGINAL}`), true);
  assert.equal(isAutoRoundTitle(ORIGINAL), false);
});

test("baseTitle recovers what the client actually asked for", () => {
  assert.equal(baseTitle(`[QA] [Fix R3] failing checks — ${ORIGINAL}`), ORIGINAL);
  assert.equal(baseTitle(`[Fix R2] issues from QA — ${ORIGINAL}`), ORIGINAL);
  assert.equal(baseTitle(ORIGINAL), ORIGINAL);
});

test("auto rounds never text anyone — not the client, not the owner", () => {
  for (const hasClientContact of [true, false]) {
    assert.equal(runEndNotifyTarget({ title: `[QA] [Fix R1] failing checks — ${ORIGINAL}`, role: "qa", hasClientContact }), "none");
    assert.equal(runEndNotifyTarget({ title: `[Fix R2] issues from QA — ${ORIGINAL}`, role: "debug", hasClientContact }), "none");
  }
});

test("a client's coding task waits for QA instead of texting 'done' at run end", () => {
  for (const role of ["dev", "debug", "architect", "devops", "designer"]) {
    assert.equal(runEndNotifyTarget({ title: ORIGINAL, role, hasClientContact: true }), "none");
  }
});

test("other client tasks text the client; no client contact texts the owner", () => {
  assert.equal(runEndNotifyTarget({ title: "Research competitor dashboards", role: "research-qa", hasClientContact: true }), "client");
  assert.equal(runEndNotifyTarget({ title: ORIGINAL, role: "debug", hasClientContact: false }), "owner");
});
