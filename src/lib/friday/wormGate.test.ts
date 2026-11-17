// wormGate — the generated hooks and shims, exercised for real: an infected commit, push or npm call is
// refused with MALWARE SUSPECTED; the same commands on a clean checkout pass through untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ensureWormGate, wormGateEnv, GATED_TOOLS } from "./wormGate";
import { MARKERS } from "./wormScan";

const gateDir = mkdtempSync(path.join(os.tmpdir(), "wormgate-"));
const PAYLOAD = `${MARKERS[0]}'x';`;

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wormgate-repo-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.com"); g("config", "user.name", "t");
  g("commit", "-q", "--allow-empty", "-m", "root");
  for (const [f, c] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), c); }
  return dir;
}

function envFor(): NodeJS.ProcessEnv {
  return { ...process.env, ...wormGateEnv(gateDir, process.env.PATH ?? "") };
}
const sh = (cmd: string, args: string[], cwd: string) => spawnSync(cmd, args, { cwd, env: envFor(), encoding: "utf8" });

test("ensureWormGate writes executable scan script, hooks and a shim per gated tool", async () => {
  await ensureWormGate(gateDir);
  for (const f of ["scan.sh", "hooks/pre-commit", "hooks/pre-push", ...GATED_TOOLS.map((t) => `bin/${t}`)]) {
    const st = spawnSync("test", ["-x", path.join(gateDir, f)]);
    assert.equal(st.status, 0, `${f} is executable`);
  }
  const env = wormGateEnv(gateDir, "/usr/bin");
  assert.equal(env.GIT_CONFIG_KEY_0, "core.hooksPath");
  assert.equal(env.GIT_CONFIG_VALUE_0, path.join(gateDir, "hooks"));
  assert.equal(env.PATH, `${path.join(gateDir, "bin")}:/usr/bin`);
});

test("git commit of an infected tree is refused; a clean one goes through", async () => {
  await ensureWormGate(gateDir);
  const dirty = repo({ "postcss.config.mjs": `export default {};${" ".repeat(10)}${PAYLOAD}` });
  sh("git", ["add", "-A"], dirty);
  const r = sh("git", ["commit", "-q", "-m", "x"], dirty);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MALWARE SUSPECTED: payload marker/);

  const clean = repo({ "a.txt": "ok\n" });
  sh("git", ["add", "-A"], clean);
  assert.equal(sh("git", ["commit", "-q", "-m", "x"], clean).status, 0);
});

test("git push of an infected commit is refused by pre-push (even when committed without the gate)", async () => {
  await ensureWormGate(gateDir);
  const remote = mkdtempSync(path.join(os.tmpdir(), "wormgate-remote-"));
  execFileSync("git", ["init", "--bare", "-q"], { cwd: remote });
  const dir = repo({ ".vscode/tasks.json": '{"tasks":[{"runOptions":{"runOn":"folderOpen"}}]}' });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "infected"], { cwd: dir }); // no gate env: simulates a pre-existing commit
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  const r = sh("git", ["push", "-q", "origin", "main"], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MALWARE SUSPECTED: \.vscode\/tasks\.json auto-runs a task/);

  const clean = repo({ "a.txt": "ok\n" });
  execFileSync("git", ["add", "-A"], { cwd: clean });
  execFileSync("git", ["commit", "-q", "-m", "ok"], { cwd: clean });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: clean });
  assert.equal(sh("git", ["push", "-q", "origin", "HEAD:refs/heads/clean"], clean).status, 0);
});

test("npm in an infected checkout is refused before it runs; in a clean one it runs the real npm", async () => {
  await ensureWormGate(gateDir);
  const dirty = repo({ ".gitignore": "node_modules/\nconfig.bat\n" });
  const r = sh("npm", ["--version"], dirty);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MALWARE SUSPECTED: \.gitignore hides config\.bat/);

  const fake = repo({ "src/app/public/fonts/fa-solid-900.woff2": "var a = 1;\n" });
  assert.match(sh("npx", ["--version"], fake).stderr, /fake font/);

  const clean = repo({ "public/fonts/fa-solid-900.woff2": "wOF2binary" });
  const ok = sh("npm", ["--version"], clean);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout.trim(), /^\d+\.\d+/);
});

test("pre-commit scans what is STAGED: an infected file staged then restored in the working tree is refused", async () => {
  await ensureWormGate(gateDir);
  const dir = repo({ "a.js": "ok\n" });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
  writeFileSync(path.join(dir, "a.js"), PAYLOAD);
  execFileSync("git", ["add", "a.js"], { cwd: dir });
  writeFileSync(path.join(dir, "a.js"), "ok\n"); // working tree looks clean again
  const r = sh("git", ["commit", "-q", "-m", "sneaky"], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MALWARE SUSPECTED: payload marker in staged changes/);
});

test("pre-push scans every pushed commit: infected then cleaned history is refused", async () => {
  await ensureWormGate(gateDir);
  const remote = mkdtempSync(path.join(os.tmpdir(), "wormgate-remote2-"));
  execFileSync("git", ["init", "--bare", "-q"], { cwd: remote });
  const dir = repo({ ".gitignore": "config.bat\n" });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "infected"], { cwd: dir });
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["commit", "-q", "-am", "cleaned tip"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  const r = sh("git", ["push", "-q", "origin", "main"], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MALWARE SUSPECTED: \.gitignore hides config\.bat/);
});

test("on Windows the gate refuses to set up (a guarded run then doesn't start)", async () => {
  await assert.rejects(ensureWormGate(mkdtempSync(path.join(os.tmpdir(), "wormgate-win-")), "win32"), /isn't supported on Windows/);
});
