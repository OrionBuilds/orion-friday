# Agent Reach — external research tools

FRIDAY can read web pages, YouTube transcripts, and RSS feeds (`src/lib/friday/webResearch.ts`),
and her dispatched coding agents can pull in the same plus GitHub repos while working a task
(`deliverableGuidance()` in `orchestrator.ts`). This is powered by a couple of free CLI tools that
[Agent Reach](https://github.com/Panniantong/Agent-Reach) installs/configures.

**Scope: zero-config platforms only.** Agent Reach also supports Twitter/X, Reddit, Facebook,
Instagram, XiaoHongShu, and Xueqiu — all of which need real login cookies/tokens stored on this
machine. None of that is installed or wired in. Do not run
`agent-reach install --channels=...` or any `agent-reach configure <platform>-cookies` command
without deciding that's actually wanted — it's a separate, larger decision than what's documented
here.

## What FRIDAY's code actually depends on

- `curl` — already present, no install needed. Used with Jina Reader's free proxy
  (`https://r.jina.ai/<url>`) for clean page text.
- `yt-dlp` — **not yet installed.** Needed for `readYouTube()`/YouTube transcript extraction.
- `gh` — already present (FRIDAY's coding agents already use it for `gh pr create`).

FRIDAY's own RSS reading (`readRss()`) parses feed XML directly — it does not depend on Agent
Reach's Python/`feedparser` channel at all.

## Installing (run this yourself — not something FRIDAY runs for you)

Base install only, skipping the `--channels` flag and any credential-configuration commands:
```bash
pipx install https://github.com/Panniantong/agent-reach/archive/main.zip
agent-reach install --env=auto
agent-reach install --env=auto --system
```
Windows PowerShell variant is in the repo's `docs/install.md` if you'd rather not use Git Bash/WSL.

After installing, run `agent-reach doctor --json` and share the output (or let FRIDAY read it) —
that confirms `yt-dlp` resolved correctly, and gives the exact `mcporter`/Exa MCP server command
for wiring web search into `.mcp.json` (not yet done — see the plan file this doc was written
alongside for the remaining step).

## Why this isn't "install Agent Reach and it just works"

Agent Reach's own way of teaching an AI agent about these tools is a generated `SKILL.md` written
to `~/.openclaw/skills/agent-reach/` — that targets a runtime called **OpenClaw**, not Anthropic's
Claude Code CLI, which is what FRIDAY actually dispatches (`claude -p ...` in
`src/lib/friday/engines.ts`). There's no documented bridge between the two, so the integration here
is real FRIDAY-side code (`webResearch.ts` + the `deliverableGuidance()` note), not just running the
installer.
