# Setting up FRIDAY

FRIDAY runs on your **agent machine** (Linux, or Windows with WSL2) and works inside **Orion** with her own staff account. Set up Orion first (github.com/OrionBuilds/orion). If you also run Clara, both agents share one agent-core folder.

## 1. Get the code

```bash
mkdir -p ~/agents && cd ~/agents
git clone https://github.com/OrionBuilds/orion-agent-core.git agent-core   # skip if Clara already has it
git clone https://github.com/OrionBuilds/orion-friday.git friday
cd agent-core && bash scripts/security/check-repo.sh && npm install && cd ..
cd friday && bash scripts/security/check-repo.sh && npm install
```

Both scans must say `no warning signs found` before you install.

## 2. Tools FRIDAY drives

- **Claude Code**, logged in to your Claude plan (`claude`): her main engine for coding and research
- **GitHub CLI**, logged in (`gh auth login`): she reads issues and pull requests, and opens PRs for you to review
- Optional: **Codex CLI** as a second engine, **LM Studio** for local models

If a tool isn't on `PATH` for the service, copy `agentic-os.config.example.json` to `~/.agentic-os/config.json` and set the full paths.

## 3. Tell FRIDAY about you

```bash
cp owner-profile.example.json owner-profile.json
```

Fill in your name, time zone, quiet hours and the people who may give FRIDAY instructions.

## 4. Give FRIDAY her own Orion account

1. Create a mailbox for her, e.g. `friday@yourbusiness.com`.
2. In Orion go to **Settings → Organization → Staff Management → Invite User** and give that address the **FridayAgent** role.
3. Accept the invite from her mailbox.

## 5. Fill in her settings

```bash
cp .env.local.example .env.local
```

Fill in at least:

| Setting | What to put |
|---|---|
| `ORION_SUPABASE_URL`, `ORION_SUPABASE_ANON_KEY` | Your Orion project's URL and anon key |
| `ORION_MCP_URL` | Orion's MCP server address (from Orion's `mcp-server/` folder) |
| `ORION_EXPECTED_EMAIL` | FRIDAY's Orion address; she refuses to sign in as anyone else |
| `ORION_PUBLIC_URL` | Your Orion web address, used in links she sends |
| `ORION_OWNER_PROFILE` | `./owner-profile.json` |
| `INTERAGENT_SHARED_SECRET` | The same value as in Clara and Orion |
| `GITHUB_OWNER` | Your GitHub username or organization |

Everything else in the file is optional and documented inline.

## 6. Start FRIDAY and sign her in

```bash
npm run build
npm start          # http://127.0.0.1:3737
```

In a **private browser window**, open `http://127.0.0.1:3737/api/os/auth` and sign in as **FRIDAY's** account. Don't sign her out of Orion in that browser afterwards: signing out revokes the session she just captured.

Then open `http://127.0.0.1:3737/friday` for her command center.

## 7. Connect your projects

In Orion, open a project and fill in its **Connections** card: GitHub repos, Supabase project, Netlify site and files folder. FRIDAY syncs these both ways, so she knows where each client's code and site live.

## 8. Run her as a service (Linux / WSL2)

Create `~/.config/systemd/user/friday.service`:

```ini
[Unit]
Description=FRIDAY
After=network-online.target

[Service]
WorkingDirectory=%h/agents/friday
ExecStart=/usr/bin/env npm start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now friday
journalctl --user -u friday -f
```

If Node came from nvm, use the full path from `which npm` in `ExecStart`.

## 9. Check she's alive

Orion's **Agent Health** page shows FRIDAY's heartbeat and costs. Her scheduled work (ticket triage, portal updates, website monitoring and the weekly client update) appears under **Agent Schedules** in Orion. Start new schedules in **shadow** until you trust the output.

## Updating

```bash
cd ~/agents/agent-core && git pull && bash scripts/security/check-repo.sh && npm install
cd ~/agents/friday && git pull && bash scripts/security/check-repo.sh && npm install && npm run build
systemctl --user restart friday
```

Never build an update the scanner flags.
