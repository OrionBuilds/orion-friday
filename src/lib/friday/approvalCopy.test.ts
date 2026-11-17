// approvalCopy — the owner never sees a code (2026-09-24): fallback copy, headline, summary and the
// plain-English question are deterministic and code-free.

import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalHeadline, approvalQuestion, approvalSummary, fallbackCopy, type ApprovalFacts } from "./approvalCopy";

const clientReq: ApprovalFacts = { kind: "client_request", clientName: "Eli Miller", requestKind: "feature", summary: "add a lead export button", projectName: "Globex", agentName: "Developer", taskTitle: "Lead export", risk: "medium" };
const internal: ApprovalFacts = { kind: "internal_task", taskTitle: "Rotate the API keys", projectName: "mAI Dashboard", agentName: "DevOps", risk: "high" };
const reply: ApprovalFacts = { kind: "email_reply", clientName: "Dana Ortiz", subject: "Timeline for phase 2", draftExcerpt: "We can have it done by Friday", projectName: "Initech Box" };

const NO_CODE = /#[0-9A-F]{3,6}\b|\bapprove\s*#|reply\s+"?approve\s+#/i;

test("fallback copy asks in plain words and never carries a code", () => {
  for (const f of [clientReq, internal, reply]) {
    const c = fallbackCopy(f);
    assert.doesNotMatch(c.sms, NO_CODE);
    assert.doesNotMatch(c.email, NO_CODE);
    assert.match(c.sms, /\?/);
    assert.match(c.email, /reply "approve" or "reject"/i);
  }
});

test("headline / summary / question are code-free and name the ask", () => {
  assert.equal(approvalHeadline(clientReq), "Eli asked for a feature on Globex: add a lead export button");
  assert.match(approvalQuestion(clientReq), /^Should I put the Developer on Eli's request on Globex\?$/);
  assert.equal(approvalHeadline(internal), 'Run "Rotate the API keys" on mAI Dashboard');
  assert.match(approvalQuestion(internal), /Should the DevOps start "Rotate the API keys" on mAI Dashboard\?/);
  assert.match(approvalHeadline(reply), /^Reply to Dana about "Timeline for phase 2"$/);
  assert.match(approvalSummary(reply), /We can have it done by Friday/);
  for (const f of [clientReq, internal, reply]) {
    assert.doesNotMatch(approvalHeadline(f), NO_CODE);
    assert.doesNotMatch(approvalSummary(f), NO_CODE);
    assert.doesNotMatch(approvalQuestion(f), NO_CODE);
  }
});
