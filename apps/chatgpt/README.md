# Goblintown ChatGPT App 1.0

Goblintown ChatGPT App 1.0 is the ChatGPT front-end adapter for the shared
Goblintown orchestration core. It exposes a Streamable HTTP MCP endpoint at
`/mcp`, advertises the existing Goblintown tool surface with ChatGPT Apps SDK
metadata, and serves a Tank widget resource at `ui://goblintown/tank-v2.html`.

This adapter is a dev preview. It is ready for local Developer Mode and tunnel
testing, and the repository now includes the hosted Vercel shape needed for a
stable production MCP URL. Marketplace approval still requires review.

Policy links for ChatGPT app setup and review:

- Privacy Policy: https://goblintown-mcp.vercel.app/privacy.html
- Terms of Service: https://goblintown-mcp.vercel.app/terms.html

## Run

Easy installer:

```bash
npx -y goblintown@latest chatgpt install
```

That command now defaults to the stable hosted MCP endpoint:

```text
https://goblintown-mcp.vercel.app/mcp
```

It keeps the legacy local adapter flow available for debugging, but by default you
no longer need to refresh a new public tunnel URL each run.

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

Verify the full local Tank plus public MCP path after starting a tunnel:

```bash
npm run verify:chatgpt -- --mcp-url https://example-tunnel.example.com/mcp
```

If local DNS has cached a fresh quick-tunnel miss, verify through the local
adapter while still checking the public widget URL:

```bash
npm run verify:chatgpt -- --mcp-url https://example-tunnel.example.com/mcp --connect-url http://127.0.0.1:8787/mcp
```

Recover or start the local Tank, quick tunnel, and verifier in one command:

```bash
npm run ensure:chatgpt
```

## Deploy on Vercel

The repository includes a Vercel-ready hosted adapter:

- `vercel.json` rewrites traffic to the serverless Express handler.
- `api/index.js` loads the built handler from `dist/vercel.js`.
- `src/vercel.ts` starts hosted mode, which is safe for ChatGPT and Codex over
  a stable public URL.

Set the production URL before deploying:

```bash
vercel env add GOBLINTOWN_CHATGPT_PUBLIC_BASE_URL production
# value: https://goblintown-mcp.vercel.app

vercel --prod
```

The production MCP URL is:

```text
https://goblintown-mcp.vercel.app/mcp
```

Verify the built Vercel entrypoint locally:

```bash
npm run build
npm run verify:vercel
```

Hosted mode can serve ChatGPT tool metadata, the widget resource, and
Codex-compatible MCP tools from a stable URL. It does not launch a local Tank or
read local files. Board execution returns Goblintown's existing logic-gate
packet for ChatGPT to execute as the host model, so OpenAI-model work does not
require `OPENAI_API_KEY` on the deployment. Use the local Codex plugin or local
`chatgpt install` path when the user explicitly wants local files,
`localhost:7777`, local provider spend, or the Tank run UI.

Codex can use the same hosted MCP endpoint:

```toml
[mcp_servers.goblintown_hosted]
url = "https://goblintown-mcp.vercel.app/mcp"
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

Hosted production exposes `goblintown_tank`, `goblintown_rite`,
`goblintown_plan`, `goblintown_provider`, and `goblintown_doctor`. It does not
advertise local Single Goblin, and it rejects `executionMode: "local_provider"`
because the Tank UI is a local adapter path.

Local Developer Mode exposes the full local adapter surface:

- `goblintown_tank` opens or reuses the local Tank.
- `goblintown_chat` returns a Single Goblin packet for ChatGPT to execute as the
  host model.
- `goblintown_rite` and `goblintown_plan` return real Goblintown board packets by
  default. The loop still defines the gates; ChatGPT performs OpenAI-model
  slots after the tool returns, so no OpenAI API key is required for the
  ChatGPT app.
- Use `executionMode: "local_provider"` only when the user explicitly chooses
  the local Tank run UI or configured local/provider spend.
- `goblintown_provider` and `goblintown_doctor` expose setup state without
  leaking secrets.

## Environment

| Variable | Purpose |
| --- | --- |
| `GOBLINTOWN_CHATGPT_PORT` | Local adapter port, default `8787`. |
| `GOBLINTOWN_CHATGPT_HOST` | Bind host, default `127.0.0.1`. |
| `GOBLINTOWN_CHATGPT_ALLOWED_HOSTS` | Comma-separated extra Host headers for tunnels/deployments. |
