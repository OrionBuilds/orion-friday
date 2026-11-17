// wormScan — one fixture per worm signature, plus the negatives that must stay quiet (a real WOFF2
// font, a long line in a lockfile, an ordinary build config). Fixtures build the payload markers from
// pieces so this file never contains them literally (the repo's worm-sentinel CI greps for them).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { scanFile, scanEntries, scanAgentOutput, describeHits, scanDir, scanGitRef, MARKERS, isStructuralPath } from "./wormScan";

const b = (s: string) => Buffer.from(s, "utf8");
const MARK = MARKERS[0];
const PAYLOAD = `${MARK}'9-7829-2';var _0x1a2b=_0x3c4d;(function(_0x5e6f){})();`;
const REAL_WOFF2 = Buffer.concat([Buffer.from("wOF2", "latin1"), Buffer.alloc(60, 1)]);
const CLEAN_POSTCSS = 'const config = {\n  plugins: {\n    "@tailwindcss/postcss": {},\n  },\n};\n\nexport default config;\n';

test("the payload marker is found in any file", () => {
  const hits = scanFile("src/app/page.tsx", b(`export default function P() {}\n${PAYLOAD}`));
  assert.equal(hits[0]?.signature, "payload-marker");
  assert.equal(scanFile("x.js", b(`${MARKERS[1]}7829-2";`))[0]?.signature, "payload-marker");
});

test("the repos' own worm-sentinel workflow (which names the markers) is not a hit", () => {
  assert.deepEqual(scanFile(".github/workflows/worm-sentinel.yml", b(`grep -e "${MARKERS[0]}" -e "${MARKERS[2]}"`)), []);
});

test("code hidden after a long run of spaces in a build config", () => {
  const infected = CLEAN_POSTCSS.replace("export default config;", `export default config;${" ".repeat(160)}var x=1;`);
  const sigs = scanFile("postcss.config.mjs", b(infected)).map((h) => h.signature);
  assert.ok(sigs.includes("config-hidden-code"));
});

test("a >1000-char line in a build config", () => {
  const sigs = scanFile("apps/web/tailwind.config.js", b(`module.exports = {};\nvar a="${"x".repeat(1200)}";\n`)).map((h) => h.signature);
  assert.deepEqual(sigs, ["config-long-line"]);
});

test("a clean build config is quiet", () => {
  assert.deepEqual(scanFile("postcss.config.mjs", b(CLEAN_POSTCSS)), []);
  assert.deepEqual(scanFile("next.config.ts", b("const nextConfig = { reactStrictMode: true };\nexport default nextConfig;\n")), []);
});

test("a normal long line in a lockfile is NOT a hit (not a build config)", () => {
  const lock = JSON.stringify({ packages: { "": { dependencies: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`pkg-${i}`, "^1.0.0"])) } } });
  assert.ok(lock.length > 1000);
  assert.deepEqual(scanFile("package-lock.json", b(lock)), []);
});

test("a fake font (JavaScript named fa-solid-900.woff2) is a hit; a real WOFF2 is not", () => {
  assert.equal(scanFile("src/app/api/x/public/fonts/fa-solid-900.woff2", b(PAYLOAD)).some((h) => h.signature === "fake-font"), true);
  assert.deepEqual(scanFile("src/app/api/x/public/fonts/fa-regular-400.woff2", REAL_WOFF2), []);
  // Fonts not in the worm's naming scheme are left alone even if odd.
  assert.deepEqual(scanFile("public/fonts/inter.woff2", b("not a font")), []);
});

test("a VS Code folderOpen launcher and auto-task settings", () => {
  const tasks = JSON.stringify({ version: "2.0.0", tasks: [{ label: "eslint-check", type: "shell", command: "node ./x.woff2", runOptions: { runOn: "folderOpen" } }] }, null, 2);
  assert.deepEqual(scanFile(".vscode/tasks.json", b(tasks)).map((h) => h.signature), ["folder-open-launcher"]);
  const settings = '{\n  "task.allowAutomaticTasks": true,\n  "terminal.integrated.hideOnStartup": "always"\n}';
  assert.deepEqual(scanFile(".vscode/settings.json", b(settings)).map((h) => h.signature), ["auto-tasks"]);
  assert.deepEqual(scanFile(".vscode/settings.json", b('{ "task.allowAutomaticTasks": "on" }')).map((h) => h.signature), ["auto-tasks"]);
  assert.deepEqual(scanFile(".vscode/settings.json", b('{ "editor.formatOnSave": true }')), []);
  // Only VS Code config files: the same text in a doc is not a launcher.
  assert.deepEqual(scanFile("docs/notes.md", b('"runOn": "folderOpen"')), []);
});

test("a .gitignore that hides config.bat", () => {
  assert.deepEqual(scanFile(".gitignore", b("node_modules/\n.next/\nconfig.bat\n")).map((h) => h.signature), ["config-bat-ignore"]);
  assert.deepEqual(scanFile("apps/web/.gitignore", b("/config.bat\r\n")).map((h) => h.signature), ["config-bat-ignore"]);
  assert.deepEqual(scanFile(".gitignore", b("node_modules/\n.env\n.env.*\n")), []);
});

