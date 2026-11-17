import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalReason, riskyAction, needsApproval } from "./risk";
import { dispatchApprovalReason } from "./orchestrator";
import type { Task } from "./types";

// Retainer clients are configuration (FRIDAY_RETAINER_CLIENTS); pin a fictional one for these tests.
process.env.FRIDAY_RETAINER_CLIENTS = JSON.stringify({
  name: "Acme Capital",
  clientIds: ["81b7b4b1-5146-4543-985b-74e248a61b95"],
  projectIds: ["4e129565-8315-411c-bb54-66641a5bdf2f", "5a636592-eeb6-4a5e-88a5-a29e8d0a1d3a", "ae7fdde4-e5aa-4732-9229-c77970b085af", "36e0019f-5d88-4a4e-bd4c-f91eb2135ff1"],
  emails: ["casey@example.com"],
  domains: ["acmecapital.example"],
});

const COACH = { id: "4e129565-8315-411c-bb54-66641a5bdf2f", clientId: "81b7b4b1-5146-4543-985b-74e248a61b95" }; // ACME (retainer)
const OTHER = { id: "d411b471-1fae-4b16-926a-983164a4687a", clientId: "someone-else" };
const task = (title: string, details = "", risk: Task["risk"] = "medium") => ({ id: "t", projectId: COACH.id, title, details, risk } as unknown as Task);

test("retainer product work with delete/email/send in the title auto-proceeds", () => {
  for (const t of [
    task("Calls menu: trash-can + checkbox to delete single or multiple calls", "Soft delete (deleted_at); Zoom recordings stay untouched."),
    task("Coaching tool: Resend integration to email call summaries + PDFs to advisors", "Keys go in env config."),
    task("Send PDF of the summary to the advisor", "One advisor at a time, from the call page."),
  ]) {
    assert.equal(dispatchApprovalReason(t, COACH), null, t.title);
    assert.equal(needsApproval(t), true, `old keyword gate would have stopped: ${t.title}`);
  }
});

test("retainer tasks that do something genuinely risky still need approval", () => {
  const cases: Array<[string, string, string]> = [
    ["Clean up calls", "DROP TABLE calls; then recreate it", "destroys-production-data"],
    ["Reset scorecards", "bulk delete all scorecard rows in the production database", "destroys-production-data"],
    ["Tidy repo", "delete the repository example-org/acme-aicoach", "destroys-production-data"],
    ["Announce the new feature", "send an email to all customers on the mailing list", "mass-outbound"],
    ["Coaching newsletter", "weekly newsletter to advisors", "mass-outbound"],
    ["Rotate API keys", "rotate the keys used by the coaching tool", "security"],
    ["Give Kim admin access", "grant Kim admin access on the dashboard", "security"],
    ["Refund Eli", "issue a refund for last month", "money"],
    ["Sign the renewal", "sign the renewal agreement", "contract"],
  ];
  for (const [title, details, kind] of cases) {
    assert.equal(riskyAction(`${title}\n${details}`), kind, title);
    assert.match(dispatchApprovalReason(task(title, details), COACH) ?? "", new RegExp(kind), title);
  }
  // The task's own high/critical rating always gates, even for plain product work.
  assert.equal(dispatchApprovalReason(task("Add a dashboard filter", "", "high"), COACH), "risk high");
  assert.equal(dispatchApprovalReason(task("Add a dashboard filter", "", "critical"), COACH), "risk critical");
});

test("non-retainer clients keep the old keyword/risk gate exactly", () => {
  const t = (title: string, risk: Task["risk"] = "medium") => ({ ...task(title, "", risk), projectId: OTHER.id } as Task);
  for (const title of ["Delete calls feature", "Email summaries to advisors", "Send PDF", "Add a dashboard filter", "Deploy to production"]) {
    assert.equal(dispatchApprovalReason(t(title), OTHER) !== null, needsApproval(t(title)), title);
  }
  assert.equal(dispatchApprovalReason(t("Delete calls feature"), OTHER), "keyword/risk gate");
  assert.equal(dispatchApprovalReason(t("Add a dashboard filter"), OTHER), null);
  assert.equal(approvalReason(t("Add a dashboard filter", "high")), "keyword/risk gate");
});

test("review round 1: SQL deletes with WHERE, MFA, large audiences, split fields, planner request text", () => {
  assert.equal(riskyAction("In production, run DELETE FROM customers WHERE id = 42"), "destroys-production-data");
  assert.equal(riskyAction("Disable MFA for all users"), "security");
  assert.equal(riskyAction("Turn off two-factor login for advisors"), "security");
  assert.equal(riskyAction("Send the update to 5,000 subscribers"), "mass-outbound");
  assert.equal(riskyAction("Email the report to 1200 advisors"), "mass-outbound");
  assert.equal(riskyAction("Email the summary to 3 advisors"), null);
  // Phrases split across title and details.
  assert.equal(dispatchApprovalReason(task("Delete", "production records for March"), COACH), "retainer task, but destroys-production-data");
  assert.equal(dispatchApprovalReason(task("Send", "all customers the launch note"), COACH), "retainer task, but mass-outbound");
  assert.equal(dispatchApprovalReason(task("Rotate API", "keys for the coaching tool"), COACH), "retainer task, but security");
  // Planner tasks have only a title: the request text is scanned too.
  assert.match(dispatchApprovalReason(task("Clean up old data"), COACH, "please DROP TABLE calls on prod") ?? "", /destroys-production-data/);
  assert.equal(dispatchApprovalReason(task("Clean up old data"), COACH, "hide archived calls from the list"), null);
});

test("money and contracts gate as actions, not nouns", () => {
  assert.equal(riskyAction("Add an invoice search filter"), null);
  assert.equal(riskyAction("Show the agreement date on the client page"), null);
  assert.equal(riskyAction("Issue an invoice to ACME for September"), "money");
  assert.equal(riskyAction("Spend $500 on ads"), "money");
  assert.equal(riskyAction("Terminate the agreement with the vendor"), "contract");
  assert.equal(dispatchApprovalReason(task("Add an invoice search filter"), COACH), null);
});
