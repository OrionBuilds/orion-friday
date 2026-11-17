import { test } from "node:test";
import assert from "node:assert/strict";
import { persistImageTurn, type TurnRow } from "./imageTurn";

const user: TurnRow = { id: "u", channel: "web", role: "user", text: "see this [1 image attached]", ts: "t" };
const reply: TurnRow = { id: "f", channel: "web", role: "friday", text: "That's a 500 from the build step.", ts: "t" };

test("both sides written in order", async () => {
  const rows: TurnRow[] = [];
  assert.deepEqual(await persistImageTurn(async (r) => { rows.push(r); }, user, reply), { ok: true });
  assert.deepEqual(rows.map((r) => r.id), ["u", "f"]);
});

test("request write fails → reply not written, failure reported", async () => {
  const rows: TurnRow[] = [];
  const r = await persistImageTurn(async (row) => { if (row.id === "u") throw new Error("disk full"); rows.push(row); }, user, reply);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /request not saved.*disk full/);
  assert.equal(rows.length, 0, "no orphan reply");
});

test("reply write retried once, then reported", async () => {
  let fails = 1;
  const rows: TurnRow[] = [];
  assert.deepEqual(await persistImageTurn(async (row) => { if (row.id === "f" && fails-- > 0) throw new Error("busy"); rows.push(row); }, user, reply), { ok: true });
  assert.deepEqual(rows.map((r) => r.id), ["u", "f"]);
  const r = await persistImageTurn(async (row) => { if (row.id === "f") throw new Error("busy"); }, user, reply);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /reply not saved after the request was/);
});
