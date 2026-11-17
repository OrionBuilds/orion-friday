// Pure-logic tests for the migration autopush helpers.
//
// pushMigrations itself spawns `git` and calls the Supabase Management API; those are integration-
// shaped and not covered here. What stays pure and testable: the file filter, the filename parser,
// the local-migrations reader, the transaction wrapper, and the output-tailing used in SMS summaries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  changedMigrations,
  lastChars,
  parseMigrationFilename,
  readLocalMigrations,
  wrapMigration,
} from "./supabasePush";

test("changedMigrations: keeps supabase/migrations/*.sql, rejects everything else", () => {
  assert.deepEqual(
    changedMigrations([
      "supabase/migrations/20260925120000_order_contact_overrides.sql",
      "supabase/migrations/20260926000000_recipient_name_syncs_calendar.sql",
      "supabase/functions/send-reminder/index.ts",
      "src/app/orders/page.tsx",
      "README.md",
    ]),
    [
      "supabase/migrations/20260925120000_order_contact_overrides.sql",
      "supabase/migrations/20260926000000_recipient_name_syncs_calendar.sql",
    ],
  );
});

test("changedMigrations: nested app paths (monorepo), rejects non-.sql + archive dirs", () => {
  assert.deepEqual(
    changedMigrations([
      "apps/web/supabase/migrations/20260925120000_add_table.sql",
      "packages/admin/supabase/migrations/20260926120000_fix_rls.sql",
      "supabase/migrations_archive/old.sql",
      "supabase/migrations/not_a_sql.md",
    ]),
    [
      "apps/web/supabase/migrations/20260925120000_add_table.sql",
      "packages/admin/supabase/migrations/20260926120000_fix_rls.sql",
    ],
  );
});

test("changedMigrations: empty / junk input returns empty", () => {
  assert.deepEqual(changedMigrations([]), []);
  assert.deepEqual(changedMigrations(["", "/foo", "supabase/migrations/"]), []);
});

test("parseMigrationFilename: standard 14-digit prefix + snake_case name", () => {
  assert.deepEqual(
    parseMigrationFilename("20260925120000_add_order_contact_overrides.sql"),
    { version: "20260925120000", name: "add_order_contact_overrides" },
  );
  assert.deepEqual(
    parseMigrationFilename("some/dir/20260925120000_foo.sql"),
    { version: "20260925120000", name: "foo" },
  );
});

test("parseMigrationFilename: wrong digit count / wrong extension / missing name → null", () => {
  assert.equal(parseMigrationFilename("2026092512_short.sql"), null);
  assert.equal(parseMigrationFilename("20260925120000_name.txt"), null);
  assert.equal(parseMigrationFilename("20260925120000.sql"), null);
  assert.equal(parseMigrationFilename("not_a_migration.sql"), null);
});

test("wrapMigration: body is pasted untouched; ledger insert is ON CONFLICT DO NOTHING", () => {
  const body = `create table things (id uuid primary key);\ncreate index on things(id);`;
  const wrapped = wrapMigration({ version: "20260925120000", name: "add_things", sql: body });
  assert.ok(wrapped.startsWith("begin;\n"));
  assert.ok(wrapped.trimEnd().endsWith("commit;"));
  assert.ok(wrapped.includes(body), "the raw migration SQL must be inside the wrapper verbatim");
  assert.ok(wrapped.includes("supabase_migrations.schema_migrations"));
  assert.ok(wrapped.includes("'20260925120000'"));
  assert.ok(wrapped.includes("'add_things'"));
  assert.ok(wrapped.includes("on conflict (version) do nothing"));
});

test("wrapMigration: single quotes in `name` are SQL-escaped (defensive)", () => {
  const wrapped = wrapMigration({ version: "20260925120000", name: "it's_fine", sql: "select 1;" });
  assert.ok(wrapped.includes("'it''s_fine'"), "single quote in name doubled");
});

test("readLocalMigrations: picks up supabase/migrations/*.sql, sorts by version, keeps SQL body", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sp-repo-"));
  try {
    const dir = path.join(root, "supabase", "migrations");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "20260926120000_second.sql"), "select 2;");
    await writeFile(path.join(dir, "20260925120000_first.sql"), "select 1;");
    await writeFile(path.join(dir, "ignore_me.sql"), "select 3;");       // no 14-digit prefix
    await writeFile(path.join(dir, "20260925120000_first.txt"), "x");    // wrong extension
    const out = await readLocalMigrations(root);
    assert.equal(out.length, 2, "only well-named .sql files");
    assert.equal(out[0].version, "20260925120000", "sorted ascending");
    assert.equal(out[0].name, "first");
    assert.equal(out[0].sql, "select 1;");
    assert.equal(out[1].version, "20260926120000");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readLocalMigrations: missing dir returns empty rather than throwing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sp-norepo-"));
  try {
    assert.deepEqual(await readLocalMigrations(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lastChars: tails long output; passes short output through; trims trailing whitespace", () => {
  assert.equal(lastChars("short", 100), "short");
  assert.equal(lastChars("line1\nline2\nline3\n\n", 100), "line1\nline2\nline3");
  const long = "x".repeat(500);
  const tail = lastChars(long, 100);
  assert.equal(tail.length, 100);
  assert.equal(tail, "x".repeat(100));
});
