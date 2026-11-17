import { test } from "node:test";
import assert from "node:assert/strict";
import { retainerFor, isRetainer, retainerReason, retainerForIntake } from "./retainer";
import { decideAutonomy } from "./authority";

// Retainer clients are configuration (FRIDAY_RETAINER_CLIENTS); pin a fictional one for these tests.
process.env.FRIDAY_RETAINER_CLIENTS = JSON.stringify({
  name: "Acme Capital",
  clientIds: ["81b7b4b1-5146-4543-985b-74e248a61b95"],
  projectIds: ["4e129565-8315-411c-bb54-66641a5bdf2f", "5a636592-eeb6-4a5e-88a5-a29e8d0a1d3a", "ae7fdde4-e5aa-4732-9229-c77970b085af", "36e0019f-5d88-4a4e-bd4c-f91eb2135ff1"],
  emails: ["casey@example.com"],
  domains: ["acmecapital.example"],
});

test("Acme Capital contacts, domain, client and both projects are retainer", () => {
  for (const email of ["casey@example.com", "ElI@acmecapital.example", "Tess Example <tess@acmecapital.example>", "kim@acmecapital.example"]) {
    assert.equal(retainerFor({ email })?.name, "Acme Capital", email);
  }
  assert.ok(isRetainer({ clientId: "81b7b4b1-5146-4543-985b-74e248a61b95" }));
  assert.ok(isRetainer({ projectId: "4e129565-8315-411c-bb54-66641a5bdf2f" })); // AI Coach Tool, local
  assert.ok(isRetainer({ osProjectId: "36e0019f-5d88-4a4e-bd4c-f91eb2135ff1" })); // Retirement Planner, OS
});

test("other clients, look-alike domains and junk are not retainer", () => {
  assert.equal(isRetainer({ email: "info@initech.example" }), false);
  assert.equal(isRetainer({ email: "someone@acmecapital.example.evil.io" }), false);
  assert.equal(isRetainer({ email: "casey@example.co" }), false);
  assert.equal(isRetainer({ email: "not an email" }), false);
  assert.equal(isRetainer({}), false);
  assert.equal(isRetainer({ projectId: "d411b471-1fae-4b16-926a-983164a4687a" }), false);
});

test("FRIDAY_RETAINER_CLIENTS defines clients without a deploy; bad JSON is ignored", () => {
  const raw = JSON.stringify({ name: "Acme", domains: ["acme.test"] });
  assert.equal(retainerFor({ email: "bob@acme.test" }, raw)?.name, "Acme");
  assert.equal(retainerFor({ email: "bob@acme.test" }, "{not json"), null);
  assert.equal(retainerFor({ email: "tess@acmecapital.example" }, "{not json"), null, "no built-in retainer clients");
});

test("decideAutonomy: a retainer ask runs without the scope gate, but money/contract/critical still stop", () => {
  const base = { origin: "client" as const, actionClass: "task_dispatch" as const, risk: "medium" as const };
  assert.equal(decideAutonomy({ ...base, scope: "new", text: "Add a delete-call checkbox" }).tier, 3);
  const r = decideAutonomy({ ...base, scope: "unknown", text: "Add a delete-call checkbox", retainer: true });
  assert.equal(r.tier, 1);
  assert.match(r.reason, /retainer/);
  assert.equal(decideAutonomy({ ...base, retainer: true, text: "Please issue us a $500 refund" }).tier, 3);
  assert.equal(decideAutonomy({ ...base, retainer: true, touchesContract: true, text: "x" }).tier, 3);
  assert.equal(decideAutonomy({ ...base, risk: "critical", retainer: true, text: "drop the production database" }).tier, 3);
  assert.match(retainerReason({ name: "Acme Capital" }), /owner rule 2026-09-29/);
});

test("malformed FRIDAY_RETAINER_CLIENTS entries are dropped, never thrown on", () => {
  const raw = JSON.stringify([
    { name: "Bad1", emails: "a@b.test" },
    { name: "Bad2", domains: [1] },
    { name: "Good", domains: ["good.test"] },
  ]);
  assert.doesNotThrow(() => retainerFor({ email: "x@b.test" }, raw));
  assert.equal(retainerFor({ email: "x@b.test" }, raw), null);
  assert.equal(retainerFor({ email: "x@good.test" }, raw)?.name, "Good");
});

test("retainerForIntake trusts only what the channel can vouch for", () => {
  const coach = "4e129565-8315-411c-bb54-66641a5bdf2f", other = "d411b471-1fae-4b16-926a-983164a4687a";
  // Portal CR routed into the pipeline: project decides, the typed-in email never does.
  assert.equal(retainerForIntake({ channel: "os_ticket", clientId: "x", projectId: coach })?.name, "Acme Capital");
  assert.equal(retainerForIntake({ channel: "os_ticket", clientId: "x", projectId: other, email: "eli@acmecapital.example" }), null);
  // A portal item marked verified still matches by project only.
  assert.equal(retainerForIntake({ channel: "os_ticket", senderVerified: true, clientId: "81b7b4b1-5146-4543-985b-74e248a61b95", projectId: other, email: "eli@acmecapital.example" }), null);
  // Unverified email: nothing, even for an ACME project.
  assert.equal(retainerForIntake({ channel: "email", senderVerified: false, clientId: "x", projectId: coach, email: "eli@acmecapital.example" }), null);
  // Verified email: domain match works.
  assert.equal(retainerForIntake({ channel: "email", senderVerified: true, clientId: "x", projectId: other, email: "eli@acmecapital.example" })?.name, "Acme Capital");
});
