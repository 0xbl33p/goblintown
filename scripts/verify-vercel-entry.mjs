#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.GOBLINTOWN_CHATGPT_PUBLIC_BASE_URL =
  process.env.GOBLINTOWN_CHATGPT_PUBLIC_BASE_URL || "https://goblintown-mcp.vercel.app";
process.env.VERCEL_URL = process.env.VERCEL_URL || "goblintown-vercel-test.vercel.app";
process.env.GOBLINTOWN_CHATGPT_ALLOWED_HOSTS =
  process.env.GOBLINTOWN_CHATGPT_ALLOWED_HOSTS || "127.0.0.1,localhost";

const { default: app } = await import("../dist/vercel.js");
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

const address = server.address();
const localBaseUrl = `http://127.0.0.1:${address.port}`;
const mcpUrl = `${localBaseUrl}/mcp`;

try {
  const health = await fetch(`${localBaseUrl}/healthz`).then((res) => res.json());
  assert.equal(health.ok, true);
  assert.equal(health.mode, "hosted");
  assert.equal(health.mcpUrl, "https://goblintown-mcp.vercel.app/mcp");
  assert.equal(health.widgetUri, "ui://goblintown/tank-v2.html");
  assert.ok(health.tools.includes("goblintown_rite"));
  assert.ok(!health.tools.includes("goblintown_chat"));

  const browserGet = await fetch(mcpUrl, { headers: { Accept: "text/html" } });
  assert.equal(browserGet.status, 405);
  assert.equal(browserGet.headers.get("allow"), "POST");
  assert.match(await browserGet.text(), /https:\/\/goblintown-mcp\.vercel\.app\/mcp/);

  const landingPage = await fetch(localBaseUrl).then((res) => res.text());
  assert.match(landingPage, /https:\/\/goblintown-mcp\.vercel\.app\/privacy\.html/);
  assert.match(landingPage, /https:\/\/goblintown-mcp\.vercel\.app\/terms\.html/);

  const privacyPage = await fetch(`${localBaseUrl}/privacy.html`);
  assert.equal(privacyPage.status, 200);
  assert.match(await privacyPage.text(), /Privacy Policy/);

  const termsPage = await fetch(`${localBaseUrl}/terms.html`);
  assert.equal(termsPage.status, 200);
  assert.match(await termsPage.text(), /Terms of Service/);

  const client = new Client(
    { name: "goblintown-vercel-entry-verifier", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  try {
    const tank = await client.callTool({ name: "goblintown_tank", arguments: {} });
    assert.equal(tank.structuredContent?.tankUrl, "https://goblintown-mcp.vercel.app");
    assert.equal(tank.structuredContent?.hosted, true);
    assert.equal(tank.structuredContent?.externalLaunchAvailable, false);
    assert.equal(tank.structuredContent?.openAction, "chatgpt_widget");
    assert.equal(tank.structuredContent?.serverStarted, false);

    const hostedRite = await client.callTool({
      name: "goblintown_rite",
      arguments: {
        task: "verify hosted ChatGPT key policy",
        packSize: 1,
        noFallback: true,
        noSpecialist: true,
      },
    });
    assert.equal(hostedRite.isError ?? false, false);
    assert.equal(hostedRite.structuredContent?.runMode, "chatgpt");
    assert.equal(hostedRite.structuredContent?.tokenPolicy?.default, "chatgpt_host");
    assert.equal(hostedRite.structuredContent?.hostRun?.openAiApiKeyRequired, false);

    const localProvider = await client.callTool({
      name: "goblintown_rite",
      arguments: {
        task: "try to spend local provider tokens",
        executionMode: "local_provider",
      },
    });
    assert.equal(localProvider.isError, true);
    assert.match(localProvider.content?.[0]?.text ?? "", /local_provider execution is disabled in the ChatGPT app/);

    const widget = await client.readResource({ uri: "ui://goblintown/tank-v2.html" });
    const content = widget.contents?.[0];
    assert.equal(content?.mimeType, "text/html;profile=mcp-app");
    const widgetDomain = content?._meta?.ui?.domain ?? content?._meta?.["openai/widgetDomain"];
    assert.equal(widgetDomain, "https://goblintown-mcp.vercel.app");
    assert.deepEqual(content?._meta?.["openai/widgetCSP"]?.redirect_domains, [
      "https://goblintown-mcp.vercel.app",
    ]);
  } finally {
    await client.close();
  }

  console.log(JSON.stringify({
    ok: true,
    localBaseUrl,
    productionMcpUrl: "https://goblintown-mcp.vercel.app/mcp",
  }, null, 2));
} finally {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
