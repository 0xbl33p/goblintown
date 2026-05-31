---
name: goblintown-sidecar
description: Use when the user wants Codex to install, register, verify, configure, or use Goblintown as a local npm-distributed MCP sidecar; also use when deciding whether to offer Goblintown for Single Goblin, full rites, planner DAGs, provider checks, chat import, or local Warren workflows.
---

# Goblintown Sidecar

Goblintown is a local-first Codex sidecar distributed through npm. It runs as a
stdio MCP server from the user's machine. Do not suggest a hosted MCP unless the
user explicitly asks for hosted operations.

The default mode is **autopilot**: the Tank displays a live diorama with
creature animations, DAG progress, and result panels. There is no chat
surface — the agent drives everything via MCP tools.

## Consent Rules

Do not ask before safe inspection:

- Checking npm tags or versions with `npm view`.
- Running `goblintown mcp --doctor` or `goblintown mcp --config-snippet`.
- Using already-available Goblintown MCP tools when the user explicitly asked
  for Goblintown, a rite, a sidecar action, or a provider/status check.

Ask before changing the user's machine or local data unless they explicitly
asked for that exact install/setup/import action:

- Running `goblintown install` or `npm install -g goblintown@latest`.
- Writing Codex config with `goblintown mcp --install-codex`.
- Installing or replacing this Codex skill with `goblintown skill install`.
- Running `goblintown init`, because it creates `.goblintown` in the project.
- Importing chat history, scanning personal folders, or vectorizing stored
  records.
- Changing provider routes, API-key storage, voice settings, or model choices.
- Running a full rite or planner DAG when the user only asked a normal Codex
  question and has not opted into possible API spend.

If Goblintown would be helpful but optional, ask once in plain language whether
to use it. If the user says yes, proceed without repeated confirmation for the
same setup/workflow.

## Single-Command Install

The fastest path to a working agent setup is one command:

```bash
npx -y goblintown@latest install
```

This single command:
1. Creates a Warren if none exists in the current directory.
2. Installs the Codex MCP config into `~/.codex/config.toml`.
3. Installs this skill into `~/.codex/skills/goblintown-sidecar`.
4. Starts the Tank in autopilot mode at `http://localhost:7777`.

Skip the server with `--no-serve`:

```bash
npx -y goblintown@latest install --no-serve
```

## Install The Skill

If this skill is not already installed in Codex, install it from the npm package:

```bash
npx -y goblintown@latest skill install
```

This copies `goblintown-sidecar` into `${CODEX_HOME:-$HOME/.codex}/skills` and
backs up an existing skill folder before replacement. Restart Codex after
installing or updating the skill so the new instructions load.

For a local checkout, install from the repo copy instead:

```bash
npm install
npm run build
node dist/cli.js skill install --source-dir ./skills/goblintown-sidecar
```

## Install Packages

For MCP-only usage, prefer `npx`; it keeps updates package-managed and does not
require a global binary:

```bash
npm view goblintown@latest name version dist-tags --json
npx -y goblintown@latest mcp --doctor
```

If the user wants the CLI or desktop launcher available globally, ask first
unless they already requested a global install:

```bash
npm install -g goblintown@latest
goblintown mcp --doctor
```

## Install The MCP

Use the package-managed installer for Codex Desktop:

```bash
npx -y goblintown@latest mcp --install-codex
```

It writes this TOML block into `${CODEX_HOME:-$HOME/.codex}/config.toml` and
creates a timestamped backup when it changes an existing config:

```toml
[mcp_servers.goblintown]
command = "npx"
args = ["-y", "goblintown@latest", "mcp"]
```

Restart Codex after `--install-codex`. For MCP clients that accept JSON, the
equivalent local stdio config is:

```json
{
  "mcpServers": {
    "goblintown": {
      "command": "npx",
      "args": ["-y", "goblintown@latest", "mcp"]
    }
  }
}
```

For unpublished local checkout testing only, use the built CLI path:

```json
{
  "mcpServers": {
    "goblintown": {
      "command": "node",
      "args": ["/absolute/path/to/goblintown/dist/cli.js", "mcp"]
    }
  }
}
```

## Verify

Run the doctor from the directory Codex will use:

```bash
npx -y goblintown@latest mcp --doctor
```

Interpret the result carefully:

- `ok: true` means the package can serve the MCP.
- `projectReady: false` means the current folder has no Warren; it is not an MCP
  install failure.
- To make a project ready, move to the project root and run `goblintown init`
  only after the user agrees or explicitly asks.

## Use The MCP Tools

Goblintown exposes these local tools:

- `goblintown_doctor`: setup, cwd, Warren, and install diagnostics.
- `goblintown_provider`: provider, model route, and missing-key status without
  exposing secrets.
- `goblintown_chat`: Single Goblin mode for one direct local model call.
- `goblintown_rite`: full rite with context scan, pack generation, review,
  fallback/recovery, and scribe artifact.
- `goblintown_plan`: planner DAG execution where each node becomes a sub-rite.

Use `goblintown_doctor` first when setup or cwd is uncertain. Use
`goblintown_provider` before changing model/provider assumptions. Use
`goblintown_chat` for quick continuity, `goblintown_rite` for pack review or
multi-agent scrutiny, and `goblintown_plan` for complex multi-step work.

## Autopilot Mode

By default, `goblintown serve` runs in **autopilot** mode. The Tank displays
the full creature diorama (goblins, gremlins, raccoon, troll, ogre, pigeon)
with streaming thinking bubbles, a DAG progress panel, and result cards.

There is no chat input box — the agent controls everything through MCP tools.
When the agent calls `goblintown_rite` or `goblintown_plan`, the Tank streams
the rite live and renders the output.

To restore the legacy chat surface, use:

```bash
goblintown serve --chat
```

## Troubleshooting

- Missing API key: configure the provider in the Tank's Settings > API panel
  or set the provider env var, then rerun `goblintown mcp --doctor`.
- Wrong directory: MCP inherits Codex's working directory. Point Codex at the
  project root or initialize a Warren there.
- Stale package: run `npm view goblintown@latest version dist-tags --json`, then
  use `goblintown@latest` unless the user requests a pinned version.
- Tank not responding: the Tank runs on `http://localhost:7777` by default.
  Rites started via MCP appear live in the Tank display.
