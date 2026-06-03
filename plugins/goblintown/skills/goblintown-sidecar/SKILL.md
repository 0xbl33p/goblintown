---
name: goblintown-sidecar
description: Use when the user wants Codex to install, register, verify, configure, or use Goblintown as a local Codex MCP sidecar or composer extension for Single Goblin calls, full rites, planner DAGs, provider checks, or Tank-backed local Warren workflows.
---

# Goblintown Codex Plugin 1.0

Goblintown Codex Plugin 1.0 is the Codex front-end adapter for Goblintown, an
agent-first, model-augmentable orchestration tool compatible with most front
ends. In this plugin it is exposed through the local `goblintown` MCP server
plus a skill that tells Codex when and how to use it. The default experience is
the Tank in AI-autopilot mode: Codex drives the local app through MCP while the
Tank shows setup, live runs, and history.

The desktop installers are a separate distribution named **Goblintown Desktop
Beta 0.1**. The upcoming ChatGPT integration should be named **Goblintown
ChatGPT App 1.0**. Future harness packages should use the same pattern:
**Goblintown <Host> App/Plugin <major.minor>**.

Policy links for the Codex plugin listing and review:

- Privacy Policy: https://goblintown-mcp.vercel.app/privacy.html
- Terms of Service: https://goblintown-mcp.vercel.app/terms.html

## Consent Rules

Safe inspection can run without asking when the user has already requested
Goblintown work:

- `goblintown_doctor`
- `goblintown_provider`
- `goblintown mcp --doctor`
- `goblintown mcp --config-snippet`

Ask before changing the user's machine or local data unless they explicitly
requested that exact setup action:

- `goblintown install`
- `goblintown plugin install`
- `goblintown skill install`
- `goblintown mcp --install-codex`
- `goblintown init`
- importing chats, scanning personal folders, or vectorizing stored records
- changing provider routes, stored API keys, voice settings, or model choices

Running a local-provider rite or planner DAG can spend provider tokens. If the
user asks for a rite, planner run, Single Goblin call, or Goblintown answer,
proceed. By default, rites and plans configure work for the current harness and
use harness tokens. Only pass `executionMode: "local_provider"` after the user
opts into local Tank/provider execution. If Goblintown is only optional for a
normal Codex task, ask once before using it.

## Simple Install

For a complete Goblintown Codex Plugin 1.0 setup, use the one-command installer:

```bash
npx -y goblintown@latest install
```

This creates or finds a Warren, installs the MCP config, installs this skill,
installs and enables the composer plugin, and starts the Tank in AI-autopilot
mode at `http://localhost:7777`.

Skip the server with `--no-serve`:

```bash
npx -y goblintown@latest install --no-serve
```

## Install Or Update

For the composer `+` menu, install the plugin/extension:

```bash
npx -y goblintown@latest plugin install
```

This copies the plugin to `~/plugins/goblintown`, adds it to the personal
marketplace at `~/.agents/plugins/marketplace.json`, and runs
`codex plugin add goblintown@personal` so Codex installs and enables it.

For classic skill plus MCP config installation:

```bash
npx -y goblintown@latest skill install
npx -y goblintown@latest mcp --install-codex
npx -y goblintown@latest mcp --doctor
```

For local checkout testing, build first and install the extension with the
local MCP command stamped into the copied plugin:

```bash
npm install
npm run build
node dist/cli.js plugin install --local-mcp
```

Restart Codex after installing or updating plugin, skill, or MCP config so the
composer menu loads the new plugin cache.

## Usage

Use `goblintown_doctor` first when setup is uncertain. Interpret
`projectReady: false` carefully: the command may be running from a wrapper
folder without a Warren. If a project has `.goblintown/warren.json`, use that
project root. Otherwise Goblintown uses or creates the Codex-local global Warren
at `${CODEX_HOME:-$HOME/.codex}/goblintown`, so rites can run from any thread.

The default UI is the Tank in AI-autopilot mode. The agent drives it through MCP:

- `goblintown_tank` to launch or reuse the local Tank and return its URL
- `goblintown_chat` for Single Goblin calls
- `goblintown_rite` to configure a full rite for harness-token execution by
  default
- `goblintown_plan` to configure planner DAG execution by default
- `goblintown_provider` for provider/model route snapshots
- `goblintown_doctor` for setup diagnostics

When the user selects or calls the Goblintown plugin, call `goblintown_tank`
first so they land in the Tank right away. If the in-app Browser is available,
open the returned `tankUrl` there. When a rite or plan is run with
`executionMode: "local_provider"`, Goblintown launches or reuses the local Tank
and returns a Tank URL plus run id.
