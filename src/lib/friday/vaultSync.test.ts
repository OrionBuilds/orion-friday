// vaultSync — mirrors the FRIDAY + CLARA vaults to the OS /memory module. Pure helpers, the walk,
// and the manifest → upsert → finish exchange against a fake endpoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  batchNotes, buildTitleIndex, folderOf, MAX_NOTE_BYTES, resolveLinks, sha256, shouldSkipDir,
  syncVault, titleOf, walkVault, type Post,
} from "./vaultSync";

test("dot-dirs and node_modules are skipped; titles and folders come from the path", () => {
  for (const d of [".obsidian", ".trash", ".git", "node_modules"]) assert.equal(shouldSkipDir(d), true, d);
  assert.equal(shouldSkipDir("02 Projects"), false);
  assert.equal(titleOf("02 Projects/OS/Plan.md"), "Plan");
  assert.equal(folderOf("02 Projects/OS/Plan.md"), "02 Projects");
  assert.equal(folderOf("Inbox.md"), "root");
});

test("wikilinks resolve by title (case-insensitive, first wins), by path, with alias/heading; self and unknown drop", () => {
  const paths = ["02 Projects/Plan.md", "Archive/Plan.md", "Clients/Globex.md", "Daily/2026-10-28.md"];
  const byTitle = buildTitleIndex(paths);
  const all = new Set(paths);
  const content = "[[plan]] [[Archive/Plan]] [[Globex|client]] [[Globex#Notes]] [[2026-10-28]] [[Missing]]";
  assert.deepEqual(
    resolveLinks(content, byTitle, all, "Daily/2026-10-28.md").sort(),
    ["02 Projects/Plan.md", "Archive/Plan.md", "Clients/Globex.md"].sort(),
  );
});

test("batches respect both the note count and the byte budget", () => {
  const notes = Array.from({ length: 5 }, (_, i) => ({ id: i, content: "x".repeat(10) }));
  assert.deepEqual(batchNotes(notes, 2, 1_000).map((b) => b.length), [2, 2, 1]);
  assert.deepEqual(batchNotes(notes, 100, 25).map((b) => b.length), [2, 2, 1]);
  assert.deepEqual(batchNotes([{ content: "x".repeat(50) }], 100, 10).map((b) => b.length), [1]);
});

async function makeVault(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-sync-test-"));
  await mkdir(path.join(root, "02 Projects"), { recursive: true });
  await mkdir(path.join(root, ".obsidian"), { recursive: true });
  await writeFile(path.join(root, "Inbox.md"), "see [[Plan]]");
  await writeFile(path.join(root, "02 Projects", "Plan.md"), "# Plan\nback to [[Inbox]]");
  await writeFile(path.join(root, ".obsidian", "workspace.md"), "not a note");
  await writeFile(path.join(root, "image.png"), "binary");
  await writeFile(path.join(root, "Huge.md"), "x".repeat(MAX_NOTE_BYTES + 1));
  return root;
}

test("walkVault finds notes only: no dot-dirs, no non-md, no oversize; posix relative paths", async () => {
  const root = await makeVault();
  try {
    assert.deepEqual((await walkVault(root)).map((f) => f.rel), ["02 Projects/Plan.md", "Inbox.md"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("syncVault sends a manifest, uploads only what the server needs with links, then finishes", async () => {
  const root = await makeVault();
  const calls: Record<string, unknown>[] = [];
  const post: Post = async (body) => {
    calls.push(body);
    return body.action === "manifest" ? { need: ["02 Projects/Plan.md"], removed: 1 } : {};
  };
  try {
    const r = await syncVault({ vault: "friday", root }, post);
    assert.deepEqual(r, { vault: "friday", total: 2, uploaded: 1, removed: 1 });
    assert.deepEqual(calls.map((c) => c.action), ["manifest", "upsert", "finish"]);
    const manifest = calls[0].entries as { path: string; hash: string }[];
    assert.deepEqual(manifest.map((e) => e.path), ["02 Projects/Plan.md", "Inbox.md"]);
    assert.equal(manifest[1].hash, sha256("see [[Plan]]"));
    const [note] = calls[1].notes as { path: string; folder: string; title: string; links: string[] }[];
    assert.deepEqual({ path: note.path, folder: note.folder, title: note.title, links: note.links },
      { path: "02 Projects/Plan.md", folder: "02 Projects", title: "Plan", links: ["Inbox.md"] });
    assert.equal(calls[2].error, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed upload reports the error to the OS (finish with error) and rethrows", async () => {
  const root = await makeVault();
  const calls: Record<string, unknown>[] = [];
  const post: Post = async (body) => {
    calls.push(body);
    if (body.action === "manifest") return { need: ["Inbox.md"] };
    if (body.action === "upsert") throw new Error("HTTP 500 boom");
    return {};
  };
  try {
    await assert.rejects(() => syncVault({ vault: "clara", root }, post), /boom/);
    const finish = calls.at(-1)!;
    assert.equal(finish.action, "finish");
    assert.match(String(finish.error), /boom/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("syncKey: VAULT_SYNC_KEY wins over the key file; short or missing keys count as none", async () => {
  const { syncKey } = await import("./vaultSync");
  const dir = await mkdtemp(path.join(os.tmpdir(), "vault-key-test-"));
  const file = path.join(dir, "vault-sync.key");
  try {
    const fromFile = "f".repeat(40);
    await writeFile(file, `${fromFile}\n`);
    assert.equal(syncKey({}, file), fromFile);
    assert.equal(syncKey({ VAULT_SYNC_KEY: "e".repeat(40) }, file), "e".repeat(40));
    assert.equal(syncKey({ VAULT_SYNC_KEY: "short" }, path.join(dir, "missing.key")), null);
    await writeFile(file, "short");
    assert.equal(syncKey({}, file), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runVaultSync skips cleanly when disabled or when there is no key", async () => {
  const { runVaultSync } = await import("./vaultSync");
  assert.equal(await runVaultSync({ FRIDAY_VAULT_SYNC: "off" }), "vault-sync off");
  const missing = path.join(os.tmpdir(), "definitely-missing-vault-sync.key");
  assert.match(await runVaultSync({}, missing), /no sync key/);
});
