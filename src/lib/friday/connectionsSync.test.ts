// connectionsSync — pure mapping between a local Project and the OS projects connection columns,
// and the last-writer-wins direction. Runs via `npm test`; the data dir is a temp dir so the
// store-importing module never touches live FRIDAY data, and nothing here calls the OS.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project } from "./types";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-connections-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;
// Pinned: otherwise the owner comes from this checkout's own origin remote and the expected URLs move with it.
process.env.GITHUB_OWNER = "example-org";

type Mod = typeof import("./connectionsSync");
let C: Mod;

before(async () => {
  C = await import("./connectionsSync");
});
after(() => rmSync(TMP, { recursive: true, force: true }));

const base: Project = {
  id: "p1", clientId: "c1", name: "Initech Box Site", status: "active" as Project["status"],
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("canonicalRepo", () => {
  test("drops .git and trailing slashes; rejects non-GitHub", () => {
    assert.equal(C.canonicalRepo("https://github.com/example-org/orion.git"), "https://github.com/example-org/orion");
    assert.equal(C.canonicalRepo("https://github.com/example-org/friday/"), "https://github.com/example-org/friday");
    assert.equal(C.canonicalRepo("https://gitlab.com/a/b"), null);
  });
});

describe("localToOs", () => {
  test("maps repos, site, Supabase ref and a Google Drive folder", () => {
    const out = C.localToOs({
      ...base,
      repoUrls: ["https://github.com/example-org/initech-box.git", "https://github.com/example-org/initech-box"],
      deployUrl: "initech.example",
      supabaseRef: "fbibbabgbialrtrkbftt",
      driveFolderId: "1LUz",
    });
    assert.deepEqual(out.repo_urls, ["https://github.com/example-org/initech-box"]);
    assert.equal(out.netlify_site_url, "https://initech.example");
    assert.equal(out.supabase_project_ref, "fbibbabgbialrtrkbftt");
    assert.equal(out.files_provider, "google");
    assert.equal(out.files_folder_id, "1LUz");
    assert.equal(out.files_folder_url, "https://drive.google.com/drive/folders/1LUz");
  });

  test("a SharePoint/OneDrive folder wins over a stale Google id; a bad Supabase ref is dropped", () => {
    const out = C.localToOs({
      ...base, driveFolderId: "stale", supabaseRef: "nope",
      filesProvider: "microsoft", filesDriveId: "b!d", filesFolderId: "01X", filesFolderName: "OneDrive / Clients", filesFolderUrl: "https://x",
    });
    assert.equal(out.files_provider, "microsoft");
    assert.equal(out.files_folder_id, "01X");
    assert.equal(out.files_drive_id, "b!d");
    assert.equal(out.supabase_project_ref, null);
  });

  test("nothing connected ⇒ every column cleared", () => {
    const out = C.localToOs(base);
    assert.deepEqual(out.repo_urls, []);
    assert.equal(out.files_provider, null);
    assert.equal(out.files_folder_id, null);
    assert.equal(out.netlify_site_url, null);
  });
});

describe("osToLocal", () => {
  test("Google folder fills driveFolderId; Microsoft leaves it unset", () => {
    const g = C.osToLocal({ repo_urls: ["https://github.com/a/b"], files_provider: "google", files_folder_id: "1G" });
    assert.equal(g.driveFolderId, "1G");
    assert.equal(g.repoUrl, "https://github.com/a/b");
    const m = C.osToLocal({ files_provider: "microsoft", files_folder_id: "01M", files_drive_id: "b!d" });
    assert.equal(m.driveFolderId, undefined);
    assert.equal(m.filesProvider, "microsoft");
    assert.equal(m.filesDriveId, "b!d");
  });

  test("empty OS row clears everything", () => {
    const e = C.osToLocal({ repo_urls: [], supabase_project_ref: null, netlify_site_url: null });
    assert.equal(e.repoUrls, undefined);
    assert.equal(e.supabaseRef, undefined);
    assert.equal(e.deployUrl, undefined);
    assert.equal(e.filesProvider, undefined);
  });
});

describe("syncDirection", () => {
  const t1 = "2026-10-28T10:00:00.000Z";
  const t2 = "2026-10-28T11:00:00.000Z";
  test("the newer stamp wins", () => {
    assert.equal(C.syncDirection({ ...base, connectionsUpdatedAt: t1 }, { connections_updated_at: t2 }), "pull");
    assert.equal(C.syncDirection({ ...base, connectionsUpdatedAt: t2 }, { connections_updated_at: t1 }), "push");
    assert.equal(C.syncDirection({ ...base, connectionsUpdatedAt: t1 }, { connections_updated_at: t1 }), "none");
  });

  test("an OS edit beats an unstamped local copy", () => {
    assert.equal(C.syncDirection({ ...base, repoUrl: "https://github.com/a/b" }, { connections_updated_at: t1 }), "pull");
  });

  test("neither stamped: seed the OS only when FRIDAY has something", () => {
    assert.equal(C.syncDirection({ ...base, repoUrl: "https://github.com/a/b" }, {}), "push");
    assert.equal(C.syncDirection(base, {}), "none");
  });
});
