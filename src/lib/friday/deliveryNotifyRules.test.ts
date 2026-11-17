// Audit gap 10 fixes: the work-delivered note fires on `completed` too (what the PR shepherd sets),
// exactly once per task; a portal-linked bug gets only its portal comment (no duplicate email draft);
// configurable client sign-off; conversation_log_message args.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryNotifyPlan, portalLinked } from "./deliveryNotifyRules";
import { conversationLogArgs } from "./conversationLog";
import { clientCompanyName, clientSignoff, agentAuthorName } from "./clientBrand";

const feature = { title: "Add a pricing page", status: "completed", requestKind: "feature", requesterClientId: "c1" };

test("merged work landing as `completed` fires the owner nudge + client note (was: only `delivered`)", () => {
  assert.deepEqual(deliveryNotifyPlan("in_progress", feature), { bugResolved: false, ownerNudge: true, workDelivered: true });
  assert.deepEqual(deliveryNotifyPlan("internal_review", { ...feature, status: "delivered" }), { bugResolved: false, ownerNudge: true, workDelivered: true });
});

test("completed → delivered is NOT a second event (fires once)", () => {
  assert.deepEqual(deliveryNotifyPlan("completed", { ...feature, status: "delivered" }), { bugResolved: false, ownerNudge: false, workDelivered: false });
  assert.deepEqual(deliveryNotifyPlan("in_progress", { ...feature, status: "client_review" }), { bugResolved: false, ownerNudge: false, workDelivered: false });
});

test("review-owned or portal-linked work gets no client email note", () => {
  assert.equal(deliveryNotifyPlan("in_progress", { ...feature, requestId: "req1" }).workDelivered, false);
  assert.equal(deliveryNotifyPlan("in_progress", { ...feature, details: "spec [os-cr:abc-123]" }).workDelivered, false);
  assert.equal(deliveryNotifyPlan("in_progress", { ...feature, details: "spec [os-cr:abc-123]" }).ownerNudge, true);
});

test("bugs: portal-ticket bugs rely on the portal comment only; unlinked bugs get the all-clear draft", () => {
  const bug = { title: "Fix login", status: "completed", requestKind: "bug" };
  assert.deepEqual(deliveryNotifyPlan("in_progress", { ...bug, details: "[os-ticket:t-9]" }), { bugResolved: false, ownerNudge: false, workDelivered: false });
  assert.deepEqual(deliveryNotifyPlan("in_progress", bug), { bugResolved: true, ownerNudge: false, workDelivered: false });
  assert.equal(deliveryNotifyPlan("in_progress", { title: "[Bug] header", status: "delivered" }).bugResolved, true);
  assert.equal(deliveryNotifyPlan("completed", { ...bug, status: "delivered" }).bugResolved, false, "once");
  assert.ok(portalLinked({ details: "x [os-ticket:1]" }) && !portalLinked({ details: "x" }));
});

test("client sign-off: env > OS org name > owner profile; none ⇒ plain FRIDAY", () => {
  assert.equal(clientCompanyName({ FRIDAY_CLIENT_SIGNOFF: "Acme Co" }, "Org Name"), "Acme Co");
  assert.equal(clientCompanyName({}, "Org Name"), "Org Name");
  assert.equal(clientSignoff(undefined, { FRIDAY_CLIENT_SIGNOFF: "Acme Co" }), "— Acme Co");
  assert.equal(clientSignoff("FRIDAY", { FRIDAY_CLIENT_SIGNOFF: "Acme Co" }), "— FRIDAY, Acme Co");
  assert.equal(agentAuthorName({ FRIDAY_CLIENT_SIGNOFF: "Acme Co" }), "FRIDAY (Acme Co)");
});

test("conversation_log_message args: outbound default, dedupe key, only uuid OS ids pass through", () => {
  const uuid = "6b5ca059-b4ca-4dff-a017-9a9bc4ae7d40";
  const a = conversationLogArgs({ channel: "email", body: "hi", subject: "s", externalId: "friday-email:x", contactId: uuid, projectId: "local-1" });
  assert.equal(a.direction, "outbound");
  assert.equal(a.external_id, "friday-email:x");
  assert.equal(a.contact_id, uuid);
  assert.equal("project_id" in a, false);
  assert.deepEqual(a.metadata, { agent: "friday" });
});
