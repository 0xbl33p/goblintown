import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type CreateMessageResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  normalizeChatMessages,
  runSingleGoblinChat,
  type ChatMessage,
} from "./chat.js";
import { serve, type ServeHandle, type ServeOptions } from "./server.js";
import { withProviderRoot } from "./openai-client.js";
import { resolveProviderRuntime, resolveProviderRuntimeForSlot } from "./providers.js";
import { readProviderSecretsForRootSync } from "./provider-secrets.js";
import { loadWarren } from "./warren.js";
import type { ModelSlot, Personality } from "./types.js";

const PERSONALITIES: readonly Personality[] = [
  "chipper",
  "nerdy",
  "stoic",
  "cynical",
  "feral",
  "goblin_mode",
];

const MCP_MODEL_SLOTS: readonly ModelSlot[] = [
  "goblin",
  "gremlin",
  "raccoon",
  "troll",
  "ogre",
  "pigeon",
  "scribe",
  "embedding",
];

const DEFAULT_PACKAGE_SPEC = "goblintown@latest";
export const GOBLINTOWN_CHATGPT_WIDGET_URI = "ui://goblintown/tank.html";
export const GOBLINTOWN_CHATGPT_WIDGET_MIME_TYPE = "text/html";

export type JsonObject = Record<string, unknown>;
export type McpTankMode = "rite" | "plan";
export type McpExecutionMode = "harness" | "local_provider";
type ServeImpl = (opts: ServeOptions) => Promise<ServeHandle>;
type FetchImpl = typeof fetch;

const mcpTankServers = new Map<string, Promise<McpTankServer>>();
const MCP_EXECUTION_MODES: readonly McpExecutionMode[] = ["harness", "local_provider"];

export interface GoblintownMcpConfig {
  mcpServers: {
    goblintown: {
      command: string;
      args: string[];
      env?: Record<string, string>;
    };
  };
}

export interface GoblintownMcpConfigOptions {
  command?: string;
  packageSpec?: string;
  env?: Record<string, string>;
}

export interface GoblintownCodexInstallOptions {
  packageSpec?: string;
  configPath?: string;
}

export interface CreateGoblintownMcpServerOptions {
  cwd?: string;
  chatgptApp?: boolean;
  version?: string;
}

export interface NormalizedMcpChatArgs {
  messages: ChatMessage[];
  personality?: Personality;
  modelSlot?: ModelSlot;
  maxOutputTokens?: number;
}

export interface McpTankRunOptions {
  warrenRoot: string;
  mode: McpTankMode;
  payload: JsonObject;
  port?: number;
  startTimeoutMs?: number;
  serveImpl?: ServeImpl;
  fetchImpl?: FetchImpl;
}

export interface McpTankOpenOptions {
  warrenRoot: string;
  port?: number;
  serveImpl?: ServeImpl;
}

export interface McpTankOpenResult {
  tankUrl: string;
  serverStarted: boolean;
}

export interface McpTankRunResult {
  mode: McpTankMode;
  runId: string;
  tankUrl: string;
  serverStarted: boolean;
}

interface McpTankServer {
  url: string;
  serverStarted: boolean;
  handle?: ServeHandle;
}

interface McpCrashStderr {
  write(chunk: string): unknown;
}

export interface McpCrashGuardOptions {
  stderr?: McpCrashStderr;
}

interface McpHarnessRunConfig {
  mode: McpTankMode;
  runMode: "harness";
  executionMode: "harness";
  task: string;
  warrenRoot: string;
  warrenScope: "project" | "global";
  payload: JsonObject;
  tokenPolicy: {
    default: "host_harness";
    localProviderOptIn: string;
  };
  harnessPrompt: string;
}

