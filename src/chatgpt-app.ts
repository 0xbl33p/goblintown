import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  buildGoblintownMcpTools,
  createGoblintownMcpServer,
  GOBLINTOWN_CHATGPT_WIDGET_URI,
} from "./mcp.js";

export interface GoblintownChatGptAppOptions {
  cwd?: string;
  host?: string;
  port?: number;
  allowedHosts?: string[];
  publicBaseUrl?: string;
}

export interface GoblintownChatGptAppHandle {
  url: string;
  mcpUrl: string;
  healthUrl: string;
  host: string;
  port: number;
  server: HttpServer;
  setPublicBaseUrl(url: string): void;
  close(): Promise<void>;
}

export interface GoblintownChatGptQuickTunnelOptions {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface GoblintownChatGptQuickTunnelHandle {
  url: string;
  mcpUrl: string;
  close(): Promise<void>;
}

export function defaultChatGptAppPort(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.GOBLINTOWN_CHATGPT_PORT ?? env.PORT ?? 8787);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8787;
}

export function defaultChatGptAppHost(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.GOBLINTOWN_CHATGPT_HOST?.trim() || "127.0.0.1";
}

export function defaultChatGptAllowedHosts(
  env: Record<string, string | undefined> = process.env,
): string[] | undefined {
  const raw = env.GOBLINTOWN_CHATGPT_ALLOWED_HOSTS;
  if (!raw) return undefined;
  const hosts = raw
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

export async function startGoblintownChatGptApp(
  opts: GoblintownChatGptAppOptions = {},
): Promise<GoblintownChatGptAppHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const host = opts.host ?? defaultChatGptAppHost();
  const port = opts.port ?? defaultChatGptAppPort();
  const allowedHosts = normalizeAllowedHosts([
    ...(opts.allowedHosts ?? defaultChatGptAllowedHosts() ?? []),
    publicBaseHostname(opts.publicBaseUrl),
  ]);
  const app = createMcpExpressApp({ host, allowedHosts });
  let baseUrl = "";

  app.get("/", (_req, res) => {
    res.type("html").send(renderLandingPage(baseUrl));
  });

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "Goblintown ChatGPT App",
      version: "1.0-dev",
      mcpUrl: `${baseUrl}/mcp`,
      widgetUri: GOBLINTOWN_CHATGPT_WIDGET_URI,
      tools: buildGoblintownMcpTools({ chatgptApp: true }).map((tool) => tool.name),
      notes: [
        "Use an HTTPS tunnel or deployment URL for ChatGPT Developer Mode.",
        "Rites and plans default to ChatGPT harness-token execution.",
      ],
    });
  });

  app.post("/mcp", async (req, res) => {
    const mcpServer = createGoblintownMcpServer({ cwd, chatgptApp: true });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Stateless endpoint has no session to terminate." },
      id: null,
    });
  });

  const server = await listen(app, port, host);
  const actual = actualPort(server);
  baseUrl = publicBaseUrl(opts.publicBaseUrl, host, actual);
  return {
    get url() {
      return baseUrl;
    },
    get mcpUrl() {
      return `${baseUrl}/mcp`;
    },
    get healthUrl() {
      return `${baseUrl}/healthz`;
    },
    host,
    port: actual,
    server,
    setPublicBaseUrl(url: string): void {
      baseUrl = url.replace(/\/+$/u, "");
    },
    close: () => closeServer(server),
  };
}

export async function startGoblintownChatGptQuickTunnel(
  localUrl: string,
  opts: GoblintownChatGptQuickTunnelOptions = {},
): Promise<GoblintownChatGptQuickTunnelHandle> {
  const command = opts.command ?? (process.platform === "win32" ? "npx.cmd" : "npx");
  const args = opts.args ?? [
    "-y",
    "cloudflared@latest",
    "tunnel",
    "--url",
    localUrl.replace(/\/+$/u, ""),
  ];
  const child = spawn(command, args, {
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  const url = await waitForTunnelUrl(child, opts.timeoutMs ?? 45_000);
  return {
    url,
    mcpUrl: `${url}/mcp`,
    close: () => closeChild(child),
  };
}

async function listen(
  app: ReturnType<typeof createMcpExpressApp>,
  port: number,
  host: string,
): Promise<HttpServer> {
  const server = app.listen(port, host);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}

function actualPort(server: HttpServer): number {
  const address = server.address();
  return typeof address === "object" && address ? (address as AddressInfo).port : 0;
}

function publicBaseUrl(publicBaseUrl: string | undefined, host: string, port: number): string {
  if (publicBaseUrl) return publicBaseUrl.replace(/\/+$/u, "");
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  return `http://${displayHost}:${port}`;
}

function publicBaseHostname(publicBaseUrl: string | undefined): string | undefined {
  if (!publicBaseUrl) return undefined;
  try {
    return new URL(publicBaseUrl).hostname;
  } catch {
    return undefined;
  }
}

function normalizeAllowedHosts(hosts: Array<string | undefined>): string[] | undefined {
  const out = Array.from(
    new Set(hosts.map(normalizeAllowedHostname).filter(Boolean) as string[]),
  );
  return out.length > 0 ? out : undefined;
}

function normalizeAllowedHostname(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).hostname;
  } catch {
    try {
      return new URL(`http://${trimmed}`).hostname;
    } catch {
      return trimmed;
    }
  }
}

function waitForTunnelUrl(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Timed out waiting for a public tunnel URL after ${timeoutMs}ms.`));
    }, timeoutMs);
    const finish = (err: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve(url!);
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const match = tunnelUrlFromText(output);
      if (match) finish(null, match);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (err) => finish(err));
    child.once("exit", (code, signal) => {
      if (settled) return;
      finish(new Error(`Tunnel process exited before printing a public URL (code=${code}, signal=${signal}).`));
    });
  });
}

function tunnelUrlFromText(text: string): string | undefined {
  const match = /https:\/\/[^\s'"<>]+/iu.exec(text);
  if (!match) return undefined;
  return match[0].replace(/[),.;]+$/u, "").replace(/\/+$/u, "");
}

function closeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 1500).unref();
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function renderLandingPage(base: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Goblintown ChatGPT App</title>
<style>
  :root { color-scheme: dark; font-family: ui-monospace, Menlo, Consolas, monospace; }
  body { margin: 0; background: #0d1410; color: #d8efb6; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 20px; display: grid; gap: 18px; }
  h1 { margin: 0; font-size: 28px; }
  p, li { color: #b9d3a8; line-height: 1.55; }
  code { background: #0a0e08; color: #c2f37a; padding: 2px 5px; }
</style>
</head>
<body>
<main>
  <h1>Goblintown ChatGPT App 1.0 dev adapter</h1>
  <p>Use this MCP URL in ChatGPT Developer Mode:</p>
  <p><code>${escapeHtml(`${base}/mcp`)}</code></p>
  <ul>
    <li>The endpoint is Streamable HTTP MCP.</li>
    <li>The Tank widget resource is <code>${GOBLINTOWN_CHATGPT_WIDGET_URI}</code>.</li>
    <li>Rites and plans default to ChatGPT harness-token execution.</li>
  </ul>
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}