test("an agent's MALWARE SUSPECTED report is a hit; ordinary output is not", () => {
  const hits = scanAgentOutput("Looked at the repo.\nMALWARE SUSPECTED: postcss.config.mjs has code after 200 spaces\nStopping.");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].signature, "agent-reported");
  assert.match(hits[0].detail, /postcss\.config\.mjs/);
  assert.deepEqual(scanAgentOutput("All checks pass. PR: https://github.com/o/r/pull/1"), []);
  // Only the explicit stop-and-report line counts — not a mention of the phrase mid-sentence.
  assert.deepEqual(scanAgentOutput('Added a test asserting the scanner flags "MALWARE SUSPECTED: x" lines.'), []);
  assert.equal(scanAgentOutput("- **MALWARE SUSPECTED:** .vscode/tasks.json runs on folder open")[0]?.signature, "agent-reported");
  assert.deepEqual(scanAgentOutput(undefined), []);
});

test("scanEntries aggregates, describeHits is plain English and capped", () => {
  const hits = scanEntries([
    { path: ".gitignore", content: b("config.bat\n") },
    { path: "a.js", content: b(PAYLOAD) },
  ]);
  assert.equal(hits.length, 2);
  const text = describeHits(Array.from({ length: 10 }, (_, i) => ({ file: `f${i}`, signature: "payload-marker" as const, detail: "x" })), 3);
  assert.match(text, /- f0: x/);
  assert.match(text, /…and 7 more/);
});

test("isStructuralPath picks the files whose content matters", () => {
  assert.ok(isStructuralPath(".vscode/tasks.json"));
  assert.ok(isStructuralPath("postcss.config.mjs"));
  assert.ok(isStructuralPath("x/public/fonts/fa-brands-400.woff2"));
  assert.ok(isStructuralPath(".gitignore"));
  assert.ok(!isStructuralPath("src/index.ts"));
});

function tmpRepo(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wormscan-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com"); g("config", "user.name", "t");
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
  g("add", "-A"); g("commit", "-q", "-m", "init");
  return dir;
}

test("scanDir finds hits in a checkout (tracked + untracked), skips node_modules, and is clean on a clean repo", async () => {
  const clean = tmpRepo({ "postcss.config.mjs": CLEAN_POSTCSS, "public/fonts/fa-solid-900.woff2": REAL_WOFF2 });
  assert.deepEqual((await scanDir(clean)).flatMap((r) => r.hits), []);

  const dirty = tmpRepo({ "postcss.config.mjs": CLEAN_POSTCSS + " ".repeat(200) + PAYLOAD });
  writeFileSync(path.join(dirty, ".gitignore"), "node_modules/\nconfig.bat\n"); // untracked, not ignored
  mkdirSync(path.join(dirty, "node_modules", "x"), { recursive: true });
  writeFileSync(path.join(dirty, "node_modules", "x", "index.js"), PAYLOAD); // ignored + skipped
  const hits = (await scanDir(dirty)).flatMap((r) => r.hits);
  const files = new Set(hits.map((h) => h.file));
  assert.ok(files.has("postcss.config.mjs"));
  assert.ok(files.has(".gitignore"));
  assert.ok(![...files].some((f) => f.includes("node_modules")));
});

test("scanDir on a folder of clones scans each repo", async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "wormscan-multi-"));
  const a = tmpRepo({ "x.js": "ok\n" });
  const bRepo = tmpRepo({ ".vscode/tasks.json": '{"tasks":[{"runOptions":{"runOn":"folderOpen"}}]}' });
  execFileSync("mv", [a, path.join(parent, "a")]);
  execFileSync("mv", [bRepo, path.join(parent, "b")]);
  const res = await scanDir(parent);
  assert.equal(res.length, 2);
  assert.deepEqual(res.find((r) => r.root.endsWith("/b"))?.hits.map((h) => h.signature), ["folder-open-launcher"]);
  assert.deepEqual(res.find((r) => r.root.endsWith("/a"))?.hits, []);
});

test("scanGitRef scans a ref without checking it out", async () => {
  const dir = tmpRepo({ "README.md": "hi\n" });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("checkout", "-q", "-b", "infected");
  mkdirSync(path.join(dir, "src/app/public/fonts"), { recursive: true });
  writeFileSync(path.join(dir, "src/app/public/fonts/fa-solid-900.woff2"), PAYLOAD);
  writeFileSync(path.join(dir, ".gitignore"), "config.bat\n");
  mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github/workflows/worm-sentinel.yml"), `grep -e "${MARK}"`);
  g("add", "-A"); g("commit", "-q", "-m", "x");
  g("checkout", "-q", "main");
  assert.deepEqual(await scanGitRef(dir, "main"), []);
  const sigs = (await scanGitRef(dir, "infected")).map((h) => `${h.file}:${h.signature}`).sort();
  assert.deepEqual(sigs, [
    ".gitignore:config-bat-ignore",
    "src/app/public/fonts/fa-solid-900.woff2:fake-font",
    "src/app/public/fonts/fa-solid-900.woff2:payload-marker",
  ]);
});

test("scanGitRef on a ref that doesn't exist throws (a failed scan is never 'clean')", async () => {
  const dir = tmpRepo({ "README.md": "hi\n" });
  await assert.rejects(scanGitRef(dir, "no-such-ref"));
});
