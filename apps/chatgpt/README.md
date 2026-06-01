# Goblintown ChatGPT App 1.0

Goblintown ChatGPT App 1.0 is the ChatGPT front-end adapter for the shared
Goblintown orchestration core. It exposes a Streamable HTTP MCP endpoint at
`/mcp`, advertises the existing Goblintown tool surface with ChatGPT Apps SDK
metadata, and serves a Tank widget resource at `ui://goblintown/tank.html`.

This adapter is a dev preview. It is ready for local Developer Mode and tunnel
testing, but it is not a hosted marketplace submission package yet.

## Run

Easy installer:

```bash
npx -y goblintown@latest chatgpt install
```

That command starts the local adapter, opens the walkthrough page, creates a
quick HTTPS tunnel for ChatGPT, and prints the `/mcp` URL to paste into ChatGPT
Developer Mode. Keep the terminal open while using the app.

Local development:

```bash
npm run build
node dist/cli.js chatgpt serve --port 8787
```

Or, from an installed package:

```bash
goblintown chatgpt serve --port 8787
```

The health endpoint prints the MCP URL and available tools:

```bash
curl http://127.0.0.1:8787/healthz
```

## Use With ChatGPT Developer Mode

ChatGPT needs an HTTPS URL it can reach. Start the adapter locally, expose it
with your tunnel or deployment of choice, then pass that public base URL:

```bash
goblintown chatgpt serve \
  --port 8787 \
  --public-base-url https://example-tunnel.example.com \
  --allowed-host example-tunnel.example.com
```

Register the MCP endpoint in ChatGPT Developer Mode:

```text
https://example-tunnel.example.com/mcp
```

The adapter automatically allows the host from `--public-base-url`; repeat
`--allowed-host` or set `GOBLINTOWN_CHATGPT_ALLOWED_HOSTS` when your tunnel
sends a different Host header.

To skip the automatic tunnel during the easy installer:

```bash
goblintown chatgpt install --no-tunnel --public-base-url https://your-host.example
```

## Tool Semantics

- `goblintown_tank` opens or reuses the local Tank.
- `goblintown_chat` runs Single Goblin through the configured local provider.
- `goblintown_rite` and `goblintown_plan` configure work for the ChatGPT
  harness by default, so ChatGPT spends its own model tokens.
- Use `executionMode: "local_provider"` only when the user explicitly chooses
  local provider execution.
- `goblintown_provider` and `goblintown_doctor` expose setup state without
  leaking secrets.

## Environment

| Variable | Purpose |
| --- | --- |
| `GOBLINTOWN_CHATGPT_PORT` | Local adapter port, default `8787`. |
| `GOBLINTOWN_CHATGPT_HOST` | Bind host, default `127.0.0.1`. |
| `GOBLINTOWN_CHATGPT_ALLOWED_HOSTS` | Comma-separated extra Host headers for tunnels/deployments. |
