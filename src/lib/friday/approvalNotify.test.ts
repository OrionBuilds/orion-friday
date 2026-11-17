import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalNotice } from "./approvalNotify";

test("a pending approval becomes one timely owner notice, deduped by approval id, with approve/reject options", () => {
  const n = approvalNotice({ id: "a1", action: "Deploy Acme site to production", detail: "Tier 3: touches production.", risk: "high" });
  assert.equal(n.priority, "critical");
  assert.equal(n.dedupeKey, "approval:a1");
  assert.deepEqual(n.needsDecision.options, ["approve", "reject"]);
  assert.match(n.headline, /^Approval needed: Deploy Acme/);
  assert.match(n.text, /touches production/);
});

test("the notice never tells the owner to reply to an email thread or a code (those channels are gone)", () => {
  const n = approvalNotice({ id: "a2", action: "x", detail: "y", risk: "low" });
  assert.ok(!/reply to this email|approve #|#CODE/i.test(JSON.stringify(n)));
});