export const GOBLINTOWN_MCP_TOOLS: Tool[] = [
  {
    name: "goblintown_tank",
    title: "Open Goblintown Tank",
    description:
      "Launch or reuse the local Goblintown Tank in AI-autopilot mode and return its URL. Use this immediately when the user invokes the Goblintown plugin or asks to land in the Tank.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "number",
          minimum: 1,
          maximum: 65535,
          description: "Optional Tank port. Defaults to GOBLINTOWN_MCP_TANK_PORT, PORT, or 7777.",
        },
      },
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "goblintown_chat",
    title: "Single Goblin",
    description:
      "Run Goblintown's Single Goblin mode as one concise local model call. Use this for direct answers, quick repo help, or chat continuity without the full pack.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Latest user prompt. Appended to messages when both are provided.",
        },
        messages: {
          type: "array",
          description: "Optional prior chat turns with role=user or role=assistant.",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant"] },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
        },
        personality: {
          type: "string",
          enum: [...PERSONALITIES],
          description: "Optional goblin personality.",
        },
        modelSlot: {
          type: "string",
          enum: [...MCP_MODEL_SLOTS],
          description: "Optional Goblintown model slot to route through.",
        },
        maxOutputTokens: {
          type: "number",
          minimum: 64,
          maximum: 8000,
        },
      },
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "goblintown_rite",
    title: "Goblintown Rite",
    description:
      "Configure a full Goblintown rite for the host harness. By default the connected harness performs the model work with its own tokens; use executionMode=local_provider only when the user opted into local provider spend.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task for the full Goblintown rite." },
        executionMode: {
          type: "string",
          enum: [...MCP_EXECUTION_MODES],
          description:
            "harness (default) uses the connected client/harness tokens. local_provider starts the Tank and spends configured local provider tokens.",
        },
        packSize: { type: "number", minimum: 1, maximum: 8 },
        personality: { type: "string", enum: [...PERSONALITIES] },
        scanGlobs: {
          type: "array",
          items: { type: "string" },
          description: "Optional local file globs to inspect before the pack writes.",
        },
        citeRiteIds: {
          type: "array",
          items: { type: "string" },
          description: "Prior rite ids whose artifacts should be loaded as context.",
        },
        remember: {
          type: "boolean",
          description: "Auto-load up to three relevant prior artifacts.",
        },
        noFallback: { type: "boolean" },
        noSpecialist: { type: "boolean" },
        specialistCap: { type: "number", minimum: 0, maximum: 8 },
        debate: { type: "boolean" },
        trollTools: { type: "boolean" },
        budgetTokens: { type: "number", minimum: 1 },
        maxOutputTokens: { type: "number", minimum: 64, maximum: 12000 },
        outputFormat: { type: "string", enum: ["freeform", "markdown", "json"] },
      },
      required: ["task"],
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "goblintown_plan",
    title: "Goblintown Planner",
    description:
      "Configure a planner DAG for the host harness. By default the connected harness performs the model work with its own tokens; use executionMode=local_provider only when the user opted into local provider spend.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Complex task for the planner DAG." },
        executionMode: {
          type: "string",
          enum: [...MCP_EXECUTION_MODES],
          description:
            "harness (default) uses the connected client/harness tokens. local_provider starts the Tank and spends configured local provider tokens.",
        },
        maxNodes: { type: "number", minimum: 1, maximum: 12 },
        maxReplan: { type: "number", minimum: 0, maximum: 6 },
        citeRiteIds: { type: "array", items: { type: "string" } },
        remember: { type: "boolean" },
        budgetTokens: { type: "number", minimum: 1 },
        maxOutputTokens: { type: "number", minimum: 64, maximum: 12000 },
        outputFormat: { type: "string", enum: ["freeform", "markdown", "json"] },
      },
      required: ["task"],
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "goblintown_provider",
    title: "Provider Snapshot",
    description:
      "Return the current local Goblintown provider, route, model, and missing-key status without exposing secrets.",
    inputSchema: {
      type: "object",
      properties: {
        slot: {
          type: "string",
          enum: [...MCP_MODEL_SLOTS],
          description: "Optional model slot to inspect.",
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "goblintown_doctor",
    title: "Sidecar Doctor",
    description:
      "Check whether the current directory has a Warren, show available tools, and print the local Codex MCP install snippet.",
    inputSchema: {
      type: "object",
      properties: {
        packageSpec: {
          type: "string",
          description: "NPM package spec to use in the printed config. Defaults to goblintown@latest.",
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

export function buildGoblintownMcpTools(
  opts: { chatgptApp?: boolean } = {},
): Tool[] {
  if (!opts.chatgptApp) return GOBLINTOWN_MCP_TOOLS;
  return GOBLINTOWN_MCP_TOOLS.map((tool) => ({
    ...tool,
    _meta: {
      ...tool._meta,
      securitySchemes: [{ type: "noauth" }],
      ui: {
        resourceUri: GOBLINTOWN_CHATGPT_WIDGET_URI,
        visibility: ["model", "app"],
      },
      "openai/outputTemplate": GOBLINTOWN_CHATGPT_WIDGET_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": chatGptInvokingLabel(tool.name),
      "openai/toolInvocation/invoked": chatGptInvokedLabel(tool.name),
    },
  }));
}

export function buildGoblintownMcpConfig(
  opts: GoblintownMcpConfigOptions = {},
): GoblintownMcpConfig {
  const command = opts.command ?? "npx";
  const packageSpec = stringValue(opts.packageSpec) ?? DEFAULT_PACKAGE_SPEC;
  const server: GoblintownMcpConfig["mcpServers"]["goblintown"] = {
    command,
    args: ["-y", packageSpec, "mcp"],
  };
  if (opts.env && Object.keys(opts.env).length > 0) {
    server.env = opts.env;
  }
  return { mcpServers: { goblintown: server } };
}

export function buildGoblintownCodexTomlConfig(
  opts: GoblintownCodexInstallOptions = {},
): string {
  const packageSpec = stringValue(opts.packageSpec) ?? DEFAULT_PACKAGE_SPEC;
  return [
    "[mcp_servers.goblintown]",
    'command = "npx"',
    `args = ["-y", ${tomlString(packageSpec)}, "mcp"]`,
    "",
  ].join("\n");
}

export async function installGoblintownCodexMcpConfig(
  opts: GoblintownCodexInstallOptions = {},
): Promise<JsonObject> {
  const configPath = stringValue(opts.configPath) ?? defaultCodexConfigPath();
  const codexToml = buildGoblintownCodexTomlConfig(opts);
  let existing = "";
  let existed = true;
  try {
    existing = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        ok: false,
        path: configPath,
        codexToml,
        config: buildGoblintownMcpConfig({ packageSpec: opts.packageSpec }),
        error: errorMessage(err),
      };
    }
    existed = false;
  }

  const next = upsertCodexTomlServer(existing, codexToml);
  const changed = next !== existing;
  let backupPath: string | undefined;
  try {
    await mkdir(dirname(configPath), { recursive: true });
    if (changed && existed) {
      backupPath = `${configPath}.bak-${timestampForPath()}`;
      await copyFile(configPath, backupPath);
    }
    if (changed) await writeFile(configPath, next, "utf8");
    return {
      ok: true,
      path: configPath,
      changed,
      backupPath,
      codexToml,
      config: buildGoblintownMcpConfig({ packageSpec: opts.packageSpec }),
      restartRequired: true,
    };
  } catch (err) {
    return {
      ok: false,
      path: configPath,
      changed: false,
      codexToml,
      config: buildGoblintownMcpConfig({ packageSpec: opts.packageSpec }),
      error: errorMessage(err),
    };
  }
}

export function normalizeMcpChatArgs(input: unknown): NormalizedMcpChatArgs {
  const raw = objectValue(input);
  const messages = normalizeChatMessages(raw.messages);
  const prompt = stringValue(raw.prompt);
  if (prompt) messages.push({ role: "user", content: prompt });
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    throw new Error("goblintown_chat requires prompt or messages ending with a user message");
  }
  return {
    messages,
    personality: normalizePersonality(raw.personality),
    modelSlot: normalizeModelSlot(raw.modelSlot),
    maxOutputTokens: numberValue(raw.maxOutputTokens, 64, 8000),
  };
}

export async function startMcpTankRun(
  opts: McpTankRunOptions,
): Promise<McpTankRunResult> {
  const tank = await ensureMcpTankServer(opts);
  const endpoint = new URL(opts.mode === "plan" ? "/api/plan" : "/api/rite", tank.url);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const startTimeoutMs = opts.startTimeoutMs ?? mcpTankStartTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), startTimeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(`Tank ${opts.mode} start timed out after ${startTimeoutMs}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => ({})) as JsonObject;
  if (!response.ok) {
    throw new Error(stringValue(body.error) ?? `Tank ${opts.mode} start failed: ${response.status}`);
  }
  const runId = stringValue(body.runId);
  if (!runId) throw new Error(`Tank ${opts.mode} start did not return a runId.`);
  return {
    mode: opts.mode,
    runId,
    tankUrl: tank.url,
    serverStarted: tank.serverStarted,
  };
}

export async function openMcpTank(
  opts: McpTankOpenOptions,
): Promise<McpTankOpenResult> {
  const tank = await ensureMcpTankServer(opts);
  return {
    tankUrl: tank.url,
    serverStarted: tank.serverStarted,
  };
}

async function ensureMcpTankServer(
  opts: McpTankOpenOptions,
): Promise<McpTankServer> {
  const port = opts.port ?? mcpTankPort();
  const serveImpl = opts.serveImpl ?? serve;
  if (opts.serveImpl) {
    const handle = await serveImpl({
      cwd: opts.warrenRoot,
      port,
      autopilot: true,
      quiet: true,
    });
    return { url: handle.url, handle, serverStarted: true };
  }

  const key = `${opts.warrenRoot}:${port}`;
  const existing = mcpTankServers.get(key);
  if (existing) return existing;

  const started = serveImpl({
    cwd: opts.warrenRoot,
    port,
    autopilot: true,
    quiet: true,
  })
    .then((handle) => ({ url: handle.url, handle, serverStarted: true }))
    .catch((err) => {
      if (isAddressInUse(err)) {
        return {
          url: `http://localhost:${port}/`,
          serverStarted: false,
        };
      }
      throw err;
    });
  mcpTankServers.set(key, started);
  return started;
}

