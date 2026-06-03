#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const LOCAL_REQUIRED_TOOLS = [
  "goblintown_tank",
  "goblintown_chat",
  "goblintown_rite",
  "goblintown_plan",
  "goblintown_provider",
  "goblintown_doctor",
];
const HOSTED_REQUIRED_TOOLS = [
  "goblintown_tank",
  "goblintown_rite",
  "goblintown_plan",
  "goblintown_provider",
  "goblintown_doctor",
];
const WIDGET_URI = "ui://goblintown/tank-v2.html";
const WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

const args = parseArgs(process.argv.slice(2));
const mcpUrl = requiredArg(args, "mcp-url");
const mcpConnectUrl = args["connect-url"] ?? mcpUrl;
const tankUrl = normalizeBaseUrl(args["tank-url"] ?? "http://127.0.0.1:7777");
const expectedWarrenRoot = resolve(args["warren-root"] ?? process.cwd());
const publicBaseUrl = normalizeBaseUrl(new URL("..", mcpUrl).toString());
let hostedMode = false;

const health = await verifyHttpSurface();
hostedMode = health.mode === "hosted";
if (!hostedMode) await verifyTankIdentity();
await verifyMcpSurface();

async function verifyTankIdentity() {
  const identityUrl = new URL("/api/identity", tankUrl);
  const response = await fetch(identityUrl);
  assert.equal(response.status, 200, `${identityUrl} should return 200`);
  const identity = await response.json();
  assert.equal(identity.ok, true, "Tank identity should be ok");
  assert.equal(resolve(String(identity.root)), expectedWarrenRoot, "Tank Warren root mismatch");
  assert.equal(identity.scope, "project", "Tank should use the project Warren");
  assert.equal(identity.autopilot, true, "Tank should run in autopilot mode");
}

async function verifyHttpSurface() {
  const healthUrl = new URL("/healthz", publicBaseUrl);
  const health = await requestJson(healthUrl);
  assert.equal(health.ok, true, "ChatGPT adapter health should be ok");
  assert.equal(health.mcpUrl, mcpUrl, "Health response should report the current MCP URL");
  const requiredTools = health.mode === "hosted" ? HOSTED_REQUIRED_TOOLS : LOCAL_REQUIRED_TOOLS;
  for (const tool of requiredTools) {
    assert.ok(health.tools?.includes(tool), `Health response should list ${tool}`);
  }
  if (health.mode === "hosted") {
    assert.ok(!health.tools?.includes("goblintown_chat"), "Hosted health should not list local-only goblintown_chat");
  }

  const htmlGet = await requestText(mcpUrl, { headers: { Accept: "text/html" } });
  const html = htmlGet.body;
  assert.equal(htmlGet.status, 405, "Browser GET /mcp should remain method-not-allowed");
  assert.equal(htmlGet.headers.get("allow"), "POST", "GET /mcp should advertise Allow: POST");
  assert.match(htmlGet.headers.get("content-type") ?? "", /text\/html/);
  assert.match(html, /Paste this URL into ChatGPT Developer Mode/);
  assert.match(html, new RegExp(escapeRegExp(mcpUrl)));

  const jsonGet = await requestText(mcpUrl, { headers: { Accept: "application/json" } });
  const json = JSON.parse(jsonGet.body);
  assert.equal(jsonGet.status, 405, "JSON GET /mcp should remain method-not-allowed");
  assert.equal(jsonGet.headers.get("allow"), "POST", "JSON GET /mcp should advertise Allow: POST");
  assert.equal(json.error?.message, "Method not allowed. Use POST /mcp.");
  return health;
}

async function verifyMcpSurface() {
  const client = new Client(
    { name: "goblintown-chatgpt-app-verifier", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpConnectUrl)));
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    const requiredTools = hostedMode ? HOSTED_REQUIRED_TOOLS : LOCAL_REQUIRED_TOOLS;
    for (const tool of requiredTools) {
      assert.ok(toolNames.includes(tool), `MCP listTools should include ${tool}`);
    }
    if (hostedMode) {
      assert.ok(!toolNames.includes("goblintown_chat"), "Hosted MCP listTools should not include local-only goblintown_chat");
    }

    const tank = await client.callTool({ name: "goblintown_tank", arguments: {} });
    if (hostedMode) {
      assert.equal(tank.structuredContent?.tankUrl, publicBaseUrl);
      assert.equal(tank.structuredContent?.hosted, true);
      assert.equal(tank.structuredContent?.externalLaunchAvailable, false);
      assert.equal(tank.structuredContent?.openAction, "chatgpt_widget");
    } else {
      assert.equal(tank.structuredContent?.tankUrl, "http://localhost:7777/");
      assert.equal(resolve(String(tank.structuredContent?.warrenRoot)), expectedWarrenRoot);
      assert.equal(tank.structuredContent?.warrenScope, "project");
    }

    const widget = await client.readResource({ uri: WIDGET_URI });
    const content = widget.contents?.[0];
    assert.equal(content?.uri, WIDGET_URI);
    assert.equal(content?.mimeType, WIDGET_MIME_TYPE);
    const widgetDomain = content?._meta?.ui?.domain ?? content?._meta?.["openai/widgetDomain"];
    assert.equal(widgetDomain, publicBaseUrl);
    const html = String(content?.text ?? "");
    assert.match(html, /callTool\("goblintown_tank", \{\}\)/);
    verifyWidgetHtml(html);
    if (!hostedMode) assert.match(html, /openExternal/);

    console.log(JSON.stringify({
      ok: true,
      mcpUrl,
      mcpConnectUrl,
      publicBaseUrl,
      hostedMode,
      ...(hostedMode ? {} : { tankUrl, warrenRoot: expectedWarrenRoot }),
      toolNames,
      widgetDomain,
    }, null, 2));
  } finally {
    await client.close();
  }
}

