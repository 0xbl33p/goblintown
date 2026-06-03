import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GOBLINTOWN_MCP_TOOLS,
  buildGoblintownMcpConfig,
  installGoblintownCodexMcpConfig,
  mcpDoctorPayload,
  normalizeMcpExecutionMode,
  normalizeMcpChatArgs,
  openMcpTank,
  startMcpTankRun,
} from "../mcp.js";
import { setProviderSecretForRoot } from "../provider-secrets.js";
import { serve } from "../server.js";
import { installGoblintownCodexSkill } from "../skill-install.js";
import { initWarren, saveWarrenManifest } from "../warren.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function busyPortError(): Error {
  const err = new Error("listen EADDRINUSE: address already in use") as NodeJS.ErrnoException;
  err.code = "EADDRINUSE";
  return err;
}

describe("Goblintown MCP sidecar", () => {
  it("advertises the local sidecar tools Codex needs", () => {
    const names = GOBLINTOWN_MCP_TOOLS.map((tool) => tool.name);

    assert.deepEqual(names, [
      "goblintown_tank",
      "goblintown_chat",
      "goblintown_rite",
      "goblintown_plan",
      "goblintown_provider",
      "goblintown_doctor",
    ]);
    assert.match(JSON.stringify(GOBLINTOWN_MCP_TOOLS), /Open Goblintown Tank/);
    assert.match(JSON.stringify(GOBLINTOWN_MCP_TOOLS), /Single Goblin/);
    assert.match(JSON.stringify(GOBLINTOWN_MCP_TOOLS), /full Goblintown rite/);
    assert.match(JSON.stringify(GOBLINTOWN_MCP_TOOLS), /planner DAG/);
    assert.match(JSON.stringify(GOBLINTOWN_MCP_TOOLS), /executionMode/);
    assert.match(JSON.stringify(GOBLINTOWN_MCP_TOOLS), /board loop/);
  });

  it("declares output schemas for every exposed tool", () => {
    for (const tool of GOBLINTOWN_MCP_TOOLS) {
      assert.equal(tool.outputSchema?.type, "object", `${tool.name} outputSchema`);
      assert.ok(tool.outputSchema.properties, `${tool.name} outputSchema properties`);
    }
  });

  it("defaults rites and plans to the real board loop", () => {
    assert.equal(normalizeMcpExecutionMode(undefined, {}), "board");
    assert.equal(normalizeMcpExecutionMode("board", {}), "board");
    assert.equal(normalizeMcpExecutionMode("harness", {}), "board");
    assert.equal(normalizeMcpExecutionMode("local_provider", {}), "local_provider");
    assert.equal(normalizeMcpExecutionMode(undefined, {
      GOBLINTOWN_MCP_EXECUTION_MODE: "local_provider",
    }), "local_provider");
  });

  it("prints a Codex-compatible local install snippet", () => {
    const defaultConfig = buildGoblintownMcpConfig();
    assert.deepEqual(defaultConfig.mcpServers.goblintown.args, [
      "-y",
      "goblintown@latest",
      "mcp",
    ]);

    const config = buildGoblintownMcpConfig({
      packageSpec: "goblintown@0.7.0-sidecar.0",
    });
    const server = config.mcpServers.goblintown;

    assert.equal(server.command, "npx");
    assert.deepEqual(server.args, ["-y", "goblintown@0.7.0-sidecar.0", "mcp"]);
  });

  it("uses a Codex-local global Warren when the current folder lacks a Warren", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "goblintown-mcp-no-warren-"));
    const priorCodexHome = process.env.CODEX_HOME;
    try {
      const codexHome = join(tmp, "codex-home");
      const workspace = join(tmp, "workspace");
      process.env.CODEX_HOME = codexHome;

      const payload = await mcpDoctorPayload(workspace);
      const globalRoot = join(codexHome, "goblintown");
      const warren = payload.warren as { ok: boolean; root: string; scope: string };

      assert.equal(payload.ok, true);
      assert.equal(payload.projectReady, true);
      assert.equal(payload.warrenRoot, globalRoot);
      assert.equal(warren.ok, true);
      assert.equal(warren.root, globalRoot);
      assert.equal(warren.scope, "global");
      await access(join(globalRoot, ".goblintown", "warren.json"));
      assert.match(String(payload.codexToml), /\[mcp_servers\.goblintown\]/);
    } finally {
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("prefers a project Warren over the Codex-local global fallback", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "goblintown-mcp-project-warren-"));
    const priorCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = join(tmp, "codex-home");
      const project = join(tmp, "project");
      await initWarren(project);

      const payload = await mcpDoctorPayload(join(project, "subdir"));
      const warren = payload.warren as { ok: boolean; root: string; scope: string };

      assert.equal(payload.projectReady, true);
      assert.equal(payload.warrenRoot, project);
      assert.equal(warren.ok, true);
      assert.equal(warren.root, project);
      assert.equal(warren.scope, "project");
    } finally {
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("loads stored provider keys from the global Warren root", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "goblintown-mcp-global-provider-"));
    const priorCodexHome = process.env.CODEX_HOME;
    try {
      const codexHome = join(tmp, "codex-home");
      const globalRoot = join(codexHome, "goblintown");
      process.env.CODEX_HOME = codexHome;

      const warren = await initWarren(globalRoot);
      warren.manifest.provider = {
        preset: "deepseek",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        models: { goblin: "deepseek-chat" },
      };
      await saveWarrenManifest(warren);
      await setProviderSecretForRoot(globalRoot, "DEEPSEEK_API_KEY", "sk-stored");

      const payload = await mcpDoctorPayload(join(tmp, "workspace"));
      const provider = payload.provider as { id: string; apiKeySource?: string };

      assert.equal(payload.projectReady, true);
      assert.equal(payload.warrenRoot, globalRoot);
      assert.equal(provider.id, "deepseek");
      assert.equal(provider.apiKeySource, "stored");
    } finally {
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("opens the Tank in autopilot mode without starting a run", async () => {
    const result = await openMcpTank({
      warrenRoot: "/tmp/example-warren",
      port: 7788,
      serveImpl: async (opts: {
        cwd: string;
        port: number;
        autopilot?: boolean;
        quiet?: boolean;
      }) => {
        assert.equal(opts.cwd, "/tmp/example-warren");
        assert.equal(opts.port, 7788);
        assert.equal(opts.autopilot, true);
        assert.equal(opts.quiet, true);
        return { url: "http://127.0.0.1:7788/", close: async () => {} };
      },
    });

    assert.equal(result.tankUrl, "http://127.0.0.1:7788/");
    assert.equal(result.serverStarted, true);
  });

  it("reuses an existing Tank only after its Warren identity matches", async () => {
    const result = await openMcpTank({
      warrenRoot: "/tmp/example-warren",
      port: 7789,
      serveImpl: async () => {
        throw busyPortError();
      },
      fetchImpl: async (
        input: Parameters<typeof fetch>[0],
      ) => {
        assert.equal(String(input), "http://localhost:7789/api/identity");
        return new Response(JSON.stringify({
          ok: true,
          root: "/tmp/example-warren",
          scope: "project",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    assert.equal(result.tankUrl, "http://localhost:7789/");
    assert.equal(result.serverStarted, false);
  });

  it("rejects an occupied Tank port when it belongs to another Warren", async () => {
    await assert.rejects(
      () => openMcpTank({
        warrenRoot: "/tmp/project-warren",
        port: 7790,
        serveImpl: async () => {
          throw busyPortError();
        },
        fetchImpl: async () => new Response(JSON.stringify({
          ok: true,
          root: "/tmp/other-warren",
          scope: "global",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      }),
      new RegExp(`Tank port 7790 is already in use by Warren ${resolve("/tmp/other-warren")}, not /tmp/project-warren`),
    );
  });

  it("starts MCP rites through the Tank run API", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await startMcpTankRun({
      warrenRoot: "/tmp/example-warren",
      mode: "rite",
      payload: {
        task: "show this rite in the Tank",
        packSize: 2,
        cite: ["abc123"],
      },
      serveImpl: async (opts: {
        cwd: string;
        port: number;
        autopilot?: boolean;
        quiet?: boolean;
      }) => {
        assert.equal(opts.cwd, "/tmp/example-warren");
        assert.equal(opts.autopilot, true);
        assert.equal(opts.quiet, true);
        return { url: "http://127.0.0.1:7777/", close: async () => {} };
      },
      fetchImpl: async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ url: String(input), body });
        return new Response(JSON.stringify({ runId: "run-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:7777/api/rite",
        body: {
          task: "show this rite in the Tank",
          packSize: 2,
          cite: ["abc123"],
        },
      },
    ]);
    assert.equal(result.runId, "run-123");
    assert.equal(result.tankUrl, "http://127.0.0.1:7777/");
    assert.equal(result.serverStarted, true);
  });

  it("starts MCP plans through the Tank run API", async () => {
    const result = await startMcpTankRun({
      warrenRoot: "/tmp/example-warren",
      mode: "plan",
      payload: {
        task: "show this plan in the Tank",
        maxNodes: 4,
      },
      serveImpl: async () => ({ url: "http://127.0.0.1:7778/", close: async () => {} }),
      fetchImpl: async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        assert.equal(String(input), "http://127.0.0.1:7778/api/plan");
        assert.deepEqual(JSON.parse(String(init?.body ?? "{}")), {
          task: "show this plan in the Tank",
          maxNodes: 4,
        });
        return new Response(JSON.stringify({ runId: "plan-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    assert.equal(result.runId, "plan-123");
    assert.equal(result.mode, "plan");
  });

  it("times out Tank start requests instead of hanging MCP calls", async () => {
    let aborted = false;
    await assert.rejects(
      () => startMcpTankRun({
        warrenRoot: "/tmp/example-warren",
        mode: "rite",
        payload: { task: "do not hang" },
        startTimeoutMs: 5,
        serveImpl: async () => ({ url: "http://127.0.0.1:7779/", close: async () => {} }),
        fetchImpl: async (
          _input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
      }),
      /Tank rite start timed out after 5ms/,
    );
    assert.equal(aborted, true);
  });

  it("rejects instead of crashing when the Tank port is already in use", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "goblintown-mcp-port-busy-"));
    let occupied: NetServer | undefined;
    try {
      await initWarren(tmp);
      occupied = createServer();
      occupied.listen(0);
      await once(occupied, "listening");
      const address = occupied.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      assert.ok(port > 0);

      await assert.rejects(
        () => serve({ cwd: tmp, port, quiet: true }),
        /EADDRINUSE|address already in use/i,
      );
    } finally {
      if (occupied) await new Promise<void>((resolve) => occupied!.close(() => resolve()));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("logs process-level MCP crashes to stderr without closing the sidecar", () => {
    const mcpUrl = pathToFileURL(join(repoRoot, "dist", "mcp.js")).href;
    const script = [
      `import { installMcpCrashGuards } from ${JSON.stringify(mcpUrl)};`,
      "installMcpCrashGuards();",
      "setImmediate(() => { throw new Error('late listener boom'); });",
      "Promise.reject(new Error('async task boom'));",
      "setTimeout(() => { console.log('still alive'); process.exit(0); }, 50);",
    ].join("\n");
    return new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          assert.equal(code, 0);
          assert.match(stdout, /still alive/);
          assert.match(stderr, /\[goblintown:mcp:uncaughtException\]/);
          assert.match(stderr, /late listener boom/);
          assert.match(stderr, /\[goblintown:mcp:unhandledRejection\]/);
          assert.match(stderr, /async task boom/);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  });

  it("installs the Codex TOML MCP block idempotently", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "goblintown-mcp-config-"));
    try {
      const configPath = join(tmp, "config.toml");
      await writeFile(
        configPath,
        'model = "gpt-5"\n\n[mcp_servers.firebase]\ncommand = "npx"\n',
        "utf8",
      );

      const first = await installGoblintownCodexMcpConfig({ configPath });
      assert.equal(first.ok, true);
      assert.equal(first.changed, true);

      const installed = await readFile(configPath, "utf8");
      assert.match(installed, /\[mcp_servers\.goblintown\]/);
      assert.match(installed, /args = \["-y", "goblintown@latest", "mcp"\]/);
      assert.match(installed, /\[mcp_servers\.firebase\]/);

      const second = await installGoblintownCodexMcpConfig({ configPath });
      assert.equal(second.ok, true);
      assert.equal(second.changed, false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("packages a real Codex skill with install, use, and consent guidance", async () => {
    const skill = await readFile(
      join(repoRoot, "skills", "goblintown-sidecar", "SKILL.md"),
      "utf8",
    );
    const agentMeta = await readFile(
      join(repoRoot, "skills", "goblintown-sidecar", "agents", "openai.yaml"),
      "utf8",
    );

    assert.match(skill, /^---\nname: goblintown-sidecar\n/m);
    assert.match(skill, /npx -y goblintown@latest skill install/);
    assert.match(skill, /npm install -g goblintown@latest/);
    assert.match(skill, /npx -y goblintown@latest mcp --install-codex/);
    assert.match(skill, /Ask before changing the user's machine or local data/);
    assert.match(skill, /Codex-local global Warren/);
    assert.match(skill, /goblintown_tank/);
    assert.match(skill, /Use `goblintown_doctor` first/);
    assert.match(agentMeta, /display_name: "Goblintown Codex Plugin"/);
    assert.match(agentMeta, /short_description: "Goblintown Codex Plugin 1\.0"/);
    assert.match(agentMeta, /\$goblintown-sidecar/);
  });

  it("installs the bundled Codex skill idempotently", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "goblintown-skill-install-"));
    try {
      const first = await installGoblintownCodexSkill({ skillsDir: tmp });
      assert.equal(first.ok, true);
      assert.equal(first.changed, true);

      const installed = await readFile(
        join(tmp, "goblintown-sidecar", "SKILL.md"),
        "utf8",
      );
      assert.match(installed, /^---\nname: goblintown-sidecar\n/m);

      const second = await installGoblintownCodexSkill({ skillsDir: tmp });
      assert.equal(second.ok, true);
      assert.equal(second.changed, false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes chat prompts into MCP chat messages", () => {
    const args = normalizeMcpChatArgs({
      messages: [
        { role: "system", content: "ignored" },
        { role: "assistant", content: "ready" },
      ],
      prompt: "  ship the sidecar  ",
      personality: "feral",
      modelSlot: "goblin",
      maxOutputTokens: "1200",
    });

    assert.deepEqual(args.messages, [
      { role: "assistant", content: "ready" },
      { role: "user", content: "ship the sidecar" },
    ]);
    assert.equal(args.personality, "feral");
    assert.equal(args.modelSlot, "goblin");
    assert.equal(args.maxOutputTokens, 1200);
  });
});
