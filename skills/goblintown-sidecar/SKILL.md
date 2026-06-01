---
name: goblintown-sidecar
description: Use when the user wants Codex to install, register, verify, configure, or use Goblintown as a local npm-distributed MCP sidecar; also use when deciding whether to offer Goblintown for Single Goblin, full rites, planner DAGs, provider checks, chat import, or local Warren workflows.
---

# Goblintown Codex Plugin 1.0

Goblintown Codex Plugin 1.0 is the Codex front-end adapter for Goblintown, an
agent-first, model-augmentable orchestration tool compatible with most front
ends. It is installed through npm, ships a Codex composer plugin plus this
skill, and runs as a stdio MCP server from the user's machine. Do not suggest a
hosted MCP unless the user explicitly asks for hosted operations.

The desktop installers are a separate distribution named **Goblintown Desktop
Beta 0.1**. The upcoming ChatGPT integration should be named **Goblintown
ChatGPT App 1.0**. Future harness packages should use the same pattern:
**Goblintown <Host> App/Plugin <major.minor>**.

The default mode is **AI-autopilot**: the Tank displays a live diorama with
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
- Installing or replacing the Codex composer extension with
  `goblintown plugin install`.
- Running `goblintown init`, because it creates `.goblintown` in the project.
- Importing chat history, scanning personal folders, or vectorizing stored
  records.
- Changing provider routes, API-key storage, voice settings, or model choices.
- Running a full local-provider rite or planner DAG when the user only asked a
  normal Codex question and has not opted into possible API spend.

If Goblintown would be helpful but optional, ask once in plain language whether
to use it. If the user says yes, proceed without repeated confirmation for the
same setup/workflow.

## Single-Command Install

The fastest path to Goblintown Codex Plugin 1.0 is one command:

```bash
npx -y goblintown@latest install
```

This single command:
1. Creates a Warren if none exists in the current directory.
2. Installs the Codex MCP config into `~/.codex/config.toml`.
3. Installs this skill into `~/.codex/skills/goblintown-sidecar`.
4. Installs and enables the Codex plugin for the composer `+` menu.
5. Starts the Tank in AI-autopilot mode at `http://localhost:7777`.

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

## Install The Composer Extension

To make Goblintown available from Codex's composer `+` menu, install the bundled
plugin/extension:

```bash
npx -y goblintown@latest plugin install
```

This copies the plugin to `~/plugins/goblintown`, creates or updates the
personal marketplace at `~/.agents/plugins/marketplace.json`, and runs
`codex plugin add goblintown@personal` so Codex installs and enables it.

For local checkout testing, point the installed plugin at the current built CLI
instead of npm latest:

```bash
npm install
npm run build
node dist/cli.js plugin install --local-mcp
```

Restart Codex after installing or updating the plugin so the composer menu can
load the new plugin cache.

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
- A project Warren wins when the current folder or a parent contains
  `.goblintown/warren.json`.
- If no project Warren exists, MCP uses or creates a Codex-local global Warren
  at `${CODEX_HOME:-$HOME/.codex}/goblintown`, so rites can run from any Codex
  thread.
- To keep a rite, Hoard, and provider settings bound to a specific project, move
  to the project root and run `goblintown init` only after the user agrees or
  explicitly asks.

## Use The MCP Tools

Goblintown exposes these local tools:

- `goblintown_tank`: launch or reuse the local Tank in AI-autopilot mode and
  return the local URL. Call this first when the user invokes the Goblintown
  plugin, asks to open Goblintown, or wants to land in the Tank.
- `goblintown_doctor`: setup, cwd, Warren, and install diagnostics.
- `goblintown_provider`: provider, model route, and missing-key status without
  exposing secrets.
- `goblintown_chat`: Single Goblin mode for one direct local model call.
- `goblintown_rite`: configures a full rite for the current harness. By
  default the connected harness executes the model work with its own tokens;
  pass `executionMode: "local_provider"` only when the user has opted into
  spending the configured local provider.
- `goblintown_plan`: configures a planner DAG for the current harness by
  default; pass `executionMode: "local_provider"` only for explicit
  local-provider execution where each node becomes a sub-rite.

When the user selects or calls the Goblintown plugin from Codex, start by
calling `goblintown_tank` so the Tank is visible right away. If the in-app
Browser is available, open the returned `tankUrl` there.

Use `goblintown_doctor` first when setup or cwd is uncertain. Use
`goblintown_provider` before changing model/provider assumptions. Use
`goblintown_chat` for quick local continuity, `goblintown_rite` for pack review
or multi-agent scrutiny, and `goblintown_plan` for complex multi-step work. If
the user says "run a rite" in Codex or another harness, call the tool without
`executionMode` so Goblintown configures the rite and the harness spends its own
tokens. Only opt into `executionMode: "local_provider"` after the user asks for
the local Tank/provider to execute the model calls.

## Autopilot Mode

By default, `goblintown serve` runs in **AI-autopilot** mode. The Tank displays
the full creature diorama (goblins, gremlins, raccoon, troll, ogre, pigeon)
with streaming thinking bubbles, a DAG progress panel, and result cards.

There is no chat input box — the agent controls everything through MCP tools.
When the agent calls `goblintown_rite` or `goblintown_plan` with
`executionMode: "local_provider"`, the Tank streams the rite live and renders
the output. In default harness mode, the Tank remains available for setup,
history, and inspection while the connected harness carries the token spend.

To restore the legacy chat surface, use:

```bash
goblintown serve --chat
```

## Troubleshooting

- Missing API key: only matters for `goblintown_chat` or explicit
  `executionMode: "local_provider"` rite/plan runs. Configure the provider in
  the Tank's Settings > API panel or set the provider env var, then rerun
  `goblintown mcp --doctor`.
- Wrong directory: MCP inherits Codex's working directory, but falls back to the
  Codex-local global Warren when no project Warren exists. Point Codex at a
  project root or initialize a project Warren when project-local memory matters.
- Stale package: run `npm view goblintown@latest version dist-tags --json`, then
  use `goblintown@latest` unless the user requests a pinned version.
- Tank not responding: the Tank runs on `http://localhost:7777` by default.
  Only local-provider rites/plans started via MCP need the Tank to stream live
  execution.
