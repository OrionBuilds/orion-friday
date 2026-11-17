// Guard: .mcp.json is handed to every OS-enabled `claude -p` via --mcp-config, so any stdio
// server listed there is auto-installed and executed on the next run. ruflo (ruvnet/claude-flow)
// was removed 2026-09-14 after a malware incident — it must never come back through this file.
// .codex/config.toml is the same vector for Codex runs (it carried its own `npx -y ruflo` entry).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BANNED = /ruflo|claude-flow|ruv-swarm|agentic-flow|ruvector|agentdb/i;
// 2026-10-28 audit: npx-launched MCP entries are banned outright (they are the ruflo re-infection
// vector), so repomix (`npx -y repomix --mcp`) was removed and the stdio allowlist is now empty.
const ALLOWED_STDIO = new Set<string>([]);

test("no MCP config launches anything through npx/npm exec", () => {
  for (const f of [path.join(process.cwd(), ".mcp.json"), path.join(process.cwd(), ".codex", "config.toml")]) {
    assert.doesNotMatch(fs.readFileSync(f, "utf8"), /["']?command["']?\s*[:=]\s*["'](npx|npm|pnpm|bunx|yarn)["']/i, f);
  }
});

test(".mcp.json carries no ruflo / claude-flow family server", () => {
  const raw = fs.readFileSync(path.join(process.cwd(), ".mcp.json"), "utf8");
  assert.doesNotMatch(raw, BANNED);
});

test(".mcp.json stdio servers are an explicit allowlist", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".mcp.json"), "utf8"));
  for (const [name, srv] of Object.entries<{ type?: string }>(cfg.mcpServers ?? {})) {
    if (srv.type === "stdio") assert.ok(ALLOWED_STDIO.has(name), `unexpected stdio MCP server "${name}"`);
  }
});

const CODEX = path.join(process.cwd(), ".codex", "config.toml");

test(".codex/config.toml carries no ruflo / claude-flow family server", () => {
  assert.doesNotMatch(fs.readFileSync(CODEX, "utf8"), BANNED);
});

test(".codex/config.toml stdio servers are the same allowlist", () => {
  for (const section of fs.readFileSync(CODEX, "utf8").split(/^(?=\[)/m)) {
    const name = /^\[mcp_servers\.([^\].]+)\]/.exec(section)?.[1];
    if (name && /^command\s*=/m.test(section)) assert.ok(ALLOWED_STDIO.has(name), `unexpected stdio MCP server "${name}" in .codex/config.toml`);
  }
});
