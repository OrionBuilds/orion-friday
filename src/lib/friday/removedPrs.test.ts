import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prKey, removedPrKeys, isRemovedPr } from "./removedPrs";
import { withUsSpelling, US_SPELLING_RULE } from "./usEnglish";

test("PR keys ignore case and anything after the number", () => {
  assert.equal(prKey("https://github.com/example-org/globex-fl/pull/14"), "example-org/globex-fl/pull/14");
  assert.equal(prKey("https://github.com/example-org/Globex-FL/pull/14/files"), "example-org/globex-fl/pull/14");
  assert.equal(prKey("not a pr"), null);
});

test("the owner's removed list is read, re-read when edited, and a bad file means no list", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-removed-"));
  const file = path.join(dir, "pr-removed.json");
  try {
    assert.equal((await removedPrKeys(file)).size, 0, "missing file");
    await fs.writeFile(file, JSON.stringify(["https://github.com/example-org/globex-fl/pull/14", "junk"]));
    assert.equal(await isRemovedPr("https://github.com/example-org/globex-fl/pull/14", file), true);
    assert.equal(await isRemovedPr("https://github.com/example-org/globex-fl/pull/15", file), false);
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(file, JSON.stringify(["https://github.com/example-org/globex-fl/pull/15"]));
    await fs.utimes(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(await isRemovedPr("https://github.com/example-org/globex-fl/pull/15", file), true);
    assert.equal(await isRemovedPr("https://github.com/example-org/globex-fl/pull/14", file), false);
    await fs.writeFile(file, "{not json");
    await fs.utimes(file, new Date(), new Date(Date.now() + 10000));
    assert.equal((await removedPrKeys(file)).size, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("every model call gets the US spelling rule exactly once", () => {
  assert.equal(withUsSpelling(undefined), US_SPELLING_RULE);
  const once = withUsSpelling("You are FRIDAY.");
  assert.ok(once.startsWith("You are FRIDAY.") && once.endsWith(US_SPELLING_RULE));
  assert.equal(withUsSpelling(once), once);
});
