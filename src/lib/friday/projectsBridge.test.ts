// projectsBridge — the pure derivations that decide what the OS Engineering pipeline shows for a
// FRIDAY project (stage, status, progress, risk). The store/network wiring in projectsBridge.ts
// is exercised by agent-core's projectsSync tests; this suite pins the board → stage mapping.
//
// Runs via `npm test` (node's built-in runner, same harness as golden.test.ts).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  engineeringStage, toOsEngineeringStage, OS_ENGINEERING_STAGES, osProjectStatus, progressPercent, projectRisk, engineeringMilestone, coarseStatus,
} from "./projectStage";
import type { TaskStatus, Risk } from "./types";

const t = (status: TaskStatus, title = "Do a thing", risk: Risk = "low") => ({ title, status, risk });
const active = { status: "active" as const };

describe("osProjectStatus", () => {
  test("maps every local ProjectStatus onto an OS status", () => {
    assert.equal(osProjectStatus("active"), "active");
    assert.equal(osProjectStatus("paused"), "on_hold");
    assert.equal(osProjectStatus("done"), "completed");
    assert.equal(osProjectStatus("archived"), "completed");
  });
});

describe("engineeringStage", () => {
  test("project status wins: paused → On Hold, done/archived → Completed", () => {
    assert.equal(engineeringStage({ status: "paused" }, [t("in_progress")]), "On Hold");
    assert.equal(engineeringStage({ status: "done" }, [t("in_progress")]), "Completed");
    assert.equal(engineeringStage({ status: "archived" }, []), "Completed");
  });

  test("no scoped tasks (none, or chores only) → Kickoff", () => {
    assert.equal(engineeringStage(active, []), "Kickoff");
    assert.equal(engineeringStage(active, [t("in_progress", "[Deps] weekly bump"), t("planning", "Site health check")]), "Kickoff");
  });

  test("all scoped closed → Delivered / Finalization / Maintenance", () => {
    assert.equal(engineeringStage(active, [t("delivered"), t("delivered")]), "Delivered");
    assert.equal(engineeringStage(active, [t("delivered"), t("completed")]), "Finalization");
    // Open recurring upkeep (even a chore) keeps a delivered site in Maintenance / Support.
    assert.equal(engineeringStage(active, [t("delivered"), t("maintenance", "[Deps] weekly bump")]), "Maintenance / Support");
  });

  test("all open work parked → Blocked > Waiting on Client > On Hold", () => {
    assert.equal(engineeringStage(active, [t("delivered"), t("on_hold"), t("blocked"), t("waiting_on_client")]), "Blocked");
    assert.equal(engineeringStage(active, [t("on_hold"), t("waiting_on_client")]), "Waiting on Client");
    assert.equal(engineeringStage(active, [t("on_hold")]), "On Hold");
  });

  test("otherwise the most-advanced open, moving task decides (holding tasks ignored)", () => {
    assert.equal(engineeringStage(active, [t("planning")]), "Planning");
    assert.equal(engineeringStage(active, [t("planning"), t("in_progress")]), "In Progress");
    assert.equal(engineeringStage(active, [t("in_progress"), t("blocked"), t("qa_testing")]), "QA / Testing");
    assert.equal(engineeringStage(active, [t("internal_review"), t("client_review")]), "Client Review");
    assert.equal(engineeringStage(active, [t("in_progress"), t("bug_fixes")]), "Revisions");
    assert.equal(engineeringStage(active, [t("in_progress"), t("revisions")]), "Revisions");
    assert.equal(engineeringStage(active, [t("in_progress"), t("supporting")]), "Maintenance / Support");
    // Closed tasks never pull the stage forward on their own.
    assert.equal(engineeringStage(active, [t("in_progress"), t("delivered")]), "In Progress");
    // Chores don't decide the stage either.
    assert.equal(engineeringStage(active, [t("planning"), t("client_review", "[Deps] bump")]), "Planning");
  });
});

describe("stats", () => {
  test("progressPercent excludes chores + planning backlog and is undefined when nothing is in flight", () => {
    assert.equal(progressPercent([]), undefined);
    assert.equal(progressPercent([t("planning")]), undefined);
    assert.equal(progressPercent([t("in_progress"), t("completed"), t("delivered"), t("planning")]), 67);
    assert.equal(progressPercent([t("delivered"), t("in_progress", "[Deps] bump")]), 100);
  });

  test("projectRisk: critical > blocked/high/escalation > max open risk > low", () => {
    assert.equal(projectRisk([], false), "low");
    assert.equal(projectRisk([t("in_progress", "x", "medium")], false), "medium");
    assert.equal(projectRisk([t("blocked")], false), "high");
    assert.equal(projectRisk([t("in_progress", "x", "high")], false), "high");
    assert.equal(projectRisk([t("in_progress")], true), "high");
    assert.equal(projectRisk([t("in_progress", "x", "critical"), t("blocked")], true), "critical");
    // Closed critical work does not count.
    assert.equal(projectRisk([t("delivered", "x", "critical")], false), "low");
  });

  test("coarseStatus folds 14 stages into the OS's 4", () => {
    assert.equal(coarseStatus("planning"), "todo");
    assert.equal(coarseStatus("blocked"), "todo");
    assert.equal(coarseStatus("in_progress"), "in_progress");
    assert.equal(coarseStatus("waiting_on_client"), "in_progress");
    assert.equal(coarseStatus("qa_testing"), "in_review");
    assert.equal(coarseStatus("delivered"), "completed");
  });
});

describe("engineeringMilestone", () => {
  test("only client-meaningful stages get a portal card", () => {
    assert.equal(engineeringMilestone("In Progress", "QA / Testing"), null);
    assert.equal(engineeringMilestone(null, "Kickoff"), null);
    assert.deepEqual(engineeringMilestone("QA / Testing", "Client Review"), {
      title: "Moved to Client Review", detail: "This project is ready for your review.",
    });
    for (const to of ["Delivered", "Completed", "Maintenance / Support"]) {
      assert.ok(engineeringMilestone("Client Review", to)?.title, to);
    }
  });
});

describe("toOsEngineeringStage", () => {
  test("every name engineeringStage can produce lands on a live OS Engineering stage", () => {
    for (const name of ["Planning", "Kickoff", "In Progress", "Internal Review", "QA / Testing", "Client Review", "Revisions",
      "Maintenance / Support", "Finalization", "Delivered", "Completed", "On Hold", "Blocked", "Waiting on Client", "Something new"]) {
      assert.ok((OS_ENGINEERING_STAGES as readonly string[]).includes(toOsEngineeringStage(name)), name);
    }
  });
  test("the two live mismatches map as intended, and holding states never claim Client Review", () => {
    assert.equal(toOsEngineeringStage("Internal Review"), "QA / Testing");
    assert.equal(toOsEngineeringStage("Revisions"), "In Progress");
    assert.equal(toOsEngineeringStage("Waiting on Client"), "In Progress");
    assert.equal(toOsEngineeringStage("Completed"), "Delivered");
    assert.equal(toOsEngineeringStage("qa / testing"), "QA / Testing");
  });
});

test("OS stage mapping ignores case for local-only stages", () => {
  assert.equal(toOsEngineeringStage("internal review"), "QA / Testing");
  assert.equal(toOsEngineeringStage("REVISIONS"), "In Progress");
  assert.equal(toOsEngineeringStage(" completed "), "Delivered");
});
