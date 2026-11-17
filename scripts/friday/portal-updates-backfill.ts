// FRIDAY — one-off, idempotent backfill of the client-portal "Project Updates" feed from GitHub.
//
// The daily portal-updates job only posts work that lands AFTER it first sees a repo (its cursor was
// initialised 2026-09-18 for every project), and until the 2026-09-23 rewrite it also dropped direct
// commits whenever a PR merged the same day. This script walks each repo-linked project's default
// branch over a date window, runs every unit through the SAME classifier + copy pipeline the daily job
// uses, and posts what's missing. Safe to re-run: server-side source_ref dedup + per-row commit shas.
//
// Usage (FRIDAY must be OS-signed-in: ~/.agentic-os/friday/os-session.json present; `gh` logged in):
//   npx tsx scripts/friday/portal-updates-backfill.ts --dry-run                       # every project, 2026-09-01 → each repo's initializedAt
//   npx tsx scripts/friday/portal-updates-backfill.ts --dry-run --project acme       # by local id, OS id, name or repo substring
//   npx tsx scripts/friday/portal-updates-backfill.ts --dry-run --project acme --no-llm --include-noise   # fast structural pass
//   npx tsx scripts/friday/portal-updates-backfill.ts --project acme --until now --advance-cursor        # real run
//   (no tsx installed? → node --experimental-transform-types --import ./scripts/test/register.mjs scripts/friday/portal-updates-backfill.ts …)
//
// Flags:
//   --dry-run          compose and print, post nothing (default when neither --dry-run nor --apply is given: dry run)
//   --apply            actually post to the OS
//   --project <x>      restrict to one project (local id, OS project id, or a case-insensitive substring of name/repo)
//   --since <iso>      window start (default 2026-09-01T00:00:00Z)
//   --until <iso|now>  window end (default: the repo's cursor.initializedAt so it never overlaps the daily job)
//   --include-noise    dry-run only: also print the units the classifier skips, with the reason
//   --no-llm           use the deterministic fallback copy only (fast; for structural checks)
//   --limit <n>        stop after n posts per repo
//   --advance-cursor   after a clean --apply run, move the repo cursors to max(until, current)
//
// Exit code 1 if any repo errored (errors are printed, never swallowed).

import { store } from "../../src/lib/persistence/store";
import { osEnabled } from "../../src/lib/friday/osClient";
import { parseGithubRepo } from "../../src/lib/friday/recentWork";
import { projectRepos } from "../../src/lib/friday/types";
import type { Project } from "../../src/lib/friday/types";
import {
  collectUnits, decideUnit, existingPosted, postEntry, osProjectMap, loadState, saveState, fetchDefaultBranch, setGhSpacing,
  type Posted, type RepoCursor,
} from "../../src/lib/friday/portalUpdates";
import { classifyUnit, type ComposeCtx } from "../../src/lib/friday/portalUpdateCopy";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const APPLY = flag("--apply") && !flag("--dry-run");
const DRY = !APPLY;
const PROJECT = opt("--project");
const SINCE = opt("--since") ?? "2026-09-01T00:00:00Z";
const UNTIL_RAW = opt("--until");
const UNTIL = UNTIL_RAW === "now" ? new Date().toISOString() : UNTIL_RAW;
const INCLUDE_NOISE = flag("--include-noise");
const NO_LLM = flag("--no-llm");
const LIMIT = Number(opt("--limit") ?? "0") || 0;
const ADVANCE = flag("--advance-cursor");

const isoOk = (s: string | undefined) => !s || !Number.isNaN(new Date(s).getTime());
if (!isoOk(SINCE) || !isoOk(UNTIL)) { console.error("--since/--until must be ISO timestamps (or 'now' for --until)"); process.exit(2); }

function matches(p: Project, osId: string | undefined, needle: string): boolean {
  const n = needle.toLowerCase();
  if (p.id === needle || osId === needle) return true;
  if (p.name.toLowerCase().includes(n)) return true;
  return projectRepos(p).some((u) => u.toLowerCase().includes(n));
}

function hr(s = ""): void { console.log(s ? `\n${"─".repeat(8)} ${s} ${"─".repeat(Math.max(0, 70 - s.length))}` : "─".repeat(80)); }

