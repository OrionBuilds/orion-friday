// siteTargets — monitor targets come from OS projects.netlify_site_url, local deployUrl only as a fallback,
// and an empty list is an error (2026-10-28 audit gap 8: three monitors "probed 0 sites" for weeks).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-sitetargets-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;

let S: typeof import("./siteTargets");
before(async () => { S = await import("./siteTargets"); });
after(() => rmSync(TMP, { recursive: true, force: true }));

const reply = (v: unknown) => [{ type: "text", text: JSON.stringify(v) }];

test("normaliseSiteUrl: bare host ⇒ https; junk ⇒ null", () => {
  assert.equal(S.normaliseSiteUrl("pest-example.com"), "https://pest-example.com");
  assert.equal(S.normaliseSiteUrl(" https://a.com/ "), "https://a.com");
  assert.equal(S.normaliseSiteUrl(""), null);
  assert.equal(S.normaliseSiteUrl(null), null);
});

test("mergeSiteTargets: OS netlify_site_url wins, local deployUrl only fills gaps, inactive + duplicate URLs skipped", () => {
  const r = S.mergeSiteTargets(
    [
      { id: "os1", name: "Globex", status: "active", netlify_site_url: "globex.example" },
      { id: "os2", name: "Old", status: "completed", netlify_site_url: "old.com" },
      { id: "os3", name: "NoUrl", status: "active", netlify_site_url: null },
      { id: "os4", name: "Dup", status: "active", netlify_site_url: "https://globex.example" },
    ],
    new Map([["os1", "loc1"]]),
    [
      { id: "loc1", name: "Globex local", status: "active", deployUrl: "https://stale.netlify.app" }, // covered by OS
      { id: "loc2", name: "Initech", status: "active", deployUrl: "initech.example" },
      { id: "loc3", name: "Archived", status: "archived", deployUrl: "x.com" },
    ],
  );
  assert.deepEqual(r.targets.map((t) => [t.key, t.url, t.source]), [
    ["loc1", "https://globex.example", "os"],
    ["loc2", "https://initech.example", "local"],
  ]);
  assert.equal(r.fromOs, 1);
  assert.equal(r.fromLocal, 1);
});

test("resolveSiteTargets reads projects_list + project_agent_meta through the injected client", async () => {
  const calls: string[] = [];
  const client = {
    callTool: async (name: string) => {
      calls.push(name);
      if (name === "projects_list") return reply([{ id: "os9", name: "Hooli", status: "active", netlify_site_url: "hooli-paving.example" }]);
      if (name === "project_agent_meta_get") return reply([]);
      return reply([]);
    },
  };
  const r = await S.resolveSiteTargets({ client });
  assert.deepEqual(r.targets.map((t) => [t.key, t.url]), [["os:os9", "https://hooli-paving.example"]]);
  assert.deepEqual(calls, ["projects_list", "project_agent_meta_get"]);
});

test("OS read failure falls back to local, records osError, and zero targets yields a clear error", async () => {
  const client = { callTool: async () => { throw new Error("osmcp: tool \"projects_list\" failed: column netlify_site_url does not exist"); } };
  const r = await S.resolveSiteTargets({ client });
  assert.equal(r.targets.length, 0);
  assert.match(r.osError ?? "", /netlify_site_url/);
  const e = S.noSitesError("website_system_monitoring", r);
  assert.match(e.message, /0 sites to probe/);
  assert.match(e.message, /OS read failed/);
});
