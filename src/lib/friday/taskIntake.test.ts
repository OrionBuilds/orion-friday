// taskIntake.resolveClientScope — the grounded scope verdict a client ask is routed under (2026-09
// origin-aware autonomy). The OS mapping, contract-scope fetch and classifier are injected, so this
// suite never touches the network or an LLM.
//
// Runs via `npm test`. The data dir is pointed at a temp dir before the (store-importing) module
// loads, so nothing here reads or writes the live FRIDAY data.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-intake-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;

type IntakeMod = typeof import("./taskIntake");
let T: IntakeMod;

before(async () => {
  T = await import("./taskIntake");
});
after(() => rmSync(TMP, { recursive: true, force: true }));

const project = { id: "local-1" };
const ask = (scope?: "in_scope" | "new") => ({ title: "Fix the footer year", details: "It still says 2024", kind: "bug" as const, scope });

const mapped = async () => "os-1";
const unmapped = async () => null;
const withScope = async () => "deliverables: marketing site, footer, contact form";
const noScope = async () => null;

describe("resolveClientScope", () => {
  test("no OS mapping ⇒ the channel LLM's scope (fail-closed to new)", async () => {
    const calls: string[] = [];
    const classify = async () => { calls.push("classify"); return { in_scope: true, determinable: true, reason: "x" }; };
    assert.deepEqual(
      (await T.resolveClientScope({ project, request: ask("in_scope") }, { osProjectIdFor: unmapped, classify })).verdict,
      "in_scope",
    );
    assert.equal((await T.resolveClientScope({ project, request: ask("new") }, { osProjectIdFor: unmapped, classify })).verdict, "new");
    assert.equal((await T.resolveClientScope({ project, request: ask(undefined) }, { osProjectIdFor: unmapped, classify })).verdict, "new");
    assert.equal(calls.length, 0, "the contract classifier never runs without a mapping");
  });

  test("mapping lookup that throws ⇒ treated as unmapped", async () => {
    const r = await T.resolveClientScope({ project, request: ask("in_scope") }, { osProjectIdFor: async () => { throw new Error("os down"); } });
    assert.equal(r.verdict, "in_scope");
    assert.equal(r.source, "llm");
  });

  test("mapped + contract on file ⇒ the contract verdict wins over the LLM (both directions)", async () => {
    const outOfScope = await T.resolveClientScope(
      { project, request: ask("in_scope") },
      { osProjectIdFor: mapped, fetchScope: withScope, classify: async () => ({ in_scope: false, determinable: true, reason: "adds a booking system" }) },
    );
    assert.equal(outOfScope.verdict, "new");
    assert.equal(outOfScope.source, "os_contract");

    const inScope = await T.resolveClientScope(
      { project, request: ask("new") },
      { osProjectIdFor: mapped, fetchScope: withScope, classify: async () => ({ in_scope: true, determinable: true, reason: "footer is a deliverable" }) },
    );
    assert.equal(inScope.verdict, "in_scope");
    assert.equal(inScope.source, "os_contract");
  });

  test("classifier receives the ask as data, strict mode on, with the contract text", async () => {
    let seen: { item: unknown; text: string | null; strict: boolean } | null = null;
    await T.resolveClientScope(
      { project, request: ask("in_scope") },
      {
        osProjectIdFor: mapped,
        fetchScope: withScope,
        classify: async (item, text, strict) => { seen = { item, text, strict }; return { in_scope: true, determinable: true, reason: "" }; },
      },
    );
    assert.deepEqual(seen, {
      item: { title: "Fix the footer year", description: "It still says 2024", request_type: "bug" },
      text: "deliverables: marketing site, footer, contact form",
      strict: true,
    });
  });

  test("mapped + classifier not determinable ⇒ unknown", async () => {
    const r = await T.resolveClientScope(
      { project, request: ask("in_scope") },
      { osProjectIdFor: mapped, fetchScope: withScope, classify: async () => ({ in_scope: false, determinable: false, reason: "Scope classification unavailable." }) },
    );
    assert.equal(r.verdict, "unknown");
  });

  test("mapped + classifier throws ⇒ unknown", async () => {
    const r = await T.resolveClientScope(
      { project, request: ask("in_scope") },
      { osProjectIdFor: mapped, fetchScope: withScope, classify: async () => { throw new Error("llm down"); } },
    );
    assert.equal(r.verdict, "unknown");
  });

  test("mapped + scope fetch throws ⇒ unknown", async () => {
    const r = await T.resolveClientScope(
      { project, request: ask("in_scope") },
      { osProjectIdFor: mapped, fetchScope: async () => { throw new Error("os down"); } },
    );
    assert.equal(r.verdict, "unknown");
    assert.equal(r.source, "os_contract");
  });

  test("mapped but no contract scope on file ⇒ the LLM's scope (fail-closed)", async () => {
    const classify = async () => { throw new Error("must not be called"); };
    const a = await T.resolveClientScope({ project, request: ask("in_scope") }, { osProjectIdFor: mapped, fetchScope: noScope, classify });
    assert.equal(a.verdict, "in_scope");
    assert.equal(a.source, "llm");
    const b = await T.resolveClientScope({ project, request: ask(undefined) }, { osProjectIdFor: mapped, fetchScope: noScope, classify });
    assert.equal(b.verdict, "new");
  });
});

describe("mapRequestKind", () => {
  test("bug always goes to debug, regardless of hasRepo", () => {
    assert.equal(T.mapRequestKind("bug", true).assignee, "debug");
    assert.equal(T.mapRequestKind("bug", false).assignee, "debug");
  });

  test("feature/change always goes to dev", () => {
    assert.equal(T.mapRequestKind("feature").assignee, "dev");
    assert.equal(T.mapRequestKind("change", false).assignee, "dev");
  });

  test("other on a project with real code routes to dev, not pm (mAI Dashboard/Taylor incident)", () => {
    const withRepo = T.mapRequestKind("other", true);
    assert.equal(withRepo.assignee, "dev");
    assert.equal(withRepo.status, "planning");
  });

  test("other with no workspace/repo still falls back to pm", () => {
    assert.equal(T.mapRequestKind("other", false).assignee, "pm");
    assert.equal(T.mapRequestKind("other").assignee, "pm"); // hasRepo defaults to false
  });
});
