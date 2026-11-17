// PR shepherd probe: show what the shepherd would do with every open FRIDAY PR, then optionally do
// the safe part (close superseded/stale, merge green) without dispatching any agent rounds.
//
//   node --experimental-transform-types --import ./scripts/test/register.mjs scripts/probes/pr-shepherd.ts               # dry run, all repos
//   node ... scripts/probes/pr-shepherd.ts --repo example-org/acme-site                                                 # one repo
//   node ... scripts/probes/pr-shepherd.ts --repo example-org/acme-app --apply                                         # close/merge only
//
// Rounds (fix/review/rebase/qa) are never dispatched from here — the service does that under its
// budgets. --apply passes maxDispatch: 0 so only close, merge, resolve and request-review happen.

import { runPrShepherd, shepherdMode } from "../../src/lib/friday/prShepherd";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const repoIdx = argv.indexOf("--repo");
const onlyRepos = repoIdx >= 0 && argv[repoIdx + 1] ? [argv[repoIdx + 1]] : undefined;

function short(a: { kind: string } & Record<string, unknown>): string {
  const extra = Object.entries(a).filter(([k]) => k !== "kind").map(([k, v]) => `${k}=${typeof v === "string" ? v : Array.isArray(v) ? v.length : JSON.stringify(v)}`).join(" ");
  return extra ? `${a.kind} (${extra.slice(0, 120)})` : a.kind;
}

async function main() {
  const mode = shepherdMode();
  if (mode === "off") { console.log("FRIDAY_PR_SHEPHERD=off — set it to dry or active to probe"); process.exit(2); }
  console.log(`${APPLY ? "APPLY (close/merge only, no agent rounds)" : "DRY RUN"} — mode=${mode}${onlyRepos ? ` repos=${onlyRepos.join(",")}` : " (all active repo-linked projects)"}`);
  const { summary, results } = await runPrShepherd({ dryRun: !APPLY, onlyRepos, maxDispatch: APPLY ? 0 : undefined });
  const byRepo = new Map<string, typeof results>();
  for (const r of results) {
    const key = r.pr.replace(/^https:\/\/github\.com\//, "").replace(/\/pull\/\d+$/, "");
    byRepo.set(key, [...(byRepo.get(key) ?? []), r]);
  }
  for (const [repo, rows] of byRepo) {
    console.log(`\n── ${repo}`);
    for (const r of rows.sort((a, b) => Number(a.pr.split("/").pop()) - Number(b.pr.split("/").pop()))) {
      const n = r.pr.split("/").pop();
      console.log(`  #${String(n).padEnd(4)} → ${short(r.action as { kind: string } & Record<string, unknown>)}${r.applied ? "  [applied]" : ""}${r.note ? `  — ${r.note}` : ""}`);
    }
  }
  console.log(`\n${summary}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
