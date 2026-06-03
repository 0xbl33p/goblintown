# Goblintown Distributions

Goblintown is an agent-first, model-augmentable orchestration tool compatible
with most front ends. Each host surface is a distribution: the npm package can
carry shared code, but the product version belongs to the adapter the user
installs.

| Distribution | Version | Status | What ships |
| --- | --- | --- | --- |
| Goblintown Codex Plugin | 1.0 | Current | Codex composer plugin, `goblintown-sidecar` skill, local stdio MCP, AI-autopilot Tank handoff |
| Goblintown Desktop | Beta 0.1 | Shipped | macOS DMGs, Windows installers, Linux AppImages from the historical `v0.7.0-beta.1` release assets |
| Goblintown ChatGPT App | 1.0 | Dev preview | ChatGPT Apps SDK adapter, Streamable HTTP `/mcp`, and Tank widget resource |
| Goblintown Hermes App | TBD | Planned | Host adapter for Hermes |
| Goblintown Opencode App | TBD | Planned | Host adapter for Opencode |
| Goblintown OpenGPT App | TBD | Planned | Host adapter for OpenGPT |
| Goblintown Claude Code App | TBD | Planned | Host adapter for Claude Code |

## Adapter Rules

- The agent/orchestration core owns planning, tool routing, local runs, memory,
  artifacts, and Tank handoff.
- Each front-end adapter owns installation, host-specific UX, and how the host
  invokes the shared tool surface.
- Rite and plan tools configure work for the connected host by default, so the
  host front end spends its own model tokens unless the user explicitly chooses
  local-provider execution.
- Keep the Tank available as the shared visual control room across adapters.

## Naming Rules

- Use `Goblintown <Host> Plugin` when the host installs a plugin or composer
  extension.
- Use `Goblintown <Host> App` when the host installs an app, connector, or
  hosted/remote integration.
- Keep desktop separate as `Goblintown Desktop Beta <version>` until signed,
  broad end-user installers become the stable desktop line.
- Do not use old asset filenames as product names. For example,
  `v0.7.0-beta.1` is the historical GitHub tag for the Desktop Beta 0.1
  installer bytes, not the distribution name.
- Do not use the shared npm package version as the user-facing product name
  when the release is really a host adapter. The Codex plugin manifest owns
  `1.0.0`; desktop installer assets keep their historical filenames.

## Release Notes

Codex Plugin 1.0 is the current front-end adapter. It starts by opening or
reusing the Tank through `goblintown_tank`; rite and plan tools configure work
for the connected host by default and only spend local provider tokens when the
user opts into `executionMode: "local_provider"`.

Desktop Beta 0.1 is the shipped unsigned desktop artifact set. The filenames
and GitHub release tag still contain `0.7.0-beta.1` so old links and checksums
continue to work.

ChatGPT App 1.0 is the current dev preview for ChatGPT Developer Mode. It
reuses the Codex Plugin 1.0 tool semantics, exposes a Streamable HTTP MCP
endpoint at `/mcp`, serves the Tank widget resource at
`ui://goblintown/tank-v2.html`, uses the host front end's model tokens by default,
and makes local-provider execution explicit. The tepid-friendly installer is
`npx -y goblintown@latest chatgpt install`; it starts the adapter, opens the
walkthrough, creates a quick HTTPS tunnel, and prints the MCP URL to paste into
ChatGPT Developer Mode.

The production-ready hosted shape targets Vercel with a stable MCP URL:
`https://goblintown-mcp.vercel.app/mcp`. That hosted endpoint is safe for ChatGPT and
Codex because it serves the Streamable HTTP MCP contract without attempting to
open `localhost:7777`, run local Single Goblin, or spend local provider tokens.
Local Tank and local-file workflows remain the job of the Codex plugin or the
local ChatGPT dev adapter.