function mcpTankPort(): number {
  const raw = Number(process.env.GOBLINTOWN_MCP_TANK_PORT ?? process.env.PORT ?? 7777);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7777;
}

function mcpTankStartTimeoutMs(): number {
  const raw = Number(process.env.GOBLINTOWN_MCP_TANK_START_TIMEOUT_MS ?? 15_000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15_000;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function isAddressInUse(err: unknown): boolean {
  const nodeErr = err as NodeJS.ErrnoException;
  return nodeErr?.code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(errorMessage(err));
}

export async function mcpDoctorPayload(
  cwd = process.cwd(),
  opts: { packageSpec?: string } = {},
): Promise<JsonObject> {
  const payload: JsonObject = {
    ok: true,
    cwd,
    tools: GOBLINTOWN_MCP_TOOLS.map((tool) => tool.name),
    config: buildGoblintownMcpConfig({ packageSpec: opts.packageSpec }),
    codexToml: buildGoblintownCodexTomlConfig({ packageSpec: opts.packageSpec }),
  };
  try {
    const warren = await loadWarren(cwd, { globalFallback: true });
    const runtime = resolveProviderRuntime(
      warren.manifest.provider,
      process.env,
      readProviderSecretsForRootSync(warren.root),
    );
    payload.projectReady = true;
    payload.warrenRoot = warren.root;
    payload.warren = {
      ok: true,
      root: warren.root,
      scope: warren.scope,
    };
    payload.provider = safeProviderRuntime(runtime);
    payload.voice = {
      provider: warren.manifest.voice?.provider,
      model: warren.manifest.voice?.model,
      language: warren.manifest.voice?.language,
    };
  } catch (err) {
    payload.projectReady = false;
    payload.warren = {
      ok: false,
      message: errorMessage(err),
      nextStep:
        "Check CODEX_HOME permissions or run `goblintown init` in a project folder before using project-bound rite/chat tools there.",
    };
    payload.warnings = [
      "Goblintown MCP is installable from this package, but no project or Codex-local global Warren could be loaded.",
    ];
  }
  return payload;
}

export async function runGoblintownMcpServer(
  opts: { cwd?: string } = {},
): Promise<void> {
  installMcpCrashGuards();
  const server = createGoblintownMcpServer({ cwd: opts.cwd });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function createGoblintownMcpServer(
  opts: CreateGoblintownMcpServerOptions = {},
): Server {
  const cwd = opts.cwd ?? process.cwd();
  const tools = buildGoblintownMcpTools({ chatgptApp: opts.chatgptApp });
  const server = new Server(
    { name: "goblintown", version: opts.version ?? process.env.npm_package_version ?? "0.7.0-beta.5" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Goblintown augments the connected harness. When the user invokes Goblintown, open the Tank with goblintown_tank first. Use goblintown_doctor when setup is uncertain. goblintown_rite and goblintown_plan default to harness-token execution; only use executionMode=local_provider when the user has opted into local provider spend.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: GOBLINTOWN_CHATGPT_WIDGET_URI,
        name: "goblintown-tank-widget",
        title: "Goblintown Tank",
        description: "ChatGPT widget shell for opening and inspecting the Goblintown Tank.",
        mimeType: GOBLINTOWN_CHATGPT_WIDGET_MIME_TYPE,
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== GOBLINTOWN_CHATGPT_WIDGET_URI) {
      throw new Error(`Unknown Goblintown resource: ${request.params.uri}`);
    }
    return {
      contents: [
        {
          uri: GOBLINTOWN_CHATGPT_WIDGET_URI,
          mimeType: GOBLINTOWN_CHATGPT_WIDGET_MIME_TYPE,
          text: buildChatGptTankWidgetHtml(),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [],
                resourceDomains: [],
                frameDomains: [],
              },
            },
            "openai/widgetDescription":
              "Shows the Goblintown Tank handoff and lets the user reopen the local Tank when available.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: [],
              frame_domains: [],
              redirect_domains: ["http://localhost:7777", "http://127.0.0.1:7777"],
            },
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    try {
      switch (request.params.name) {
        case "goblintown_tank":
          return await callMcpTank(cwd, args);
        case "goblintown_chat":
          return await callMcpChat(cwd, args);
        case "goblintown_rite":
          return await callMcpRite(cwd, args, server);
        case "goblintown_plan":
          return await callMcpPlan(cwd, args, server);
        case "goblintown_provider":
          return await callMcpProvider(cwd, args);
        case "goblintown_doctor":
          return textResult(await mcpDoctorPayload(cwd, {
            packageSpec: stringValue(objectValue(args).packageSpec),
          }));
        default:
          return errorResult(`Unknown Goblintown MCP tool: ${request.params.name}`);
      }
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  });

  return server;
}

export function installMcpCrashGuards(
  opts: McpCrashGuardOptions = {},
): () => void {
  const stderr = opts.stderr ?? process.stderr;
  const onUncaughtException = (
    err: Error,
    origin: NodeJS.UncaughtExceptionOrigin,
  ) => {
    writeMcpCrashDiagnostic(stderr, "uncaughtException", err, origin);
  };
  const onUnhandledRejection = (reason: unknown) => {
    writeMcpCrashDiagnostic(stderr, "unhandledRejection", reason);
  };

  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  return () => {
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
  };
}

function writeMcpCrashDiagnostic(
  stderr: McpCrashStderr,
  kind: "uncaughtException" | "unhandledRejection",
  reason: unknown,
  origin?: NodeJS.UncaughtExceptionOrigin,
): void {
  const message = errorMessage(reason);
  const stack = reason instanceof Error && reason.stack ? `\n${reason.stack}` : "";
  const suffix = origin ? ` (${origin})` : "";
  try {
    stderr.write(`[goblintown:mcp:${kind}] recovered${suffix}: ${message}${stack}\n`);
  } catch {
    // Avoid recursive process errors while trying to report the first one.
  }
}

function defaultCodexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "config.toml");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function upsertCodexTomlServer(existing: string, block: string): string {
  const normalizedExisting = existing.replace(/\r\n/g, "\n");
  if (normalizedExisting.trim().length === 0) return block;

  const lines = normalizedExisting.split("\n");
  const start = lines.findIndex((line) =>
    /^\s*\[mcp_servers\.goblintown\]\s*$/.test(line),
  );
  if (start === -1) {
    const prefix = normalizedExisting.endsWith("\n")
      ? normalizedExisting
      : `${normalizedExisting}\n`;
    const spacer = prefix.endsWith("\n\n") ? "" : "\n";
    return `${prefix}${spacer}${block}`;
  }

  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;

  const nextLines = [
    ...lines.slice(0, start),
    ...block.trimEnd().split("\n"),
    ...lines.slice(end),
  ];
  return `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function callMcpTank(cwd: string, input: unknown): Promise<CallToolResult> {
  const raw = objectValue(input);
  const warren = await loadWarren(cwd, { globalFallback: true });
  const tank = await openMcpTank({
    warrenRoot: warren.root,
    port: numberValue(raw.port, 1, 65535),
  });
  return textResult({
    mode: "tank",
    runMode: "autopilot",
    tankUrl: tank.tankUrl,
    warrenRoot: warren.root,
    warrenScope: warren.scope,
    serverStarted: tank.serverStarted,
  }, [
    `Goblintown Tank ready: ${tank.tankUrl}`,
    "Mode: AI-autopilot",
    `Warren: ${warren.root} (${warren.scope})`,
  ].join("\n"));
}

async function callMcpChat(cwd: string, input: unknown): Promise<CallToolResult> {
  const args = normalizeMcpChatArgs(input);
  const warren = await loadWarren(cwd, { globalFallback: true });
  const result = await withProviderRoot(warren.root, () => runSingleGoblinChat({
    messages: args.messages,
    hoard: warren.hoard,
    personality: args.personality,
    modelSlot: args.modelSlot,
    maxOutputTokens: args.maxOutputTokens,
  }));
  return textResult({
    mode: "single_goblin",
    lootId: result.lootId,
    message: result.message,
    goblintownOffer: result.goblintownOffer,
    usage: result.usage,
  }, [
    "Single Goblin reply",
    "",
    result.message.content,
    "",
    `Loot: ${result.lootId}`,
  ].join("\n"));
}

async function callMcpRite(
  cwd: string,
  input: unknown,
  server?: Server,
): Promise<CallToolResult> {
  const raw = objectValue(input);
  const task = requiredString(raw.task, "goblintown_rite requires task");
  const warren = await loadWarren(cwd, { globalFallback: true });
  const payload = {
    task,
    packSize: numberValue(raw.packSize, 1, 8) ?? 3,
    scanGlobs: arrayOfStrings(raw.scanGlobs),
    personality: normalizePersonality(raw.personality),
    noFallback: booleanValue(raw.noFallback),
    noSpecialist: booleanValue(raw.noSpecialist),
    specialistCap: numberValue(raw.specialistCap, 0, 8),
    debate: booleanValue(raw.debate),
    trollTools: booleanValue(raw.trollTools),
    budgetTokens: numberValue(raw.budgetTokens, 1),
    maxOutputTokens: numberValue(raw.maxOutputTokens, 64, 12000),
    outputFormat: raw.outputFormat,
    cite: arrayOfStrings(raw.citeRiteIds),
    remember: booleanValue(raw.remember),
  };
  if (normalizeMcpExecutionMode(raw.executionMode) === "harness") {
    return await runMcpHarnessMode({
      server,
      warrenRoot: warren.root,
      warrenScope: warren.scope,
      mode: "rite",
      task,
      payload,
      maxOutputTokens: payload.maxOutputTokens,
    });
  }
  const run = await startMcpTankRun({
    warrenRoot: warren.root,
    mode: "rite",
    payload,
  });
  return textResult({
    mode: "rite",
    runMode: "tank",
    executionMode: "local_provider",
    runId: run.runId,
    tankUrl: run.tankUrl,
    warrenRoot: warren.root,
    warrenScope: warren.scope,
    serverStarted: run.serverStarted,
  }, [
    `Tank rite started: ${run.runId}`,
    `Tank: ${run.tankUrl}`,
    `Warren: ${warren.root} (${warren.scope})`,
  ].join("\n"));
}

async function callMcpPlan(
  cwd: string,
  input: unknown,
  server?: Server,
): Promise<CallToolResult> {
  const raw = objectValue(input);
  const task = requiredString(raw.task, "goblintown_plan requires task");
  const warren = await loadWarren(cwd, { globalFallback: true });
  const payload = {
    task,
    maxNodes: numberValue(raw.maxNodes, 1, 12) ?? 6,
    maxReplan: numberValue(raw.maxReplan, 0, 6) ?? 2,
    cite: arrayOfStrings(raw.citeRiteIds),
    remember: booleanValue(raw.remember),
    budgetTokens: numberValue(raw.budgetTokens, 1),
    maxOutputTokens: numberValue(raw.maxOutputTokens, 64, 12000),
    outputFormat: raw.outputFormat,
  };
  if (normalizeMcpExecutionMode(raw.executionMode) === "harness") {
    return await runMcpHarnessMode({
      server,
      warrenRoot: warren.root,
      warrenScope: warren.scope,
      mode: "plan",
      task,
      payload,
      maxOutputTokens: payload.maxOutputTokens,
    });
  }
  const run = await startMcpTankRun({
    warrenRoot: warren.root,
    mode: "plan",
    payload,
  });
  return textResult({
    mode: "plan",
    runMode: "tank",
    executionMode: "local_provider",
    runId: run.runId,
    tankUrl: run.tankUrl,
    warrenRoot: warren.root,
    warrenScope: warren.scope,
    serverStarted: run.serverStarted,
  }, [
    `Tank plan started: ${run.runId}`,
    `Tank: ${run.tankUrl}`,
    `Warren: ${warren.root} (${warren.scope})`,
  ].join("\n"));
}

async function runMcpHarnessMode(opts: {
  server?: Server;
  warrenRoot: string;
  warrenScope: "project" | "global";
  mode: McpTankMode;
  task: string;
  payload: JsonObject;
  maxOutputTokens?: number;
}): Promise<CallToolResult> {
  const config = buildMcpHarnessRunConfig({
    mode: opts.mode,
    task: opts.task,
    payload: opts.payload,
    warrenRoot: opts.warrenRoot,
    warrenScope: opts.warrenScope,
  });
  const sampled = opts.server
    ? await tryMcpHarnessSampling(opts.server, config, opts.maxOutputTokens)
    : undefined;
  const structured: JsonObject = {
    ...config,
    ...(sampled?.text
      ? {
          output: sampled.text,
          sampling: {
            ok: true,
            model: sampled.model,
            stopReason: sampled.stopReason,
          },
        }
      : {
          sampling: {
            ok: false,
            message: sampled?.error ?? "host sampling unavailable; use harnessPrompt in this conversation",
          },
        }),
  };
  return textResult(
    structured,
    sampled?.text ?? [
      `Goblintown ${opts.mode} configured for host-harness execution.`,
      "",
      "Token policy: use the connected harness/model tokens by default. Do not spend local provider tokens unless executionMode=local_provider was explicitly requested.",
      "",
      "Harness prompt:",
      config.harnessPrompt,
    ].join("\n"),
  );
}

export function buildMcpHarnessRunConfig(opts: {
  mode: McpTankMode;
  task: string;
  payload: JsonObject;
  warrenRoot: string;
  warrenScope: "project" | "global";
}): McpHarnessRunConfig {
  return {
    mode: opts.mode,
    runMode: "harness",
    executionMode: "harness",
    task: opts.task,
    warrenRoot: opts.warrenRoot,
    warrenScope: opts.warrenScope,
    payload: opts.payload,
    tokenPolicy: {
      default: "host_harness",
      localProviderOptIn:
        "Pass executionMode=local_provider, or set GOBLINTOWN_MCP_EXECUTION_MODE=local_provider, to start the Tank and spend the configured local provider.",
    },
    harnessPrompt: buildHarnessPrompt(opts.mode, opts.payload),
  };
}

async function tryMcpHarnessSampling(
  server: Server,
  config: McpHarnessRunConfig,
  maxOutputTokens?: number,
): Promise<{ text?: string; model?: string; stopReason?: string; error?: string }> {
  try {
    const response = await server.createMessage({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: config.harnessPrompt,
          },
        },
      ],
      maxTokens: Math.min(Math.max(maxOutputTokens ?? 3000, 256), 12000),
      systemPrompt:
        "You are executing a configured Goblintown harness run. Use the current host model tokens; do not call local provider APIs. Return the final answer directly.",
    });
    return {
      text: textFromSamplingResult(response),
      model: response.model,
      stopReason: response.stopReason,
    };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function textFromSamplingResult(response: CreateMessageResult): string {
  const content = response.content;
  if (Array.isArray(content)) {
    return content
      .map((block) => block.type === "text" ? block.text : "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return content.type === "text" ? content.text.trim() : "";
}

function buildHarnessPrompt(mode: McpTankMode, payload: JsonObject): string {
  const task = requiredString(payload.task, `configured ${mode} requires task`);
  const outputFormat = stringValue(payload.outputFormat) ?? "freeform";
  if (mode === "plan") {
    const maxNodes = numberValue(payload.maxNodes, 1, 12) ?? 6;
    const maxReplan = numberValue(payload.maxReplan, 0, 6) ?? 2;
    return [
      "Run a Goblintown-style planner DAG using this host harness.",
      `Task: ${task}`,
      `Node cap: ${maxNodes}`,
      `Replan cap: ${maxReplan}`,
      `Output format: ${outputFormat}`,
      "",
      "Decompose the task into a small DAG of narrow sub-rites, solve the nodes in dependency order, replan only when a node exposes a real blocker, then synthesize a final answer. Keep the result practical and cite any assumptions.",
    ].join("\n");
  }
  const packSize = numberValue(payload.packSize, 1, 8) ?? 3;
  const personality = stringValue(payload.personality);
  const flags = [
    booleanValue(payload.debate) ? "debate" : "",
    booleanValue(payload.trollTools) ? "tool-aware review" : "",
    booleanValue(payload.noFallback) ? "no fallback" : "",
    booleanValue(payload.noSpecialist) ? "no specialist recovery" : "",
    booleanValue(payload.remember) ? "remember relevant prior artifacts if available" : "",
  ].filter(Boolean);
  return [
    "Run a Goblintown-style rite using this host harness.",
    `Task: ${task}`,
    `Pack size: ${packSize}`,
    `Personality: ${personality ?? "mixed"}`,
    `Output format: ${outputFormat}`,
    flags.length ? `Options: ${flags.join(", ")}` : "Options: default rite flow",
    "",
    "Create independent candidate answers, critique them for correctness and hidden failure modes, recover from any weak spots, then produce one clear final answer. Use the current host model tokens only; do not call local provider APIs.",
  ].join("\n");
}

async function callMcpProvider(cwd: string, input: unknown): Promise<CallToolResult> {
  const raw = objectValue(input);
  const slot = normalizeModelSlot(raw.slot);
  const warren = await loadWarren(cwd, { globalFallback: true });
  const storedSecrets = readProviderSecretsForRootSync(warren.root);
  const runtime = slot
    ? resolveProviderRuntimeForSlot(slot, warren.manifest.provider, process.env, storedSecrets)
    : resolveProviderRuntime(warren.manifest.provider, process.env, storedSecrets);
  return textResult({
    warrenRoot: warren.root,
    warrenScope: warren.scope,
    slot,
    provider: safeProviderRuntime(runtime),
    routes: warren.manifest.provider?.routes ?? {},
  });
}

function safeProviderRuntime(runtime: ReturnType<typeof resolveProviderRuntime>): JsonObject {
  return {
    id: runtime.id,
    label: runtime.label,
    baseURL: runtime.baseURL,
    apiKeyEnv: runtime.apiKeyEnv,
    apiKeySource: runtime.apiKeySource,
    missingApiKey: runtime.missingApiKey,
    outputFormat: runtime.outputFormat,
    models: runtime.models,
  };
}

function chatGptInvokingLabel(toolName: string): string {
  switch (toolName) {
    case "goblintown_tank":
      return "Opening the Tank";
    case "goblintown_rite":
      return "Configuring the rite";
    case "goblintown_plan":
      return "Configuring the plan";
    case "goblintown_chat":
      return "Asking Single Goblin";
    case "goblintown_provider":
      return "Checking provider";
    case "goblintown_doctor":
      return "Checking setup";
    default:
      return "Running Goblintown";
  }
}

function chatGptInvokedLabel(toolName: string): string {
  switch (toolName) {
    case "goblintown_tank":
      return "Tank ready";
    case "goblintown_rite":
      return "Rite configured";
    case "goblintown_plan":
      return "Plan configured";
    case "goblintown_chat":
      return "Single Goblin answered";
    case "goblintown_provider":
      return "Provider checked";
    case "goblintown_doctor":
      return "Setup checked";
    default:
      return "Goblintown finished";
  }
}

function buildChatGptTankWidgetHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; font-family: ui-monospace, Menlo, Consolas, monospace; }
  body { margin: 0; background: #0d1410; color: #d8efb6; }
  main { display: grid; gap: 12px; padding: 16px; min-height: 180px; }
  h1 { margin: 0; font-size: 18px; }
  p { margin: 0; color: #b9d3a8; line-height: 1.45; }
  button { width: fit-content; border: 1px solid #8fcf52; background: #8fcf52; color: #0d1410; padding: 8px 12px; font: inherit; cursor: pointer; }
  button.secondary { border-color: #1f2d18; background: #0a0e08; color: #d8efb6; }
  code { color: #c2f37a; }
  .status { border-left: 3px solid #8fcf52; padding-left: 10px; }
</style>
</head>
<body>
<main>
  <h1>Goblintown Tank</h1>
  <p class="status" id="status">Ready for a ChatGPT handoff.</p>
  <p id="details">Call <code>goblintown_tank</code> to open or reuse the local Tank, or run a rite/plan in harness mode.</p>
  <div>
    <button id="open-tank">Open Tank</button>
    <button class="secondary" id="ask-rite">Run rite here</button>
  </div>
</main>
<script>
const bridge = window.openai;
const statusEl = document.getElementById("status");
const detailsEl = document.getElementById("details");
let tankUrl = bridge?.toolOutput?.tankUrl || bridge?.toolResponseMetadata?.mcp_tool_result?.structuredContent?.tankUrl;

function render() {
  const output = bridge?.toolOutput || {};
  tankUrl = output.tankUrl || tankUrl;
  statusEl.textContent = tankUrl ? "Tank ready: " + tankUrl : "Ready for a ChatGPT handoff.";
  detailsEl.textContent = output.runId ? "Run id: " + output.runId : "Use ChatGPT for harness-token work; choose local-provider execution only when you want the local Tank to spend configured provider tokens.";
}

window.addEventListener("openai:set_globals", render);
render();

document.getElementById("open-tank").addEventListener("click", async () => {
  if (bridge?.callTool) {
    await bridge.callTool("goblintown_tank", {});
    return;
  }
  if (tankUrl) window.open(tankUrl, "_blank", "noopener");
});

document.getElementById("ask-rite").addEventListener("click", async () => {
  await bridge?.sendFollowUpMessage?.({
    prompt: "Run a Goblintown rite for the current task using ChatGPT harness tokens.",
    scrollToBottom: true
  });
});
</script>
</body>
</html>`;
}

function textResult(payload: JsonObject, text = JSON.stringify(payload, null, 2)): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: payload,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requiredString(value: unknown, message: string): string {
  const normalized = stringValue(value);
  if (!normalized) throw new Error(message);
  return normalized;
}

function numberValue(value: unknown, min: number, max = Number.POSITIVE_INFINITY): number | undefined {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(raw)) return undefined;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}

export function normalizeMcpExecutionMode(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): McpExecutionMode {
  const raw = stringValue(value) ?? stringValue(env.GOBLINTOWN_MCP_EXECUTION_MODE);
  if (raw === "local" || raw === "tank" || raw === "local-provider") return "local_provider";
  return raw && (MCP_EXECUTION_MODES as readonly string[]).includes(raw)
    ? (raw as McpExecutionMode)
    : "harness";
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => !!item);
}

function normalizePersonality(value: unknown): Personality | undefined {
  const raw = stringValue(value);
  return raw && (PERSONALITIES as readonly string[]).includes(raw)
    ? (raw as Personality)
    : undefined;
}

function normalizeModelSlot(value: unknown): ModelSlot | undefined {
  const raw = stringValue(value);
  return raw && (MCP_MODEL_SLOTS as readonly string[]).includes(raw)
    ? (raw as ModelSlot)
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
