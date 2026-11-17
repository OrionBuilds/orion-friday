// Worm gate — enforcement DURING an agent run, at the two boundaries where the worm does damage:
// building (its payload runs when a build loads the infected config) and pushing (spreading it).
//
// The pre-run and post-run scans (wormGuard) bracket a run, but an agent can change the checkout in
// between — e.g. merge an infected base — and then build or push before the run returns. So every
// write-role agent process is started with:
//   - core.hooksPath → FRIDAY's own pre-commit / pre-push hooks (via GIT_CONFIG_* env, so neither the
//     owner's repos nor their config are touched). This also means a repo's OWN git hooks — repo code —
//     never run under an agent.
//   - a PATH shim for npm / npx / pnpm / yarn / bun that scans the checkout before handing over to
//     the real binary.
// A hit refuses the command with "MALWARE SUSPECTED: …" (which the agent is told to relay); the
// post-run scan then reports and blocks the repo as usual. The scripts only run git and head — never
// repository code. Generated from wormScan's markers at runtime, so no source file carries them.

import { promises as fs } from "node:fs";
import path from "node:path";
import { agentEnv } from "@autom8ionlab/agent-core";
import { FRIDAY_DATA_DIR } from "@/lib/persistence/store";
import { MARKERS } from "@/lib/friday/wormScan";
import { ENV_OPTIONS } from "@/lib/runner";