async function requestJson(url, init) {
  return JSON.parse((await requestText(url, init)).body);
}

async function requestText(url, init = {}) {
  try {
    const response = await fetch(url, init);
    return {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
    };
  } catch (err) {
    if (!isDnsFailure(err)) throw err;
    return requestTextWithResolvedHost(url, init);
  }
}

async function requestTextWithResolvedHost(url, init = {}) {
  const parsed = new URL(url);
  const ip = await resolvePublicDns(parsed.hostname);
  const args = [
    "-sS",
    "-D",
    "-",
    "--resolve",
    `${parsed.hostname}:443:${ip}`,
  ];
  const headers = init.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  args.push(url);
  const { stdout } = await execFileP("curl", args);
  const parts = stdout.split(/\r?\n\r?\n/u);
  const headerText = parts.shift() ?? "";
  const body = parts.join("\n\n");
  const status = Number(/HTTP\/\S+\s+(\d+)/u.exec(headerText)?.[1] ?? 0);
  const map = new Map();
  for (const line of headerText.split(/\r?\n/u).slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) map.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return {
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    body,
  };
}

async function resolvePublicDns(hostname) {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    { headers: { Accept: "application/dns-json" } },
  );
  const body = await response.json();
  const answer = body.Answer?.find((entry) => entry.type === 1 && typeof entry.data === "string");
  if (!answer) throw new Error(`Public DNS did not resolve ${hostname}`);
  return answer.data;
}

function isDnsFailure(err) {
  const cause = err?.cause;
  return cause?.code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/i.test(String(err?.message ?? err));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    out[key] = value;
    i += 1;
  }
  return out;
}

function requiredArg(args, key) {
  const value = args[key];
  if (!value) {
    throw new Error(`Missing --${key} <value>`);
  }
  return value;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/u, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function verifyWidgetHtml(html) {
  assert.match(html, /AI Autopilot Tank/, "Widget should preserve the original Tank title");
  assert.match(html, /tank-logo-mark/, "Widget should preserve the original Tank logo mark class");
  assert.match(html, /id="goblin-pile"/, "Widget should preserve the original goblin pile");
  assert.match(html, /id="c-raccoon"/, "Widget should preserve the original raccoon creature id");
  assert.match(html, /id="c-gremlin-sprite"/, "Widget should preserve the original gremlin sprite canvas id");
  assert.match(html, /id="side-raccoon"/, "Widget should preserve original side participant naming");
  assert.match(html, /\bhoard\b/i, "Widget should preserve original Tank hoard scene marker");
  assert.match(html, /<canvas\b/i, "Widget should render sprite frames to canvas");
  assert.match(html, /drawImage\(/, "Widget should animate sprite sheets by drawing frames");
  assert.match(html, /goblin-green-argue\.png/, "Widget should reference original goblin action sheets");
  assert.match(html, /requestDisplayMode/, "Widget should request ChatGPT display expansion for the hosted Tank");
  assert.doesNotMatch(
    html,
    /<img\b[^>]+src=["'][^"']*goblin-[^"']+-(?:argue|defend|go-home|come-out)\.png/iu,
    "Widget should not dump whole goblin sprite sheets as img elements",
  );
  assert.doesNotMatch(
    html,
    /function asset\(name\)\s*\{\s*function asset\(name\)/u,
    "Widget should not contain a duplicated asset helper",
  );
  assert.doesNotMatch(
    html,
    /(?:phase|model|board|invocation)\s+lane/iu,
    "Widget should not use renamed generic lane language instead of the original Tank surface",
  );

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)].map((match) => match[1]);
  assert.ok(scripts.length > 0, "Widget should include executable bridge script");
  for (const [index, script] of scripts.entries()) {
    assert.doesNotThrow(
      () => new Function(script),
      undefined,
      `Widget inline script ${index + 1} should parse`,
    );
  }
}

function execFileP(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...opts, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
