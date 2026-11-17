// msProjectFiles / driveDeliverables Microsoft path — pure helpers only (no network, no OS).
// Runs via `npm test`; the data dir is a temp dir so store-importing modules never touch live data.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project } from "./types";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-msfiles-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;

let M: typeof import("./msProjectFiles");
let D: typeof import("./driveDeliverables");
before(async () => {
  M = await import("./msProjectFiles");
  D = await import("./driveDeliverables");
});
after(() => rmSync(TMP, { recursive: true, force: true }));

describe("officeSafeName", () => {
  test("replaces characters SharePoint refuses and trims dots/spaces", () => {
    assert.equal(M.officeSafeName('2026-10-29 Fix: login/signup "bug"? — QA.md'), "2026-10-29 Fix- login-signup -bug- — QA.md");
    assert.equal(M.officeSafeName("  report.  "), "report");
    assert.equal(M.officeSafeName("???"), "-");
    assert.equal(M.officeSafeName(""), "file");
  });

  test("caps the length", () => {
    assert.equal(M.officeSafeName("x".repeat(300)).length, 200);
  });
});

describe("msFolderConfigured", () => {
  const base = { id: "p", clientId: "c", name: "P", status: "active", createdAt: "", updatedAt: "" } as unknown as Project;
  test("only a Microsoft provider with a folder id counts", () => {
    assert.equal(M.msFolderConfigured({ ...base, filesProvider: "microsoft", filesFolderId: "01X" }), true);
    assert.equal(M.msFolderConfigured({ ...base, filesProvider: "microsoft" }), false);
    assert.equal(M.msFolderConfigured({ ...base, filesProvider: "google", filesFolderId: "1G" }), false);
    assert.equal(M.msFolderConfigured(null), false);
  });
});

describe("msExtensionFor", () => {
  test("PDF, Markdown and CSV go up as-is; anything else is skipped", () => {
    assert.equal(D.msExtensionFor({ path: "/r/report.pdf", kind: "pdf" } as never), ".pdf");
    assert.equal(D.msExtensionFor({ path: "/r/summary.md", kind: "summary" } as never), ".md");
    assert.equal(D.msExtensionFor({ path: "/r/data.csv", kind: "file" } as never), ".csv");
    assert.equal(D.msExtensionFor({ path: "/r/image.png", kind: "file" } as never), null);
  });
});
