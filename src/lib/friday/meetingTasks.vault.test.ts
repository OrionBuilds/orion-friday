// The Office vault path: OFFICE_VAULT_PATH wins when set; blank or unset falls back to the default
// office vault (never a Windows drive path).
import { test } from "node:test";
import assert from "node:assert/strict";
import { officeVaultPath, DEFAULT_OFFICE_VAULT_PATH } from "./meetingTasks";

test("office vault path: env override, blank falls back, default is the office vault", () => {
  assert.equal(officeVaultPath({ OFFICE_VAULT_PATH: "/tmp/vault" }), "/tmp/vault");
  assert.equal(officeVaultPath({ OFFICE_VAULT_PATH: "   " }), DEFAULT_OFFICE_VAULT_PATH);
  assert.equal(officeVaultPath({}), DEFAULT_OFFICE_VAULT_PATH);
  assert.ok(!DEFAULT_OFFICE_VAULT_PATH.includes("D:"));
});
