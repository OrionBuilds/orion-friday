# FRIDAY

FRIDAY is an open-source AI delivery manager for service businesses. She runs your client projects inside **Orion**: plans the work, breaks it into tasks, hands coding and research to AI engines (Claude Code, Codex and others), keeps pull requests moving, watches your clients' websites, picks up support tickets and change requests from the client portal, and drafts weekly client updates for your approval.

She works alongside **Clara**, the executive assistant: Clara handles you and your inbox, FRIDAY handles the delivery.

## What she does

- **Projects and tasks:** mirrors your Orion projects, plans the work, tracks tasks to done
- **Client portal:** triages support tickets and change requests, and asks clarifying questions
- **Code:** dispatches work to Claude Code, Codex or other engines in each project's repo, shepherds pull requests through review and CI, and refuses to build anything her worm scanner flags
- **Monitoring:** website uptime and security sweeps, with a client health report
- **Updates:** weekly client updates and release approvals, drafted for you to approve
- **Command center:** a local dashboard at `/friday` you can type or talk to

## Requirements

- An **Orion** install (github.com/OrionBuilds/orion) with a staff account for FRIDAY (role **FridayAgent**)
- **agent-core** (github.com/OrionBuilds/orion-agent-core) cloned next to this folder, as `agent-core`
- Node.js 22, Claude Code logged in to your Claude plan, and the GitHub CLI (`gh`) logged in
- Optional: Codex CLI, LM Studio, Twilio, ElevenLabs

## Get started

```
agents/
├── agent-core/
└── friday/
```

```bash
git clone https://github.com/OrionBuilds/orion-agent-core.git agent-core
git clone https://github.com/OrionBuilds/orion-friday.git friday
cd friday
bash scripts/security/check-repo.sh
npm install
cp .env.local.example .env.local      # fill in the Orion and owner sections
cp owner-profile.example.json owner-profile.json
npm run dev                           # http://127.0.0.1:3737
```

Full setup, including FRIDAY's Orion account, GitHub access and running her as a service: **[docs/SETUP.md](docs/SETUP.md)**. To build your own specialist agents on top of FRIDAY, see [BUILD-YOUR-OWN.md](BUILD-YOUR-OWN.md).

## Develop

```bash
npx tsc --noEmit
npm test
npm run build
```

Six worm-guard tests create deliberately infected test repositories. On a machine with a git-level scanner hook (such as worm-gate) installed, that hook blocks their commits and those six tests fail; that is the hook doing its job.

Run `bash scripts/security/check-repo.sh` before you build or run anything you've cloned or pulled.

## Learn with the community

The free Autom8ion Lab classroom on Skool walks through setting up Orion, Clara, FRIDAY and Harvey. [Join the community](https://www.skool.com/autom8ion-lab-7149).

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
