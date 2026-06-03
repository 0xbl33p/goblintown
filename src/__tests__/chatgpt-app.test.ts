import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createGoblintownChatGptExpressApp,
  defaultChatGptAllowedHosts,
  defaultChatGptAppHost,
  defaultChatGptAppPort,
  defaultChatGptPublicBaseUrl,
  startGoblintownChatGptApp,
  startGoblintownChatGptQuickTunnel,
} from "../chatgpt-app.js";
import {
  GOBLINTOWN_CHATGPT_WIDGET_URI,
  GOBLINTOWN_CHATGPT_WIDGET_MIME_TYPE,
  buildGoblintownMcpTools,
} from "../mcp.js";

describe("Goblintown ChatGPT App", () => {
  it("reads adapter defaults from environment", () => {
    assert.equal(defaultChatGptAppPort({ GOBLINTOWN_CHATGPT_PORT: "9999" }), 9999);
    assert.equal(defaultChatGptAppPort({ PORT: "7777" }), 7777);
    assert.equal(defaultChatGptAppPort({ GOBLINTOWN_CHATGPT_PORT: "nope" }), 8787);
    assert.equal(defaultChatGptAppHost({ GOBLINTOWN_CHATGPT_HOST: "0.0.0.0" }), "0.0.0.0");
    assert.equal(defaultChatGptPublicBaseUrl({
      GOBLINTOWN_CHATGPT_PUBLIC_BASE_URL: "goblintown-mcp.vercel.app/",
    }), "https://goblintown-mcp.vercel.app");
    assert.equal(defaultChatGptPublicBaseUrl({
      VERCEL_URL: "goblintown-preview.vercel.app",
    }), "https://goblintown-preview.vercel.app");
    assert.deepEqual(defaultChatGptAllowedHosts({
      GOBLINTOWN_CHATGPT_ALLOWED_HOSTS: "example.ngrok.app, app.example.com:443",
    }), ["example.ngrok.app", "app.example.com:443"]);
  });

  it("decorates the shared tool surface with ChatGPT Apps SDK metadata", () => {
    const tools = buildGoblintownMcpTools({ chatgptApp: true });
    const tank = tools.find((tool) => tool.name === "goblintown_tank");
    const rite = tools.find((tool) => tool.name === "goblintown_rite");
    const plan = tools.find((tool) => tool.name === "goblintown_plan");
    const capabilities = tools.find((tool) => tool.name === "goblintown_capabilities");

    assert.ok(tank);
    assert.ok(rite);
    assert.ok(plan);
    assert.ok(capabilities);
    assert.equal(tank._meta?.["openai/outputTemplate"], GOBLINTOWN_CHATGPT_WIDGET_URI);
    assert.equal(tank._meta?.["openai/widgetAccessible"], true);
    assert.deepEqual(tank._meta?.securitySchemes, [{ type: "noauth" }]);
    assert.equal((tank._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, GOBLINTOWN_CHATGPT_WIDGET_URI);
    assert.match(String(rite.description), /ChatGPT to execute/);
    assert.match(String(rite.description), /does not require OPENAI_API_KEY/);
    const riteSchema = rite.inputSchema as {
      properties?: { executionMode?: { enum?: string[] } };
    };
    const planSchema = plan.inputSchema as {
      properties?: { executionMode?: { enum?: string[] } };
    };
    assert.deepEqual(riteSchema.properties?.executionMode?.enum, ["board"]);
    assert.deepEqual(planSchema.properties?.executionMode?.enum, ["board"]);
    assert.match(String(capabilities.description), /capability map/);
  });

  it("accepts requests for the public base URL after it changes", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "goblintown-chatgpt-host-"));
    const expressHandle = createGoblintownChatGptExpressApp({
      cwd: tmp,
      host: "127.0.0.1",
      allowedHosts: ["127.0.0.1"],
    });
    const server = expressHandle.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert.equal(typeof address, "object");
    const localBaseUrl = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}`;

    try {
      expressHandle.setPublicBaseUrl("https://candidate.example.com");
      const health = await fetch(`${localBaseUrl}/healthz`, {
        headers: { Host: "candidate.example.com" },
      });
      assert.equal(health.status, 200);
      assert.equal((await health.json() as { mcpUrl?: string }).mcpUrl, "https://candidate.example.com/mcp");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await rm(tmp, { recursive: true, force: true });
    }
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

      const landingPage = await fetch(handle.url).then((res) => res.text());
      assert.match(landingPage, new RegExp(escapeRegExp(`${handle.url}/privacy.html`)));
      assert.match(landingPage, new RegExp(escapeRegExp(`${handle.url}/terms.html`)));

      const privacyPage = await fetch(`${handle.url}/privacy.html`);
      assert.equal(privacyPage.status, 200);
      assert.match(await privacyPage.text(), /Privacy Policy/);

      const termsPage = await fetch(`${handle.url}/terms.html`);
      assert.equal(termsPage.status, 200);
      assert.match(await termsPage.text(), /Terms of Service/);

      const dashboardPage = await fetch(`${handle.url}/dashboard.html`);
      assert.equal(dashboardPage.status, 200);
      assert.match(await dashboardPage.text(), /User dashboard/);

      const adminPage = await fetch(`${handle.url}/admin.html`);
      assert.equal(adminPage.status, 200);
      assert.match(await adminPage.text(), /Operator admin/);

      const browserGet = await fetch(handle.mcpUrl, {
        headers: { Accept: "text/html" },
      });
      const browserGetText = await browserGet.text();
      assert.equal(browserGet.status, 405);
      assert.equal(browserGet.headers.get("allow"), "POST");
      assert.match(browserGet.headers.get("content-type") ?? "", /text\/html/);
      assert.match(browserGetText, /Paste this URL into ChatGPT Developer Mode/);
      assert.match(browserGetText, new RegExp(escapeRegExp(handle.mcpUrl)));

      const jsonGet = await fetch(handle.mcpUrl, {
        headers: { Accept: "application/json" },
      });
      const jsonGetBody = await jsonGet.json() as {
        jsonrpc: string;
        error: { code: number; message: string };
        id: null;
      };
      assert.equal(jsonGet.status, 405);
      assert.equal(jsonGet.headers.get("allow"), "POST");
      assert.deepEqual(jsonGetBody, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
        id: null,
      });

      const client = new Client(
        { name: "goblintown-chatgpt-app-test", version: "0.0.0" },
        { capabilities: {} },
      );
      const localMcpUrl = handle.mcpUrl;
      handle.setPublicBaseUrl("https://easy-chatgpt.example.com");
      const transport = new StreamableHTTPClientTransport(new URL(localMcpUrl));
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
        assert.equal(content.mimeType, GOBLINTOWN_CHATGPT_WIDGET_MIME_TYPE);
        assert.equal(content.uri, GOBLINTOWN_CHATGPT_WIDGET_URI);
        const meta = (content as {
          _meta?: {
            ui?: { domain?: string };
            "openai/widgetDomain"?: string;
            "openai/widgetCSP"?: { redirect_domains?: string[] };
          };
        })._meta;
        assert.equal(meta?.ui?.domain, "https://easy-chatgpt.example.com");
        assert.equal(meta?.["openai/widgetDomain"], "https://easy-chatgpt.example.com");
        assert.deepEqual(meta?.["openai/widgetCSP"]?.redirect_domains, [
          "http://localhost:7777",
          "http://127.0.0.1:7777",
        ]);
        assert.ok("text" in content);
        assert.match("text" in content ? content.text : "", /window\.openai/);
        assert.match("text" in content ? content.text : "", /id="hosted-tank"/);
        assert.match("text" in content ? content.text : "", /id="hosted-raccoon"/);
        assert.match("text" in content ? content.text : "", /id="hosted-goblin-pack"/);
        assert.match("text" in content ? content.text : "", /id="hosted-board-flow"/);
        assert.match("text" in content ? content.text : "", /ChatGPT-hosted Tank/);
        assert.match("text" in content ? content.text : "", /goblintown_tank/);
        assert.match("text" in content ? content.text : "", /const result = await bridge\.callTool\("goblintown_tank", \{\}\);/);
        assert.match("text" in content ? content.text : "", /bridge\.openExternal/);
        assert.match("text" in content ? content.text : "", /openTank\(tankState\)/);
        assert.match("text" in content ? content.text : "", /bridge\.requestDisplayMode\(\{ mode: "fullscreen" \}\)/);
        assert.match("text" in content ? content.text : "", /const widgetTemplateUri = "ui:\/\/goblintown\/tank-v2\.html"/);
        assert.match("text" in content ? content.text : "", /bridge\.requestModal\(\{ template: widgetTemplateUri \}\)/);

        const provider = await client.callTool({ name: "goblintown_provider", arguments: {} });
        const providerContent = provider.structuredContent as {
          chatgptApp?: { openAiApiKeyRequired?: boolean; defaultRunner?: string };
        } | undefined;
        assert.equal(provider.isError ?? false, false);
        assert.equal(providerContent?.chatgptApp?.openAiApiKeyRequired, false);
        assert.equal(providerContent?.chatgptApp?.defaultRunner, "chatgpt_host");

        const single = await client.callTool({
          name: "goblintown_chat",
          arguments: {
            prompt: "Reply with exactly OK.",
          },
        });
        const singleContent = single.structuredContent as {
          runMode?: string;
          hostRun?: { openAiApiKeyRequired?: boolean };
        } | undefined;
        const singleText = single.content as Array<{ text?: string }> | undefined;
        assert.equal(single.isError ?? false, false);
        assert.equal(singleContent?.runMode, "chatgpt");
        assert.equal(singleContent?.hostRun?.openAiApiKeyRequired, false);
        assert.match(singleText?.[0]?.text ?? "", /Do not ask for an OpenAI API key/);

        const rite = await client.callTool({
          name: "goblintown_rite",
          arguments: {
            task: "Summarize why host-run mode needs no server OpenAI key.",
            packSize: 1,
            noFallback: true,
            noSpecialist: true,
          },
        });
        const riteContent = rite.structuredContent as {
          runMode?: string;
          tokenPolicy?: { default?: string };
          hostRun?: { openAiApiKeyRequired?: boolean };
        } | undefined;
        const riteText = rite.content as Array<{ text?: string }> | undefined;
        assert.equal(rite.isError ?? false, false);
        assert.equal(riteContent?.runMode, "chatgpt");
        assert.equal(riteContent?.tokenPolicy?.default, "chatgpt_host");
        assert.equal(riteContent?.hostRun?.openAiApiKeyRequired, false);
        assert.match(riteText?.[0]?.text ?? "", /Goblintown ChatGPT-hosted rite packet/);
        assert.match(riteText?.[0]?.text ?? "", /Do not ask for an OpenAI API key/);

        const priorExecutionMode = process.env.GOBLINTOWN_MCP_EXECUTION_MODE;
        process.env.GOBLINTOWN_MCP_EXECUTION_MODE = "local_provider";
        try {
          const envRite = await client.callTool({
            name: "goblintown_rite",
            arguments: {
              task: "Ignore local provider env in ChatGPT app.",
              packSize: 1,
              noFallback: true,
              noSpecialist: true,
            },
          });
          assert.equal(envRite.isError ?? false, false);
          assert.equal((envRite.structuredContent as { runMode?: string } | undefined)?.runMode, "chatgpt");
        } finally {
          if (priorExecutionMode === undefined) delete process.env.GOBLINTOWN_MCP_EXECUTION_MODE;
          else process.env.GOBLINTOWN_MCP_EXECUTION_MODE = priorExecutionMode;
        }

        const localProvider = await client.callTool({
          name: "goblintown_rite",
          arguments: {
            task: "try local provider from ChatGPT app",
            executionMode: "local_provider",
          },
        });
        assert.equal(localProvider.isError, true);
        const localProviderContent = localProvider.content as Array<{ text?: string }> | undefined;
        assert.match(localProviderContent?.[0]?.text ?? "", /local_provider execution is disabled in the ChatGPT app/);
      } finally {
        await client.close();
      }
    } finally {
      await handle.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("creates a hosted Express app for Vercel without local Tank side effects", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "goblintown-chatgpt-hosted-"));
    const expressHandle = createGoblintownChatGptExpressApp({
      cwd: tmp,
      host: "0.0.0.0",
      publicBaseUrl: "https://goblintown-mcp.vercel.app",
      allowedHosts: ["goblintown-mcp.vercel.app", "127.0.0.1"],
      hostedMode: true,
    });
    const server = expressHandle.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert.equal(typeof address, "object");
    const localBaseUrl = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}`;

    try {
      const health = await fetch(`${localBaseUrl}/healthz`).then((res) => res.json()) as {
        ok: boolean;
        mode: string;
        mcpUrl: string;
        widgetUri: string;
        tools: string[];
      };
      assert.equal(health.ok, true);
      assert.equal(health.mode, "hosted");
      assert.equal(health.mcpUrl, "https://goblintown-mcp.vercel.app/mcp");
      assert.equal(health.widgetUri, GOBLINTOWN_CHATGPT_WIDGET_URI);
      assert.ok(health.tools.includes("goblintown_rite"));
      assert.ok(health.tools.includes("goblintown_capabilities"));
      assert.ok(!health.tools.includes("goblintown_chat"));

      const hostedLandingPage = await fetch(localBaseUrl).then((res) => res.text());
      assert.match(hostedLandingPage, /https:\/\/goblintown-mcp\.vercel\.app\/privacy\.html/);
      assert.match(hostedLandingPage, /https:\/\/goblintown-mcp\.vercel\.app\/terms\.html/);

      const client = new Client(
        { name: "goblintown-chatgpt-hosted-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(`${localBaseUrl}/mcp`)));
      try {
        const tank = await client.callTool({ name: "goblintown_tank", arguments: {} });
        const tankContent = tank.structuredContent as {
          tankUrl?: string;
          serverStarted?: boolean;
          hosted?: boolean;
          externalLaunchAvailable?: boolean;
          openAction?: string;
        } | undefined;
        assert.equal(tankContent?.tankUrl, "https://goblintown-mcp.vercel.app");
        assert.equal(tankContent?.serverStarted, false);
        assert.equal(tankContent?.hosted, true);
        assert.equal(tankContent?.externalLaunchAvailable, false);
        assert.equal(tankContent?.openAction, "chatgpt_widget");

        const hostedRite = await client.callTool({
          name: "goblintown_rite",
          arguments: {
            task: "Explain hosted ChatGPT key policy.",
            packSize: 1,
            noFallback: true,
            noSpecialist: true,
          },
        });
        const hostedRiteContent = hostedRite.structuredContent as {
          runMode?: string;
          tokenPolicy?: { default?: string };
          hostRun?: { openAiApiKeyRequired?: boolean };
        } | undefined;
        assert.equal(hostedRite.isError ?? false, false);
        assert.equal(hostedRiteContent?.runMode, "chatgpt");
        assert.equal(hostedRiteContent?.tokenPolicy?.default, "chatgpt_host");
        assert.equal(hostedRiteContent?.hostRun?.openAiApiKeyRequired, false);

        const capabilities = await client.callTool({
          name: "goblintown_capabilities",
          arguments: { surface: "all" },
        });
        assert.equal(capabilities.isError ?? false, false);
        const capabilityContent = capabilities.structuredContent as {
          openAiApiKeyRequired?: boolean;
          websiteSurfaces?: Array<{ path?: string; status?: string }>;
          modelProfiles?: Record<string, string>;
        } | undefined;
        assert.equal(capabilityContent?.openAiApiKeyRequired, false);
        assert.equal(capabilityContent?.modelProfiles?.archive_legacy.includes("text-embedding-ada-002"), true);
        assert.ok(capabilityContent?.websiteSurfaces?.some((surface) => surface.path === "/dashboard" && surface.status === "planned"));
        assert.ok(capabilityContent?.websiteSurfaces?.some((surface) => surface.path === "/admin" && surface.status === "planned"));

        const localProvider = await client.callTool({
          name: "goblintown_plan",
          arguments: {
            task: "try local provider",
            executionMode: "local_provider",
          },
        });
        assert.equal(localProvider.isError, true);
        const localProviderContent = localProvider.content as Array<{ text?: string }> | undefined;
        assert.match(localProviderContent?.[0]?.text ?? "", /local_provider execution is disabled in the ChatGPT app/);

        const resource = await client.readResource({ uri: GOBLINTOWN_CHATGPT_WIDGET_URI });
        const content = resource.contents[0];
        assert.equal(content.mimeType, GOBLINTOWN_CHATGPT_WIDGET_MIME_TYPE);
        const meta = (content as {
          _meta?: {
            ui?: { domain?: string };
            "openai/widgetDomain"?: string;
            "openai/widgetCSP"?: { redirect_domains?: string[] };
          };
        })._meta;
        assert.equal(meta?.ui?.domain, "https://goblintown-mcp.vercel.app");
        assert.equal(meta?.["openai/widgetDomain"], "https://goblintown-mcp.vercel.app");
        assert.deepEqual(meta?.["openai/widgetCSP"]?.redirect_domains, [
          "https://goblintown-mcp.vercel.app",
        ]);
      } finally {
        await client.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
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

  it("allowlists quick tunnel candidates before readiness validation", async () => {
    const source = await readFile(join(process.cwd(), "src", "cli.ts"), "utf8");
    const start = source.indexOf("startGoblintownChatGptQuickTunnel(localGuideUrl");
    assert.notEqual(start, -1);
    const block = source.slice(start, source.indexOf("});", start) + 3);
    assert.match(block, /onTunnelUrl:\s*\(url\)\s*=>\s*\{[\s\S]*handle\.setPublicBaseUrl\(url\)/u);
  });

  it("ignores Cloudflare informational links before the quick tunnel URL", async () => {
    const tunnel = await startGoblintownChatGptQuickTunnel("http://127.0.0.1:8787", {
      command: process.execPath,
      args: [
        "--input-type=module",
        "--eval",
        [
          "console.error('Terms of service: https://www.cloudflare.com/website-terms/');",
          "setTimeout(() => console.error('Your quick tunnel is https://real-chatgpt.trycloudflare.com'), 25);",
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      timeoutMs: 5000,
    });
    try {
      assert.equal(tunnel.url, "https://real-chatgpt.trycloudflare.com");
      assert.equal(tunnel.mcpUrl, "https://real-chatgpt.trycloudflare.com/mcp");
    } finally {
      await tunnel.close();
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
