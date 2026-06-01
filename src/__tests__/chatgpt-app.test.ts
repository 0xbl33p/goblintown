import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  defaultChatGptAllowedHosts,
  defaultChatGptAppHost,
  defaultChatGptAppPort,
  startGoblintownChatGptApp,
  startGoblintownChatGptQuickTunnel,
} from "../chatgpt-app.js";
import {
  GOBLINTOWN_CHATGPT_WIDGET_URI,
  buildGoblintownMcpTools,
} from "../mcp.js";

describe("Goblintown ChatGPT App", () => {
  it("reads adapter defaults from environment", () => {
    assert.equal(defaultChatGptAppPort({ GOBLINTOWN_CHATGPT_PORT: "9999" }), 9999);
    assert.equal(defaultChatGptAppPort({ PORT: "7777" }), 7777);
    assert.equal(defaultChatGptAppPort({ GOBLINTOWN_CHATGPT_PORT: "nope" }), 8787);
    assert.equal(defaultChatGptAppHost({ GOBLINTOWN_CHATGPT_HOST: "0.0.0.0" }), "0.0.0.0");
    assert.deepEqual(defaultChatGptAllowedHosts({
      GOBLINTOWN_CHATGPT_ALLOWED_HOSTS: "example.ngrok.app, app.example.com:443",
    }), ["example.ngrok.app", "app.example.com:443"]);
  });

  it("decorates the shared tool surface with ChatGPT Apps SDK metadata", () => {
    const tools = buildGoblintownMcpTools({ chatgptApp: true });
    const tank = tools.find((tool) => tool.name === "goblintown_tank");
    const rite = tools.find((tool) => tool.name === "goblintown_rite");

    assert.ok(tank);
    assert.ok(rite);
    assert.equal(tank._meta?.["openai/outputTemplate"], GOBLINTOWN_CHATGPT_WIDGET_URI);
    assert.equal(tank._meta?.["openai/widgetAccessible"], true);
    assert.deepEqual(tank._meta?.securitySchemes, [{ type: "noauth" }]);
    assert.equal((tank._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, GOBLINTOWN_CHATGPT_WIDGET_URI);
    assert.match(String(rite.description), /host harness/);
  });

  it("serves health, tools, and the Tank widget over Streamable HTTP MCP", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "goblintown-chatgpt-app-"));
    const handle = await startGoblintownChatGptApp({
      cwd: tmp,
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const health = await fetch(handle.healthUrl).then((res) => res.json()) as {
        ok: boolean;
        mcpUrl: string;
        widgetUri: string;
        tools: string[];
      };
      assert.equal(health.ok, true);
      assert.equal(health.mcpUrl, handle.mcpUrl);
      assert.equal(health.widgetUri, GOBLINTOWN_CHATGPT_WIDGET_URI);
      assert.ok(health.tools.includes("goblintown_tank"));

      const client = new Client(
        { name: "goblintown-chatgpt-app-test", version: "0.0.0" },
        { capabilities: {} },
      );
      const transport = new StreamableHTTPClientTransport(new URL(handle.mcpUrl));
      await client.connect(transport);
      try {
        const listedTools = await client.listTools();
        const tank = listedTools.tools.find((tool) => tool.name === "goblintown_tank");
        assert.ok(tank);
        assert.equal(tank._meta?.["openai/outputTemplate"], GOBLINTOWN_CHATGPT_WIDGET_URI);
        assert.equal((tank._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, GOBLINTOWN_CHATGPT_WIDGET_URI);

        const resources = await client.listResources();
        assert.ok(resources.resources.some((resource) => resource.uri === GOBLINTOWN_CHATGPT_WIDGET_URI));

        const resource = await client.readResource({ uri: GOBLINTOWN_CHATGPT_WIDGET_URI });
        const content = resource.contents[0];
        assert.equal(content.mimeType, "text/html");
        assert.equal(content.uri, GOBLINTOWN_CHATGPT_WIDGET_URI);
        assert.ok("text" in content);
        assert.match("text" in content ? content.text : "", /window\.openai/);
        assert.match("text" in content ? content.text : "", /goblintown_tank/);
      } finally {
        await client.close();
      }
    } finally {
      await handle.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("parses the quick tunnel URL from a tunnel process", async () => {
    const tunnel = await startGoblintownChatGptQuickTunnel("http://127.0.0.1:8787", {
      command: process.execPath,
      args: [
        "--input-type=module",
        "--eval",
        "console.error('Your quick tunnel is https://easy-chatgpt.example.com'); setInterval(() => {}, 1000);",
      ],
      timeoutMs: 5000,
    });
    try {
      assert.equal(tunnel.url, "https://easy-chatgpt.example.com");
      assert.equal(tunnel.mcpUrl, "https://easy-chatgpt.example.com/mcp");
    } finally {
      await tunnel.close();
    }
  });
});