export const GATED_TOOLS = ["npm", "npx", "pnpm", "yarn", "bun"] as const;
const PUSH_SCAN_CAP = 300;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shared scan script: `scan.sh tree <label>` (working tree of $PWD's repo) or `scan.sh commit <sha> <label>`. Pure. */
export function scanScript(): string {
  const markers = MARKERS.map((m) => `-e ${shq(m)}`).join(" ");
  return `#!/bin/sh
# FRIDAY worm gate — generated; do not edit. Only runs git/head, never repository code.
#   scan.sh tree <label>          working tree of $PWD's repo (package-tool shims)
#   scan.sh index <label>         the staged index (pre-commit: what the commit will contain)
#   scan.sh commit <sha> <label>  one commit's tree (pre-push, per pushed commit)
mode="$1"; shift
refuse() { echo "MALWARE SUSPECTED: $1 — FRIDAY's worm gate refused: $LABEL" >&2; exit 1; }
FONT_RX='(^|/)public/fonts/fa-[a-z0-9]+-(400|900)\\.woff2$'
if [ "$mode" = commit ]; then
  sha="$1"; LABEL="$2"
  git grep -q -I -F ${markers} "$sha" -- . ':(exclude).github' 2>/dev/null && refuse "payload marker in $sha"
  for f in .vscode/tasks.json .vscode/settings.json; do
    git show "$sha:$f" 2>/dev/null | grep -Eq '"runOn"[[:space:]]*:[[:space:]]*"folderOpen"|"task\\.allowAutomaticTasks"[[:space:]]*:[[:space:]]*(true|"on")' && refuse "$f auto-runs a task"
  done
  git show "$sha:.gitignore" 2>/dev/null | tr -d '\\r' | grep -Eqx '/?config\\.bat' && refuse ".gitignore hides config.bat"
  git ls-tree -r --name-only "$sha" 2>/dev/null | grep -E "$FONT_RX" | while IFS= read -r f; do
    [ "$(git cat-file blob "$sha:$f" 2>/dev/null | head -c 4)" = "wOF2" ] || { echo "$f"; break; }
  done | grep -q . && refuse "fake font file in $sha"
  exit 0
fi
if [ "$mode" = index ]; then
  LABEL="$1"
  git grep -q -I -F --cached ${markers} -- . ':(exclude).github' 2>/dev/null && refuse "payload marker in staged changes"
  for f in .vscode/tasks.json .vscode/settings.json; do
    git show ":$f" 2>/dev/null | grep -Eq '"runOn"[[:space:]]*:[[:space:]]*"folderOpen"|"task\\.allowAutomaticTasks"[[:space:]]*:[[:space:]]*(true|"on")' && refuse "staged $f auto-runs a task"
  done
  git show ":.gitignore" 2>/dev/null | tr -d '\\r' | grep -Eqx '/?config\\.bat' && refuse "staged .gitignore hides config.bat"
  git ls-files --cached 2>/dev/null | grep -E "$FONT_RX" | while IFS= read -r f; do
    [ "$(git cat-file blob ":$f" 2>/dev/null | head -c 4)" = "wOF2" ] || { echo "$f"; break; }
  done | grep -q . && refuse "staged fake font file"
  exit 0
fi
LABEL="$1"
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0
git grep -q -I -F --untracked ${markers} -- . ':(exclude).github' ':(exclude)node_modules' 2>/dev/null && refuse "payload marker in the working tree"
for f in .vscode/tasks.json .vscode/settings.json; do
  [ -f "$f" ] && grep -Eq '"runOn"[[:space:]]*:[[:space:]]*"folderOpen"|"task\\.allowAutomaticTasks"[[:space:]]*:[[:space:]]*(true|"on")' "$f" && refuse "$f auto-runs a task"
done
[ -f .gitignore ] && tr -d '\\r' < .gitignore | grep -Eqx '/?config\\.bat' && refuse ".gitignore hides config.bat"
git ls-files --cached --others --exclude-standard 2>/dev/null | grep -E "$FONT_RX" | while IFS= read -r f; do
  [ -f "$f" ] && [ "$(head -c 4 "$f")" != "wOF2" ] && { echo "$f"; break; }
done | grep -q . && refuse "fake font file in the working tree"
exit 0
`;
}

/** pre-commit / pre-push hooks that call the scan script. Pure. */
export function hookScripts(gateDir: string): Record<string, string> {
  const scan = shq(path.join(gateDir, "scan.sh"));
  return {
    // The index is what the commit will contain (the working tree can differ).
    "pre-commit": `#!/bin/sh\nexec ${scan} index "git commit"\n`,
    // Every commit a push introduces — not just the tip: an infected commit followed by a clean one
    // must not ride along in the pushed history. New refs: commits not on any remote ref. Capped.
    "pre-push": `#!/bin/sh
z=0000000000000000000000000000000000000000
while read -r lref lsha rref rsha; do
  [ "$lsha" = "$z" ] && continue
  if [ "$rsha" = "$z" ]; then range=$(git rev-list "$lsha" --not --remotes 2>/dev/null); else range=$(git rev-list "$rsha..$lsha" 2>/dev/null); fi
  [ -n "$range" ] || range="$lsha"
  n=$(printf '%s\\n' "$range" | grep -c .)
  [ "$n" -gt ${PUSH_SCAN_CAP} ] && { echo "MALWARE SUSPECTED: refusing to push $n unscanned commits at once (cap ${PUSH_SCAN_CAP}) — FRIDAY's worm gate refused: git push $rref" >&2; exit 1; }
  for c in $range; do ${scan} commit "$c" "git push $rref" || exit 1; done
done
exit 0
`,
  };
}

/** A shim that scans, then runs the real tool with the shim dir removed from PATH. Pure. */
export function shimScript(gateDir: string, tool: string): string {
  const shimDir = path.join(gateDir, "bin");
  return `#!/bin/sh
${shq(path.join(gateDir, "scan.sh"))} tree "${tool} $*" || exit 1
PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF ${shq(shimDir)} | paste -sd: -)
export PATH
exec ${tool} "$@"
`;
}

async function writeIfChanged(file: string, body: string): Promise<void> {
  const cur = await fs.readFile(file, "utf8").catch(() => null);
  if (cur !== body) await fs.writeFile(file, body, { mode: 0o755 });
  await fs.chmod(file, 0o755);
}

/** Write (or refresh) the gate scripts. Returns the gate directory. */
export async function ensureWormGate(gateDir = path.join(FRIDAY_DATA_DIR, "worm-gate"), platform: NodeJS.Platform = process.platform): Promise<string> {
  // The hooks and shims are POSIX sh. On Windows they wouldn't intercept anything, so a guarded run
  // refuses to start there rather than running unguarded.
  if (platform === "win32") throw new Error("the worm gate isn't supported on Windows — guarded runs are refused");
  await fs.mkdir(path.join(gateDir, "hooks"), { recursive: true });
  await fs.mkdir(path.join(gateDir, "bin"), { recursive: true });
  await writeIfChanged(path.join(gateDir, "scan.sh"), scanScript());
  for (const [name, body] of Object.entries(hookScripts(gateDir))) await writeIfChanged(path.join(gateDir, "hooks", name), body);
  for (const tool of GATED_TOOLS) await writeIfChanged(path.join(gateDir, "bin", tool), shimScript(gateDir, tool));
  return gateDir;
}

/**
 * Env for a write-role agent process: FRIDAY's hooks via GIT_CONFIG_* and the shim dir first on PATH
 * (on top of the same PATH agent-core would build — extraEnv replaces PATH wholesale). Pure given dir.
 */
export function wormGateEnv(gateDir: string, basePath: string = agentEnv(ENV_OPTIONS).PATH ?? process.env.PATH ?? ""): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: path.join(gateDir, "hooks"),
    PATH: [path.join(gateDir, "bin"), basePath].filter(Boolean).join(path.delimiter),
    FRIDAY_WORM_GATE: "1",
  };
}
