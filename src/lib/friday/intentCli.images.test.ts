import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { imageFiles, imageCapableEngine } from "./intentCli";
import { claudeImageArgs } from "./engines";

test("owner images become private temp files for the CLI engines, removed after the call", async () => {
  const png = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");
  const files = await imageFiles([
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }, { type: "text", text: "what's this?" }] },
    { role: "assistant", content: [{ type: "text", text: "looking" }] },
  ]);
  assert.equal(files.paths.length, 1);
  assert.match(files.paths[0], /friday-intent-img-.*\.png$/);
  assert.deepEqual(readFileSync(files.paths[0]), Buffer.from(png, "base64"));
  await files.cleanup();
  assert.equal(existsSync(path.dirname(files.paths[0])), false);
  assert.deepEqual((await imageFiles([{ role: "user", content: "no images" }])).paths, []);
});

test("Claude gets --add-dir in attached form so the prompt is never swallowed, plus a Read note", () => {
  const a = claudeImageArgs(["/tmp/x/a.png", "/tmp/x/b.jpg"]);
  assert.deepEqual(a.args, ["--add-dir=/tmp/x"]);
  assert.match(a.note, /Read tool/);
  assert.match(a.note, /\/tmp\/x\/b\.jpg/);
  assert.deepEqual(claudeImageArgs(undefined), { args: [], note: "" });
});

test("image turns only run on an engine that can see images", () => {
  assert.equal(imageCapableEngine("codex"), "codex");
  assert.equal(imageCapableEngine("claude"), "claude");
  for (const e of ["lmstudio", "hermes", "antigravity"] as const) assert.equal(imageCapableEngine(e), "codex", e);
});
