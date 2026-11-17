import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The conversation-log path writes os.tool_missing events through the store — keep them out of the live data dir.
process.env.AGENTIC_OS_FRIDAY_DATA = mkdtempSync(path.join(os.tmpdir(), "friday-osclientemail-test-"));

let draftClientEmail: typeof import("./osClientEmail").draftClientEmail;
let isoWeek: typeof import("./weeklyUpdate").isoWeek;
before(async () => {
  ({ draftClientEmail } = await import("./osClientEmail"));
  ({ isoWeek } = await import("./weeklyUpdate"));
});

const ok = (payload: unknown) => async () => [{ type: "text", text: JSON.stringify(payload) }];

test("a draft goes to the OS approval queue and reports whether it was newly created", async () => {
  const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const r = await draftClientEmail(
    { contactId: "c1", subject: "This week", body: "Hi Pat — here is what happened.", externalRef: "weekly:cl1:2026-W43", summary: "Weekly update" },
    async (tool, args) => { seen.push({ tool, args }); return ok({ created: true, approval_id: "a1" })(); },
  );
  assert.deepEqual(r, { ok: true, created: true, approvalId: "a1" });
  assert.equal(seen[0].tool, "agent_draft_client_email");
  assert.equal(seen[0].args.external_ref, "weekly:cl1:2026-W43");
  const again = await draftClientEmail({ contactId: "c1", subject: "s", body: "b".repeat(20), externalRef: "x" }, ok({ created: false }));
  assert.deepEqual(again, { ok: true, created: false, approvalId: undefined });
});

test("a newly created draft is logged into OS Conversations once; a re-queue is not; a missing log tool never fails the draft", async () => {
  const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const r = await draftClientEmail(
    { contactId: "c1", subject: "Fixed", body: "Hi Pat — the issue is resolved.", externalRef: "bugfix:t1" },
    async (tool, args) => { seen.push({ tool, args }); return ok({ created: true, approval_id: "a9" })(); },
  );
  assert.equal(r.ok, true);
  const log = seen.find((s) => s.tool === "conversation_log_message");
  assert.ok(log, "conversation_log_message was called");
  assert.equal(log!.args.channel, "email");
  assert.equal(log!.args.direction, "outbound");
  assert.equal(log!.args.external_id, "friday-email:bugfix:t1");
  assert.equal("contact_id" in log!.args, false, "a non-uuid contact id is never sent as an OS id");

  const seen2: string[] = [];
  await draftClientEmail({ contactId: "c1", subject: "s", body: "b".repeat(20), externalRef: "x" }, async (tool) => { seen2.push(tool); return ok({ created: false })(); });
  assert.deepEqual(seen2, ["agent_draft_client_email"]);

  const missing = await draftClientEmail({ contactId: "c1", subject: "s", body: "b".repeat(20), externalRef: "y" }, async (tool) => {
    if (tool === "conversation_log_message") throw new Error('osmcp: tool "conversation_log_message" failed: Tool conversation_log_message not found');
    return ok({ created: true })();
  });
  assert.deepEqual(missing, { ok: true, created: true, approvalId: undefined });
});

test("OS refusals and outages come back as errors, never as success", async () => {
  const refused = await draftClientEmail({ contactId: "c", subject: "s", body: "b".repeat(20), externalRef: "x" }, async () => { throw new Error("contact has no email address"); });
  assert.deepEqual(refused, { ok: false, error: "contact has no email address" });
  const txt = await draftClientEmail({ contactId: "c", subject: "s", body: "b".repeat(20), externalRef: "x" }, async () => [{ type: "text", text: "RPC error: contact not found" }]);
  assert.equal(txt.ok, false);
  const withError = await draftClientEmail({ contactId: "c", subject: "s", body: "b".repeat(20), externalRef: "x" }, ok({ error: "nope" }));
  assert.deepEqual(withError, { ok: false, error: "nope" });
});

test("the dedupe unit is one ISO week per client", () => {
  assert.equal(isoWeek(new Date("2026-10-23T18:00:00Z")), "2026-W43");
  assert.equal(isoWeek(new Date("2026-10-19T00:00:00Z")), "2026-W43"); // Monday
  assert.equal(isoWeek(new Date("2026-10-25T23:59:00Z")), "2026-W43"); // Sunday
  assert.equal(isoWeek(new Date("2026-10-26T00:00:00Z")), "2026-W44");
  assert.equal(isoWeek(new Date("2027-01-01T12:00:00Z")), "2026-W53");
});
