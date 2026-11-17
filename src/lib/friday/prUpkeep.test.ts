import { test } from "node:test";
import assert from "node:assert/strict";
import { isUpkeepPr, isFridayBranch } from "./prUpkeep";

test("upkeep PRs are recognised by branch or title across the repos' styles", () => {
  assert.equal(isUpkeepPr({ headRefName: "deps/weekly-2026-09-24", title: "deps: weekly patch bumps (2026-09-24)" }), true);
  assert.equal(isUpkeepPr({ headRefName: "friday/deps-weekly-2026-09-24", title: "chore(deps): weekly patch bumps" }), true);
  assert.equal(isUpkeepPr({ headRefName: "friday/build-turbopack-envguard", title: "[Deps] umbrella-api weekly patch bumps" }), true);
  assert.equal(isUpkeepPr({ headRefName: "friday/fix-r1", title: "[Fix R1] failing checks — [Deps] globex-fl weekly patch bumps" }), true);
  assert.equal(isUpkeepPr({ headRefName: "friday/landers-video-hero", title: "feat(landers): video hero" }), false);
  assert.equal(isUpkeepPr({ headRefName: "main", title: "Weekly newsletter page" }), false);
});

test("FRIDAY branches by prefix", () => {
  assert.equal(isFridayBranch("friday/x"), true);
  assert.equal(isFridayBranch("friday-work/x"), true);
  assert.equal(isFridayBranch("friday"), false);
  assert.equal(isFridayBranch("deps/weekly-2026-09-24"), true);
  assert.equal(isFridayBranch("feature/x"), false);
  assert.equal(isFridayBranch(undefined), false);
});