async function main(): Promise<number> {
  if (!osEnabled()) { console.error("OS bridge disabled — FRIDAY is not signed in to the OS (~/.agentic-os/friday/os-session.json)"); return 2; }
  setGhSpacing(150);

  const map = await osProjectMap();
  const state = await loadState();
  const all = await store.projects.find((p: Project) => p.status === "active" && projectRepos(p).length > 0 && p.portalUpdates !== false);
  const projects = PROJECT ? all.filter((p) => matches(p, map.get(p.id), PROJECT)) : all;
  if (!projects.length) { console.error(PROJECT ? `no active repo-linked project matches "${PROJECT}"` : "no active repo-linked projects"); return 2; }

  console.log(`${DRY ? "DRY RUN" : "APPLY"} — ${projects.length} project(s), since ${SINCE}, until ${UNTIL ?? "<each repo's cursor.initializedAt>"}${NO_LLM ? ", fallback copy only" : ""}`);
  let totals = { post: 0, skip: 0, dedup: 0, errors: 0, fallback: 0 };

  for (const p of projects) {
    const osId = map.get(p.id);
    if (!osId) { console.log(`\n[SKIP project] ${p.name} — not mirrored to the OS yet`); continue; }
    let posted: Posted | undefined;

    for (const repoUrl of projectRepos(p)) {
      const gh = parseGithubRepo(repoUrl);
      if (!gh) continue;
      const key = `${gh.owner}/${gh.repo}`;
      const cursor: RepoCursor | undefined = state[key];
      const until = UNTIL ?? cursor?.initializedAt ?? new Date().toISOString();
      hr(`${p.name} · ${key}`);
      console.log(`window (${SINCE}, ${until}]${cursor ? `  cursor: merged ${cursor.lastMergedAt ?? "-"} / commit ${cursor.lastCommitAt ?? "-"}` : "  (no cursor yet)"}`);

      try {
        const defaultBranch = cursor?.defaultBranch ?? (await fetchDefaultBranch(gh.owner, gh.repo));
        const units = await collectUnits(gh.owner, gh.repo, { since: SINCE, until, defaultBranch, paginate: true });
        if (!units.length) { console.log("nothing landed in this window"); continue; }
        posted = posted ?? (await existingPosted(osId));
        const ctx: ComposeCtx = { projectName: p.name, mode: "live" };
        let n = 0;

        for (const unit of units) {
          if (LIMIT && n >= LIMIT) { console.log(`--limit ${LIMIT} reached`); break; }
          const decision = await decideUnit(unit, posted, cursor, ctx, { noLlm: NO_LLM });
          const stamp = `${unit.occurredAt.slice(0, 10)} ${unit.ref.padEnd(28)}`;
          if (decision.action === "dedup") { totals.dedup++; console.log(`[DEDUP]            ${stamp} "${unit.title.slice(0, 80)}"`); continue; }
          if (decision.action === "skip") {
            totals.skip++;
            if (INCLUDE_NOISE || decision.reason === "already-posted") {
              console.log(`[SKIP ${decision.reason.padEnd(13)}] ${stamp} "${unit.title.slice(0, 80)}"  (${unit.files.length} files)`);
            }
            continue;
          }
          const e = decision.entry;
          totals.post++; n++;
          if (e.via === "fallback") totals.fallback++;
          console.log(`[POST ${e.via.padEnd(12)}] ${stamp} ${classifyUnit(unit).kind} · ${unit.commits.length} commit(s), ${unit.files.length} file(s)`);
          console.log(`  TITLE: ${e.title}`);
          for (const line of e.detail.split("\n")) console.log(`    ${line}`);
          if (e.issues?.length) console.log(`  (fallback because: ${e.issues.join("; ")})`);
          if (APPLY) {
            const r = await postEntry(osId, e, unit);
            if (r.deduped) { totals.dedup++; totals.post--; console.log("  → server deduped"); }
            else {
              posted.refs.add(unit.ref);
              for (const c of unit.commits) if (c.sha) posted.shas.add(c.sha);
              console.log("  → posted");
            }
          }
        }

        if (APPLY && ADVANCE) {
          const cur = state[key] ?? { initializedAt: new Date().toISOString() };
          cur.defaultBranch = defaultBranch;
          cur.lastMergedAt = [cur.lastMergedAt, until].filter(Boolean).sort().pop();
          cur.lastCommitAt = [cur.lastCommitAt, until].filter(Boolean).sort().pop();
          state[key] = cur;
          await saveState(state);
          console.log(`cursor advanced → ${cur.lastMergedAt}`);
        }
      } catch (e) {
        totals.errors++;
        console.error(`[ERROR] ${key}: ${String((e as Error).message ?? e)}`);
      }
    }
  }

  hr();
  console.log(`${DRY ? "would post" : "posted"} ${totals.post}, skipped ${totals.skip} (noise/already posted), ${totals.dedup} deduped, ${totals.fallback} fallback copy, ${totals.errors} error(s)`);
  if (DRY) console.log("dry run — nothing was posted. Re-run with --apply to post.");
  return totals.errors ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
