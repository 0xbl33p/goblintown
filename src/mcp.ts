import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  normalizeChatMessages,
  runSingleGoblinChat,
  type ChatMessage,
} from "./chat.js";
import {
  CHATGPT_HOST_CAPABILITIES,
  CHATGPT_HOST_MODEL_PROFILES,
  CHATGPT_HOST_MODEL_PROFILE_NOTES,
  buildChatGptHostChatPacket,
  buildChatGptHostPlanPacket,
  buildChatGptHostRitePacket,
  type ChatGptHostModelProfile,
} from "./chatgpt-host-runner.js";
import { buildToolRegistry } from "./addons.js";
import { findRelevantArtifactsEmbedded } from "./embeddings.js";
import { normalizeOutputFormat } from "./formatting.js";
import { executePlan } from "./plan-executor.js";
import { planTask } from "./planner.js";
import { loadRewardPlugin } from "./reward-plugin.js";
import { performRite } from "./rite.js";
import { serve, type ServeHandle, type ServeOptions } from "./server.js";
import { withProviderRoot } from "./openai-client.js";
import { resolveProviderRuntime, resolveProviderRuntimeForSlot } from "./providers.js";
import { readProviderSecretsForRootSync } from "./provider-secrets.js";
import { loadWarren, type Warren } from "./warren.js";
import type { Artifact, ModelSlot, Personality } from "./types.js";

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
export const GOBLINTOWN_CHATGPT_WIDGET_URI = "ui://goblintown/tank-v2.html";
export const GOBLINTOWN_CHATGPT_WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

export type JsonObject = Record<string, unknown>;
export type McpTankMode = "rite" | "plan";
export type McpExecutionMode = "board" | "local_provider";
type ServeImpl = (opts: ServeOptions) => Promise<ServeHandle>;
type FetchImpl = typeof fetch;

const mcpTankServers = new Map<string, Promise<McpTankServer>>();
const MCP_EXECUTION_MODES: readonly McpExecutionMode[] = ["board", "local_provider"];

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
  chatgptWidgetDomain?: string;
  chatgptTankUrl?: string;
  hostedApp?: boolean;
  hostedBaseUrl?: string;
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
  startTimeoutMs?: number;
  serveImpl?: ServeImpl;
  fetchImpl?: FetchImpl;
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

type ToolOutputSchema = NonNullable<Tool["outputSchema"]>;

const WARREN_SCOPE_OUTPUT_SCHEMA = { type: "string", enum: ["project", "global"] };
const PROVIDER_RUNTIME_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    baseURL: { type: "string" },
    apiKeyEnv: { type: "string" },
    apiKeySource: { type: "string" },
    missingApiKey: { type: "string" },
    outputFormat: { type: "string" },
    models: { type: "object", additionalProperties: { type: "string" } },
  },
  additionalProperties: true,
};
const TANK_OUTPUT_SCHEMA: ToolOutputSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["tank"] },
    runMode: { type: "string", enum: ["autopilot"] },
    tankUrl: { type: "string" },
    warrenRoot: { type: "string" },
    warrenScope: WARREN_SCOPE_OUTPUT_SCHEMA,
    serverStarted: { type: "boolean" },
    hosted: { type: "boolean" },
    externalLaunchAvailable: { type: "boolean" },
    openAction: { type: "string", enum: ["external_url", "chatgpt_widget"] },
  },
  required: ["mode", "runMode", "tankUrl", "warrenRoot", "warrenScope", "serverStarted"],
};
const CHAT_OUTPUT_SCHEMA: ToolOutputSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["single_goblin"] },
    runMode: { type: "string", enum: ["chatgpt", "provider"] },
    lootId: { type: "string" },
    message: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["assistant"] },
        content: { type: "string" },
      },
      required: ["role", "content"],
    },
    goblintownOffer: {
      type: "object",
      properties: {
        task: { type: "string" },
        requested: { type: "boolean" },
        reason: { type: "string", enum: ["explicit", "complex"] },
      },
      required: ["task", "requested", "reason"],
    },
    usage: { type: "object", additionalProperties: true },
    hostRun: { type: "object", additionalProperties: true },
  },
  required: ["mode", "lootId", "message"],
};
const RITE_OUTPUT_SCHEMA: ToolOutputSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["rite"] },
    runMode: { type: "string", enum: ["board", "tank", "chatgpt"] },
    executionMode: { type: "string", enum: ["board", "local_provider"] },
    task: { type: "string" },
    runId: { type: "string" },
    riteId: { type: "string" },
    winnerLootId: { type: "string" },
    artifactId: { type: "string" },
    outcome: { type: "string" },
    finalRiteId: { type: "string" },
    finalLootId: { type: "string" },
    finalArtifactId: { type: "string" },
    tankUrl: { type: "string" },
    warrenRoot: { type: "string" },
    warrenScope: WARREN_SCOPE_OUTPUT_SCHEMA,
    serverStarted: { type: "boolean" },
    payload: { type: "object", additionalProperties: true },
    parentArtifactIds: { type: "array", items: { type: "string" } },
    events: { type: "array", items: { type: "object", additionalProperties: true } },
    tokenPolicy: {
      type: "object",
      properties: {
        default: { type: "string", enum: ["configured_providers", "chatgpt_host"] },
        localProviderOptIn: { type: "string" },
      },
      required: ["default", "localProviderOptIn"],
    },
    hostRun: { type: "object", additionalProperties: true },
    output: { type: "string" },
  },
  required: ["mode", "runMode", "executionMode", "warrenRoot", "warrenScope"],
};
const PLAN_OUTPUT_SCHEMA: ToolOutputSchema = {
  ...RITE_OUTPUT_SCHEMA,
  properties: {
    ...RITE_OUTPUT_SCHEMA.properties,
    mode: { type: "string", enum: ["plan"] },
  },
};
const PROVIDER_OUTPUT_SCHEMA: ToolOutputSchema = {
  type: "object",
  properties: {
    warrenRoot: { type: "string" },
    warrenScope: WARREN_SCOPE_OUTPUT_SCHEMA,
    slot: { type: "string", enum: [...MCP_MODEL_SLOTS] },
    chatgptApp: {
      type: "object",
      properties: {
        defaultRunner: { type: "string", enum: ["chatgpt_host"] },
        openAiApiKeyRequired: { type: "boolean" },
        note: { type: "string" },
      },
    },
    provider: PROVIDER_RUNTIME_OUTPUT_SCHEMA,
    routes: { type: "object", additionalProperties: true },
  },
  required: ["warrenRoot", "warrenScope", "provider", "routes"],
};
const DOCTOR_OUTPUT_SCHEMA: ToolOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    cwd: { type: "string" },
    tools: { type: "array", items: { type: "string" } },
    config: { type: "object", additionalProperties: true },
    codexToml: { type: "string" },
    projectReady: { type: "boolean" },
    warrenRoot: { type: "string" },
    warren: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        root: { type: "string" },
        scope: WARREN_SCOPE_OUTPUT_SCHEMA,
        message: { type: "string" },
        nextStep: { type: "string" },
      },
      required: ["ok"],
    },
    provider: PROVIDER_RUNTIME_OUTPUT_SCHEMA,
    voice: { type: "object", additionalProperties: true },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "cwd", "tools", "config", "codexToml", "projectReady", "warren"],
};
const CAPABILITIES_OUTPUT_SCHEMA: ToolOutputSchema = {
  type: "object",
  properties: {
    surface: { type: "string", enum: ["chatgpt_app", "local_tank", "website", "all"] },
    defaultRunner: { type: "string", enum: ["chatgpt_host", "configured_providers"] },
    openAiApiKeyRequired: { type: "boolean" },
    modelProfiles: { type: "object", additionalProperties: { type: "string" } },
    capabilities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          hosted: { type: "string" },
          local: { type: "string" },
          note: { type: "string" },
        },
        required: ["key", "label", "hosted", "local", "note"],
      },
    },
    websiteSurfaces: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          label: { type: "string" },
          audience: { type: "string" },
          status: { type: "string" },
          note: { type: "string" },
        },
        required: ["path", "label", "audience", "status", "note"],
      },
    },
    boundaries: { type: "array", items: { type: "string" } },
  },
  required: ["surface", "defaultRunner", "openAiApiKeyRequired", "modelProfiles", "capabilities", "boundaries"],
};
const MODEL_PROFILE_INPUT_SCHEMA = {
  type: "string",
  enum: [...CHATGPT_HOST_MODEL_PROFILES],
  description:
    "Hint for which Goblintown model lane to use. ChatGPT-hosted mode cannot force the underlying ChatGPT model, but it records the intended lane and maps it to local/provider routes when available.",
};

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
    outputSchema: TANK_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
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
    outputSchema: CHAT_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "goblintown_rite",
    title: "Goblintown Rite",
    description:
      "Run a full Goblintown rite through the existing board loop: Raccoon context, Goblin pack, optional debate, Gremlin chaos, Troll review, specialist recovery, Ogre fallback, and Pigeon/Scribe memory.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task for the full Goblintown rite." },
        executionMode: {
          type: "string",
          enum: [...MCP_EXECUTION_MODES],
          description:
            "board (default) runs the Goblintown gates. In the ChatGPT app, OpenAI-model work is host-run by ChatGPT and needs no API key. Outside ChatGPT, board uses configured provider routes. local_provider starts the Tank run UI.",
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
        modelProfile: MODEL_PROFILE_INPUT_SCHEMA,
      },
      required: ["task"],
    },
    outputSchema: RITE_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "goblintown_plan",
    title: "Goblintown Planner",
    description:
      "Run the existing Goblintown Planner DAG plus sub-rite board loops, with recursive replan on failure and configured provider routes for each creature slot.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Complex task for the planner DAG." },
        executionMode: {
          type: "string",
          enum: [...MCP_EXECUTION_MODES],
          description:
            "board (default) runs the Planner and sub-rites. In the ChatGPT app, OpenAI-model work is host-run by ChatGPT and needs no API key. Outside ChatGPT, board uses configured provider routes. local_provider starts the Tank run UI.",
        },
        maxNodes: { type: "number", minimum: 1, maximum: 12 },
        maxReplan: { type: "number", minimum: 0, maximum: 6 },
        citeRiteIds: { type: "array", items: { type: "string" } },
        remember: { type: "boolean" },
        budgetTokens: { type: "number", minimum: 1 },
        maxOutputTokens: { type: "number", minimum: 64, maximum: 12000 },
        outputFormat: { type: "string", enum: ["freeform", "markdown", "json"] },
        modelProfile: MODEL_PROFILE_INPUT_SCHEMA,
      },
      required: ["task"],
    },
    outputSchema: PLAN_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
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
    outputSchema: PROVIDER_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "goblintown_capabilities",
    title: "Goblintown Capabilities",
    description:
      "Return the Goblintown product capability map for ChatGPT, the local Tank, website dashboard/admin, model profiles, embeddings, memory, research tools, and cloud/userland boundaries. Use this before promising that a feature is available in the hosted ChatGPT app.",
    inputSchema: {
      type: "object",
      properties: {
        surface: {
          type: "string",
          enum: ["chatgpt_app", "local_tank", "website", "all"],
          description: "Surface to summarize. Defaults to all.",
        },
      },
    },
    outputSchema: CAPABILITIES_OUTPUT_SCHEMA,
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
    outputSchema: DOCTOR_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

export function buildGoblintownMcpTools(
  opts: { chatgptApp?: boolean; hostedApp?: boolean } = {},
): Tool[] {
  const tools = opts.hostedApp
    ? GOBLINTOWN_MCP_TOOLS.filter((tool) => tool.name !== "goblintown_chat").map(hostedMcpTool)
    : GOBLINTOWN_MCP_TOOLS;
  if (!opts.chatgptApp) return tools;
  return tools.map((tool) => {
    const chatGptTool = chatGptMcpTool(tool);
    return {
      ...chatGptTool,
      _meta: {
        ...chatGptTool._meta,
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
    };
  });
}

function hostedMcpTool(tool: Tool): Tool {
  switch (tool.name) {
    case "goblintown_tank":
      return {
        ...tool,
        description:
          "Open the hosted Goblintown ChatGPT widget surface and return its stable URL. In hosted mode this does not launch a local Tank on the user's machine.",
      };
    case "goblintown_chat":
      return {
        ...tool,
        description:
          "Local-provider Single Goblin is unavailable on the hosted endpoint. Use this only to explain that the user should use the local Codex plugin or ask ChatGPT directly.",
      };
    case "goblintown_rite":
    case "goblintown_plan":
      return {
        ...tool,
        description: `${tool.description} Hosted ChatGPT mode returns a model-visible board packet for ChatGPT to execute, so OpenAI API keys are not required. It rejects local_provider Tank execution.`,
      };
    default:
      return tool;
  }
}

function chatGptMcpTool(tool: Tool): Tool {
  switch (tool.name) {
    case "goblintown_chat":
      return {
        ...tool,
        description:
          "Prepare a Single Goblin prompt packet for ChatGPT to execute as the host model. This does not require OPENAI_API_KEY; ChatGPT should answer after the tool returns.",
      };
    case "goblintown_rite":
      return {
        ...tool,
        description:
          "Prepare a full Goblintown rite board packet for ChatGPT to execute as the host model: Raccoon context, Goblin pack, optional debate, Gremlin chaos, Troll review, specialist recovery, Ogre fallback, and Pigeon/Scribe note. This does not require OPENAI_API_KEY.",
        inputSchema: chatGptHostOnlyExecutionSchema(tool.inputSchema),
      };
    case "goblintown_plan":
      return {
        ...tool,
        description:
          "Prepare a Goblintown Planner DAG packet for ChatGPT to execute as the host model, then run each node through the rite gates. This does not require OPENAI_API_KEY.",
        inputSchema: chatGptHostOnlyExecutionSchema(tool.inputSchema),
      };
    case "goblintown_provider":
      return {
        ...tool,
        description:
          "Show optional local/provider routing state. In the ChatGPT app, OpenAI-model work defaults to ChatGPT host execution and does not require OPENAI_API_KEY.",
      };
    default:
      return tool;
  }
}

function chatGptHostOnlyExecutionSchema(schema: Tool["inputSchema"]): Tool["inputSchema"] {
  return {
    ...schema,
    properties: {
      ...(schema.properties ?? {}),
      executionMode: {
        type: "string",
        enum: ["board"],
        description:
          "board is the only ChatGPT app execution mode. ChatGPT executes the returned Goblintown board packet, so no OpenAI API key is required.",
      },
    },
  };
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

function normalizeChatGptHostModelProfile(value: unknown): ChatGptHostModelProfile | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  return (CHATGPT_HOST_MODEL_PROFILES as readonly string[]).includes(raw)
    ? raw as ChatGptHostModelProfile
    : undefined;
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

  if (opts.serveImpl) return startOrVerifyMcpTankServer(opts, port, serveImpl);

  const key = `${resolve(opts.warrenRoot)}:${port}`;
  const existing = mcpTankServers.get(key);
  if (existing) return existing;

  let started: Promise<McpTankServer>;
  started = startOrVerifyMcpTankServer(opts, port, serveImpl).catch((err) => {
    if (mcpTankServers.get(key) === started) mcpTankServers.delete(key);
    throw err;
  });
  mcpTankServers.set(key, started);
  return started;
}

async function startOrVerifyMcpTankServer(
  opts: McpTankOpenOptions,
  port: number,
  serveImpl: ServeImpl,
): Promise<McpTankServer> {
  try {
    const handle = await serveImpl({
      cwd: opts.warrenRoot,
      port,
      autopilot: true,
      quiet: true,
    });
    return { url: handle.url, handle, serverStarted: true };
  } catch (err) {
    if (isAddressInUse(err)) {
      return verifyExistingMcpTankServer(opts, port);
    }
    throw err;
  }
}

async function verifyExistingMcpTankServer(
  opts: McpTankOpenOptions,
  port: number,
): Promise<McpTankServer> {
  const tankUrl = `http://localhost:${port}/`;
  const identityUrl = new URL("/api/identity", tankUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.startTimeoutMs ?? 2_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(identityUrl, { signal: controller.signal });
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(
        `Tank port ${port} is already in use, but /api/identity timed out after ${timeoutMs}ms. ` +
          "Stop that process or choose another Tank port.",
      );
    }
    throw new Error(
      `Tank port ${port} is already in use, but Goblintown could not verify its Warren identity: ${errorMessage(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(
      `Tank port ${port} is already in use by a server that did not expose /api/identity (${response.status}). ` +
        "Stop that process or choose another Tank port.",
    );
  }

  const identity = await response.json().catch(() => ({})) as JsonObject;
  const actualRoot = stringValue(identity.root);
  const expectedRoot = resolve(opts.warrenRoot);
  if (!actualRoot) {
    throw new Error(
      `Tank port ${port} is already in use, but /api/identity did not report a Warren root. ` +
        "Stop that process or choose another Tank port.",
    );
  }
  if (resolve(actualRoot) !== expectedRoot) {
    throw new Error(
      `Tank port ${port} is already in use by Warren ${actualRoot}, not ${opts.warrenRoot}. ` +
        "Stop the existing Tank or choose another Tank port.",
    );
  }

  return {
    url: tankUrl,
    serverStarted: false,
  };
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
  const tools = buildGoblintownMcpTools({
    chatgptApp: opts.chatgptApp,
    hostedApp: opts.hostedApp,
  });
  const chatgptWidgetDomain = originFromUrl(opts.chatgptWidgetDomain);
  const chatgptTankUrl = opts.chatgptTankUrl ? opts.chatgptTankUrl.replace(/\/+$/u, "") : undefined;
  const hostedBaseUrl = opts.hostedBaseUrl ? opts.hostedBaseUrl.replace(/\/+$/u, "") : undefined;
  const widgetRedirectDomains = opts.hostedApp
    ? [chatgptWidgetDomain ?? originFromUrl(hostedBaseUrl)].filter((domain): domain is string => !!domain)
    : [chatgptTankUrl ?? "http://localhost:7777", `http://127.0.0.1:${mcpTankPort()}`];
  const server = new Server(
    { name: "goblintown", version: opts.version ?? process.env.npm_package_version ?? "0.7.0-beta.5" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: opts.chatgptApp
        ? "Goblintown is the board logic; ChatGPT is the host model surface. Use goblintown_rite or goblintown_plan with executionMode=board to get the deterministic Goblintown gate packet, then execute that packet in your next answer using ChatGPT. Do not ask for OPENAI_API_KEY in the ChatGPT app. Use local_provider only when the user explicitly asks to spend local/provider credentials or open the local Tank; hosted endpoints reject local_provider."
        : "Goblintown is the board logic; the connected chat surface only starts and reports runs. When the user asks Goblintown to solve work, use goblintown_rite or goblintown_plan with executionMode=board unless they explicitly ask to open the Tank. Use goblintown_doctor when setup is uncertain.",
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
    const chatgptWidgetAssetDomain = chatgptWidgetDomain ? `${chatgptWidgetDomain}/assets` : "/assets";
    return {
      contents: [
        {
          uri: GOBLINTOWN_CHATGPT_WIDGET_URI,
          mimeType: GOBLINTOWN_CHATGPT_WIDGET_MIME_TYPE,
          text: buildOriginalLikeChatGptTankWidgetHtml(chatgptWidgetAssetDomain),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [],
                resourceDomains: chatgptWidgetDomain ? [chatgptWidgetDomain] : [],
                frameDomains: chatgptWidgetDomain ? [chatgptWidgetDomain] : [],
              },
              ...(chatgptWidgetDomain ? { domain: chatgptWidgetDomain } : {}),
            },
            "openai/widgetDescription":
              "Shows the Goblintown Tank handoff and lets the user reopen the local Tank when available.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: chatgptWidgetDomain ? [chatgptWidgetDomain] : [],
              frame_domains: chatgptWidgetDomain ? [chatgptWidgetDomain] : [],
              redirect_domains: widgetRedirectDomains,
            },
            ...(chatgptWidgetDomain ? { "openai/widgetDomain": chatgptWidgetDomain } : {}),
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
          return opts.hostedApp
            ? await callHostedMcpTank(cwd, args, hostedBaseUrl)
            : await callMcpTank(cwd, args, {
              chatgptApp: opts.chatgptApp,
              chatgptTankUrl,
            });
        case "goblintown_chat":
          if (opts.hostedApp) {
            return errorResult(
              "goblintown_chat is local-provider-only on this release. Use goblintown_rite or goblintown_plan in board mode, or use the local Codex plugin for Single Goblin.",
            );
          }
          return await callMcpChat(cwd, args, { chatgptApp: opts.chatgptApp });
        case "goblintown_rite":
          return await callMcpRite(cwd, args, server, {
            chatgptApp: opts.chatgptApp,
            hostedApp: opts.hostedApp,
          });
        case "goblintown_plan":
          return await callMcpPlan(cwd, args, server, {
            chatgptApp: opts.chatgptApp,
            hostedApp: opts.hostedApp,
          });
        case "goblintown_provider":
          return await callMcpProvider(cwd, args, { chatgptApp: opts.chatgptApp });
        case "goblintown_capabilities":
          return callMcpCapabilities(args, {
            chatgptApp: opts.chatgptApp,
            hostedApp: opts.hostedApp,
          });
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

function originFromUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
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

async function callMcpTank(
  cwd: string,
  input: unknown,
  opts: { chatgptApp?: boolean; chatgptTankUrl?: string } = {},
): Promise<CallToolResult> {
  const raw = objectValue(input);
  const warren = await loadWarren(cwd, { globalFallback: true });
  const tank = await openMcpTank({
    warrenRoot: warren.root,
    port: numberValue(raw.port, 1, 65535),
  });
  const tankUrl = opts.chatgptApp && opts.chatgptTankUrl
    ? `${opts.chatgptTankUrl.replace(/\/+$/u, "")}/tank`
    : tank.tankUrl;
  return textResult({
    mode: "tank",
    runMode: "autopilot",
    tankUrl,
    warrenRoot: warren.root,
    warrenScope: warren.scope,
    serverStarted: tank.serverStarted,
    hosted: Boolean(opts.chatgptApp && opts.chatgptTankUrl),
    externalLaunchAvailable: !(opts.chatgptApp && opts.chatgptTankUrl),
    openAction: opts.chatgptApp && opts.chatgptTankUrl ? "chatgpt_widget" : "external_url",
  }, [
    `Goblintown Tank ready: ${tankUrl}`,
    "Mode: AI-autopilot",
    `Warren: ${warren.root} (${warren.scope})`,
  ].join("\n"));
}

async function callHostedMcpTank(
  cwd: string,
  _input: unknown,
  hostedBaseUrl: string | undefined,
): Promise<CallToolResult> {
  const warren = await loadWarren(cwd, { globalFallback: true });
  const tankUrl = hostedBaseUrl ?? "https://goblintown-mcp.vercel.app";
  return textResult({
    mode: "tank",
    runMode: "autopilot",
    tankUrl,
    warrenRoot: warren.root,
    warrenScope: warren.scope,
    serverStarted: false,
    hosted: true,
    externalLaunchAvailable: false,
    openAction: "chatgpt_widget",
  }, [
    `Goblintown hosted endpoint ready: ${tankUrl}`,
    "Mode: hosted board adapter",
    "Open Tank expands the ChatGPT widget instead of opening a separate hosted page.",
    "Local Tank launch is only available from the local Codex plugin or local ChatGPT dev adapter.",
  ].join("\n"));
}

async function callMcpChat(
  cwd: string,
  input: unknown,
  opts: { chatgptApp?: boolean } = {},
): Promise<CallToolResult> {
  const args = normalizeMcpChatArgs(input);
  const warren = await loadWarren(cwd, { globalFallback: true });
  if (opts.chatgptApp) {
    const hostRun = buildChatGptHostChatPacket({
      messages: args.messages,
      personality: args.personality,
      modelSlot: args.modelSlot,
    });
    const prompt = String(hostRun.prompt ?? "");
    return textResult({
      mode: "single_goblin",
      runMode: "chatgpt",
      lootId: String(hostRun.runId ?? "chatgpt-host"),
      message: {
        role: "assistant",
        content: prompt,
      },
      hostRun,
      warrenRoot: warren.root,
      warrenScope: warren.scope,
      tokenPolicy: {
        default: "chatgpt_host",
        localProviderOptIn:
          "The ChatGPT app uses ChatGPT as the OpenAI-model host. No OPENAI_API_KEY is required unless the user explicitly opts into local/provider execution.",
      },
    }, prompt);
  }
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
  opts: { chatgptApp?: boolean; hostedApp?: boolean } = {},
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
    modelProfile: normalizeChatGptHostModelProfile(raw.modelProfile),
    cite: arrayOfStrings(raw.citeRiteIds),
    remember: booleanValue(raw.remember),
  };
  const executionMode = normalizeMcpExecutionMode(
    raw.executionMode,
    opts.chatgptApp || opts.hostedApp ? {} : process.env,
  );
  if (executionMode === "board") {
    if (opts.chatgptApp) {
      return await runMcpChatGptHostRite(warren, payload);
    }
    return await runMcpBoardRite(warren, payload);
  }
  if (opts.chatgptApp) {
    return errorResult(
      "local_provider execution is disabled in the ChatGPT app. Use executionMode=board so ChatGPT executes the Goblintown board packet with no OpenAI API key, or use the local Codex plugin/local Tank for provider-backed runs.",
    );
  }
  if (opts.hostedApp) {
    return errorResult(
      "local_provider execution is unavailable on the hosted MCP endpoint. Use executionMode=board for ChatGPT-hosted execution with no OpenAI API key, or use the local Codex plugin/local Tank for local/provider spend.",
    );
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
  opts: { chatgptApp?: boolean; hostedApp?: boolean } = {},
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
    modelProfile: normalizeChatGptHostModelProfile(raw.modelProfile),
  };
  const executionMode = normalizeMcpExecutionMode(
    raw.executionMode,
    opts.chatgptApp || opts.hostedApp ? {} : process.env,
  );
  if (executionMode === "board") {
    if (opts.chatgptApp) {
      return await runMcpChatGptHostPlan(warren, payload);
    }
    return await runMcpBoardPlan(warren, payload);
  }
  if (opts.chatgptApp) {
    return errorResult(
      "local_provider execution is disabled in the ChatGPT app. Use executionMode=board so ChatGPT executes the Goblintown board packet with no OpenAI API key, or use the local Codex plugin/local Tank for provider-backed runs.",
    );
  }
  if (opts.hostedApp) {
    return errorResult(
      "local_provider execution is unavailable on the hosted MCP endpoint. Use executionMode=board for ChatGPT-hosted execution with no OpenAI API key, or use the local Codex plugin/local Tank for local/provider spend.",
    );
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

async function runMcpChatGptHostRite(
  warren: Warren,
  payload: JsonObject,
): Promise<CallToolResult> {
  const task = requiredString(payload.task, "goblintown_rite requires task");
  const parentArtifacts = await loadMcpParentArtifacts(warren, task, payload);
  const hostRun = await buildChatGptHostRitePacket({
    task,
    packSize: numberValue(payload.packSize, 1, 8) ?? 3,
    scanGlobs: arrayOfStrings(payload.scanGlobs),
    cwd: warren.root,
    personality: normalizePersonality(payload.personality),
    noFallback: booleanValue(payload.noFallback),
    noSpecialist: booleanValue(payload.noSpecialist),
    specialistCap: numberValue(payload.specialistCap, 0, 8),
    debate: booleanValue(payload.debate),
    trollTools: booleanValue(payload.trollTools),
    outputFormat: payload.outputFormat,
    modelProfile: normalizeChatGptHostModelProfile(payload.modelProfile),
    parentArtifacts,
  });
  const output = String(hostRun.prompt ?? "");
  return textResult({
    mode: "rite",
    runMode: "chatgpt",
    executionMode: "board",
    task,
    output,
    parentArtifactIds: parentArtifacts.map((artifact) => artifact.id),
    hostRun,
    modelProfile: hostRun.modelProfile,
    capabilities: CHATGPT_HOST_CAPABILITIES,
    warrenRoot: warren.root,
    warrenScope: warren.scope,
    tokenPolicy: {
      default: "chatgpt_host",
      localProviderOptIn:
        "The ChatGPT app uses ChatGPT as the OpenAI-model host. No OPENAI_API_KEY is required unless the user explicitly opts into local/provider execution.",
    },
  }, output);
}

async function runMcpChatGptHostPlan(
  warren: Warren,
  payload: JsonObject,
): Promise<CallToolResult> {
  const task = requiredString(payload.task, "goblintown_plan requires task");
  const parentArtifacts = await loadMcpParentArtifacts(warren, task, payload);
  const hostRun = buildChatGptHostPlanPacket({
    task,
    cwd: warren.root,
    parentArtifacts,
    maxNodes: numberValue(payload.maxNodes, 1, 12) ?? 6,
    maxReplan: numberValue(payload.maxReplan, 0, 6) ?? 2,
    outputFormat: payload.outputFormat,
    modelProfile: normalizeChatGptHostModelProfile(payload.modelProfile),
  });
  const output = String(hostRun.prompt ?? "");
  return textResult({
    mode: "plan",
    runMode: "chatgpt",
    executionMode: "board",
    task,
    output,
    parentArtifactIds: parentArtifacts.map((artifact) => artifact.id),
    hostRun,
    modelProfile: hostRun.modelProfile,
    capabilities: CHATGPT_HOST_CAPABILITIES,
    warrenRoot: warren.root,
    warrenScope: warren.scope,
    tokenPolicy: {
      default: "chatgpt_host",
      localProviderOptIn:
        "The ChatGPT app uses ChatGPT as the OpenAI-model host. No OPENAI_API_KEY is required unless the user explicitly opts into local/provider execution.",
    },
  }, output);
}

async function runMcpBoardRite(
  warren: Warren,
  payload: JsonObject,
): Promise<CallToolResult> {
  const task = requiredString(payload.task, "goblintown_rite requires task");
  const parentArtifacts = await loadMcpParentArtifacts(warren, task, payload);
  const outputFormat = normalizeOutputFormat(payload.outputFormat ?? warren.manifest.provider?.outputFormat);
  const rewardPlugin = await loadRewardPlugin(warren.root);
  const events: JsonObject[] = [];

  const result = await withProviderRoot(warren.root, () =>
    performRite({
      task,
      packSize: numberValue(payload.packSize, 1, 8) ?? 3,
      scanGlobs: arrayOfStrings(payload.scanGlobs),
      cwd: warren.root,
      hoard: warren.hoard,
      personality: normalizePersonality(payload.personality),
      rewardFn: rewardPlugin.fn,
      noFallback: booleanValue(payload.noFallback),
      noSpecialist: booleanValue(payload.noSpecialist),
      specialistCap: numberValue(payload.specialistCap, 0, 8),
      debate: booleanValue(payload.debate),
      trollTools: booleanValue(payload.trollTools),
      tools: booleanValue(payload.trollTools) ? buildToolRegistry(warren.manifest) : undefined,
      budgetTokens: numberValue(payload.budgetTokens, 1),
      maxOutputTokensPerCall: numberValue(payload.maxOutputTokens, 64, 12000),
      outputFormat,
      parentArtifacts,
      onStep: (step) => captureBoardEvent(events, step),
    }),
  );
  const artifact = await warren.hoard.getArtifactByRiteId(result.rite.id);
  const structured: JsonObject = {
    mode: "rite",
    runMode: "board",
    executionMode: "board",
    task,
    riteId: result.rite.id,
    outcome: result.rite.outcome,
    winnerLootId: result.rite.winnerLootId,
    artifactId: artifact?.id,
    output: result.winnerLoot.output,
    parentArtifactIds: parentArtifacts.map((artifact) => artifact.id),
    events,
    warrenRoot: warren.root,
    warrenScope: warren.scope,
    tokenPolicy: {
      default: "configured_providers",
      localProviderOptIn:
        "The board already uses configured provider routes. Use executionMode=local_provider only to open the Tank run UI.",
    },
  };
  return textResult(structured, result.winnerLoot.output);
}

async function runMcpBoardPlan(
  warren: Warren,
  payload: JsonObject,
): Promise<CallToolResult> {
  const task = requiredString(payload.task, "goblintown_plan requires task");
  const parentArtifacts = await loadMcpParentArtifacts(warren, task, payload);
  const outputFormat = normalizeOutputFormat(payload.outputFormat ?? warren.manifest.provider?.outputFormat);
  const rewardPlugin = await loadRewardPlugin(warren.root);
  const events: JsonObject[] = [];
  const maxNodes = numberValue(payload.maxNodes, 1, 12) ?? 6;
  const maxReplan = numberValue(payload.maxReplan, 0, 6) ?? 2;
  const maxOutputTokensPerCall = numberValue(payload.maxOutputTokens, 64, 12000);

  const result = await withProviderRoot(warren.root, async () => {
    const { plan } = await planTask({
      task,
      parentArtifacts,
      maxNodes,
      maxOutputTokens: maxOutputTokensPerCall,
    });
    return executePlan({
      plan,
      cwd: warren.root,
      hoard: warren.hoard,
      rewardFn: rewardPlugin.fn,
      budgetTokens: numberValue(payload.budgetTokens, 1),
      maxOutputTokensPerCall,
      outputFormat,
      parentArtifacts,
      maxReplanDepth: maxReplan,
      onStep: (nodeId, step) => captureBoardEvent(events, { nodeId, ...step }),
      onPlanEvent: (event) => captureBoardEvent(events, event),
    });
  });

  const finalLoot = result.finalLootId ? await warren.hoard.getLoot(result.finalLootId) : null;
  const output = finalLoot?.output
    ?? (result.finalArtifact
      ? JSON.stringify(result.finalArtifact, null, 2)
      : `Plan finished with outcome=${result.outcome}.`);
  const structured: JsonObject = {
    mode: "plan",
    runMode: "board",
    executionMode: "board",
    task,
    outcome: result.outcome,
    finalRiteId: result.finalRiteId,
    finalLootId: result.finalLootId,
    finalArtifactId: result.finalArtifact?.id,
    output,
    parentArtifactIds: parentArtifacts.map((artifact) => artifact.id),
    events,
    warrenRoot: warren.root,
    warrenScope: warren.scope,
    tokenPolicy: {
      default: "configured_providers",
      localProviderOptIn:
        "The board already uses configured provider routes. Use executionMode=local_provider only to open the Tank run UI.",
    },
  };
  return textResult(structured, output);
}

async function loadMcpParentArtifacts(
  warren: Warren,
  task: string,
  payload: JsonObject,
): Promise<Artifact[]> {
  const parentArtifacts: Artifact[] = [];
  for (const riteId of arrayOfStrings(payload.cite)) {
    const artifact = await warren.hoard.getArtifactByRiteId(riteId);
    if (artifact) parentArtifacts.push(artifact);
  }
  if (booleanValue(payload.remember)) {
    const auto = (await findRelevantArtifactsEmbedded({
      artifacts: await warren.hoard.allArtifacts(),
      queryText: task,
      limit: 3,
      hoard: warren.hoard,
    })).filter((artifact) => !parentArtifacts.some((parent) => parent.id === artifact.id));
    parentArtifacts.push(...auto);
  }
  return parentArtifacts;
}

function captureBoardEvent(events: JsonObject[], event: unknown): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const obj = event as JsonObject;
  if (obj.kind === "thinking") return;
  events.push(obj);
  if (events.length > 80) events.shift();
}

async function callMcpProvider(
  cwd: string,
  input: unknown,
  opts: { chatgptApp?: boolean } = {},
): Promise<CallToolResult> {
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
    ...(opts.chatgptApp
      ? {
          chatgptApp: {
            defaultRunner: "chatgpt_host",
            openAiApiKeyRequired: false,
            note:
              "In the ChatGPT app, OpenAI-model work is performed by ChatGPT after the tool returns a host-run packet. Local provider keys are optional and only used for explicit local/provider execution.",
          },
        }
      : {}),
    provider: safeProviderRuntime(runtime),
    routes: warren.manifest.provider?.routes ?? {},
  });
}

function callMcpCapabilities(
  input: unknown,
  opts: { chatgptApp?: boolean; hostedApp?: boolean } = {},
): CallToolResult {
  const raw = objectValue(input);
  const surface = stringValue(raw.surface) ?? "all";
  const normalizedSurface = ["chatgpt_app", "local_tank", "website", "all"].includes(surface)
    ? surface
    : "all";
  const payload = {
    surface: normalizedSurface,
    defaultRunner: opts.chatgptApp || opts.hostedApp ? "chatgpt_host" : "configured_providers",
    openAiApiKeyRequired: !(opts.chatgptApp || opts.hostedApp),
    modelProfiles: CHATGPT_HOST_MODEL_PROFILE_NOTES,
    capabilities: CHATGPT_HOST_CAPABILITIES,
    websiteSurfaces: [
      {
        path: "/",
        label: "Marketing and install guide",
        audience: "public",
        status: "available",
        note: "Public website and ChatGPT Developer Mode instructions.",
      },
      {
        path: "/dashboard",
        label: "User dashboard",
        audience: "signed_in_user",
        status: "planned",
        note: "Userland DB-backed account, Warren metadata, cloud mode, friend codes, discovery, mail, and user settings.",
      },
      {
        path: "/admin",
        label: "Operator admin",
        audience: "staff_admin",
        status: "planned",
        note: "Operational moderation, account support, feature flags, and app-store/demo telemetry. Should be role-gated separately from the user dashboard.",
      },
    ],
    boundaries: [
      "The ChatGPT app cannot force ChatGPT to use an older model or an embeddings model directly.",
      "Embeddings belong to the backend/local Hoard lane; ChatGPT consumes retrieved text, not raw vectors.",
      "Hosted ChatGPT mode must not spend local provider tokens or expose local provider keys.",
      "User sign-in, userland DB storage, dashboard, and operator admin belong to the website/cloud surface and should be opt-in.",
      "Local Tank remains the full-fidelity surface for streaming, settings, provider routing, research tools, Hoard ops, trace export, and reset flows.",
    ],
  };
  const summary = [
    "Goblintown capability map",
    "",
    `Surface: ${normalizedSurface}`,
    `Default runner: ${payload.defaultRunner}`,
    `OpenAI API key required here: ${payload.openAiApiKeyRequired ? "yes" : "no"}`,
    "",
    "Hosted-safe:",
    ...payload.capabilities
      .filter((capability) => capability.hosted !== "local_only")
      .map((capability) => `- ${capability.label}: ${capability.hosted}`),
    "",
    "Website/cloud:",
    ...payload.websiteSurfaces.map((surface) => `- ${surface.path} ${surface.label}: ${surface.status}`),
  ].join("\n");
  return textResult(payload, summary);
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
      return "Running the rite";
    case "goblintown_plan":
      return "Running the plan";
    case "goblintown_chat":
      return "Asking Single Goblin";
    case "goblintown_provider":
      return "Checking provider";
    case "goblintown_capabilities":
      return "Mapping capabilities";
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
      return "Rite finished";
    case "goblintown_plan":
      return "Plan finished";
    case "goblintown_chat":
      return "Single Goblin answered";
    case "goblintown_provider":
      return "Provider checked";
    case "goblintown_capabilities":
      return "Capabilities mapped";
    case "goblintown_doctor":
      return "Setup checked";
    default:
      return "Goblintown finished";
  }
}

function buildOriginalLikeChatGptTankWidgetHtml(assetDomain = "/assets"): string {
  const widgetUri = JSON.stringify(GOBLINTOWN_CHATGPT_WIDGET_URI);
  const assetBase = JSON.stringify(assetDomain.replace(/\/+$/u, ""));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    color-scheme: dark;
    --bg: #0a0e08;
    --panel: rgba(13,15,12,0.86);
    --line: rgba(124,255,91,0.18);
    --fg: #d8efb6;
    --fg-bright: #e6e2d3;
    --muted: #8fa083;
    --muted-deep: #40513a;
    --moss: #8fcf52;
    --acid: #7cff5b;
    --warn: #f3df7a;
    --hot: #f3a052;
    --bubble-bg: rgba(20, 32, 26, 0.78);
    --bubble-border: rgba(143,207,82,0.34);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d0f0c; color: var(--fg); }
  button {
    border: 1px solid rgba(124,255,91,0.3);
    border-radius: 8px;
    background: rgba(124,255,91,0.08);
    color: var(--fg-bright);
    font: inherit;
    font-weight: 650;
    padding: 0.48rem 0.68rem;
    cursor: pointer;
  }
  button:hover { border-color: var(--acid); color: var(--acid); }
  .tank-shell {
    min-height: 650px;
    display: grid;
    grid-template-columns: minmax(150px, 230px) minmax(0, 1fr);
    border: 1px solid var(--line);
    background: #0d0f0c;
    overflow: hidden;
  }
  .sidebar {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    border-right: 1px solid var(--line);
    background: rgba(6,10,6,0.72);
    min-height: 0;
  }
  .sidebar-head { padding: 0.9rem; border-bottom: 1px solid var(--line); }
  .sidebar-head h1 { margin: 0.25rem 0 0; font-size: 1rem; color: var(--fg-bright); }
  .clock {
    color: var(--acid);
    font-size: 0.64rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .sidebar-list {
    min-height: 0;
    overflow: auto;
    padding: 0.6rem;
    display: grid;
    align-content: start;
    gap: 0.38rem;
  }
  .sidebar-item {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    border-radius: 0;
    background: transparent;
    border-color: rgba(124,255,91,0.12);
  }
  .sidebar-item.active {
    background: rgba(124,255,91,0.08);
    border-color: rgba(124,255,91,0.34);
  }
  .sidebar-foot {
    display: grid;
    gap: 0.45rem;
    padding: 0.75rem;
    border-top: 1px solid var(--line);
  }
  .tank {
    position: relative;
    min-height: 650px;
    overflow: hidden;
    background: linear-gradient(180deg, #111c18 0%, #0c1310 65%, #0a0e08 100%);
  }
  .tank-logo-mark {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 0;
    width: min(68%, 680px);
    max-height: 18%;
    object-fit: contain;
    opacity: 0.075;
    pointer-events: none;
    user-select: none;
    transform: translate(-50%, -50%);
    filter: saturate(0.8) brightness(0.75);
    mix-blend-mode: screen;
    animation: logo-float 18s ease-in-out infinite;
  }
  @keyframes logo-float {
    0%, 100% { transform: translate(-50%, -52%); opacity: 0.06; }
    50% { transform: translate(-50%, -48%); opacity: 0.09; }
  }
  .hosted-badge {
    position: absolute;
    top: 0.8rem;
    right: 0.8rem;
    z-index: 8;
    border: 1px solid rgba(124,255,91,0.24);
    border-radius: 999px;
    background: rgba(13,15,12,0.78);
    color: var(--acid);
    padding: 0.34rem 0.56rem;
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .t1, .t2, .t3, .t4 { display: none; }
  .warren[data-visual-tier="1"] .t1 { display: block; }
  .warren[data-visual-tier="2"] .t1, .warren[data-visual-tier="2"] .t2 { display: block; }
  .warren[data-visual-tier="3"] .t1, .warren[data-visual-tier="3"] .t2, .warren[data-visual-tier="3"] .t3 { display: block; }
  .warren[data-visual-tier="4"] .t1, .warren[data-visual-tier="4"] .t2,
  .warren[data-visual-tier="4"] .t3, .warren[data-visual-tier="4"] .t4 { display: block; }
  .warren[data-visual-tier="2"] .t2-flex { display: flex; }
  .warren[data-visual-tier="3"] .t2-flex, .warren[data-visual-tier="3"] .t3-flex { display: flex; }
  .warren[data-visual-tier="4"] .t2-flex, .warren[data-visual-tier="4"] .t3-flex, .warren[data-visual-tier="4"] .t4-flex { display: flex; }
  .t2-flex, .t3-flex, .t4-flex { display: none; }
  .star { position: absolute; color: var(--muted-deep); font-size: 0.7rem; opacity: 0.6; animation: twinkle 4s ease-in-out infinite; }
  @keyframes twinkle { 0%,100% { opacity: 0.6; } 50% { opacity: 0.2; } }
  .mountains {
    position: absolute;
    top: 4%;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 3.2rem;
    line-height: 1;
    filter: brightness(0.5) saturate(0.4);
    letter-spacing: -0.4em;
  }
  .skyline { position: absolute; left: 0; right: 0; text-align: center; line-height: 1; letter-spacing: 0.2em; }
  .skyline.back { top: 13%; font-size: 1.7rem; filter: brightness(0.55) saturate(0.6); }
  .skyline.mid { top: 22%; font-size: 2.5rem; filter: brightness(0.85) saturate(0.85); }
  .banner {
    position: absolute;
    top: 5%;
    left: 50%;
    transform: translateX(-50%);
    color: var(--warn);
    font-size: 0.82rem;
    line-height: 1.05;
    text-align: center;
    white-space: pre;
    letter-spacing: 0.05em;
    text-shadow: 0 0 6px rgba(243,223,122,0.3);
  }
  .trees { position: absolute; bottom: 18%; font-size: 2.2rem; line-height: 1; filter: brightness(0.85); }
  .trees.left { left: 2%; }
  .trees.right { right: 2%; }
  .lantern {
    position: absolute;
    font-size: 1.4rem;
    opacity: 1;
    filter: drop-shadow(0 0 8px rgba(243,223,122,0.6));
    animation: flicker 2.4s ease-in-out infinite;
  }
  @keyframes flicker { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
  .smoke {
    position: absolute;
    color: var(--muted);
    font-size: 0.85rem;
    opacity: 1;
    line-height: 1;
    animation: smoke 4s ease-out infinite;
    pointer-events: none;
  }
  @keyframes smoke {
    0% { opacity: 0; transform: translateY(0) scale(0.9); }
    25% { opacity: 0.6; }
    100% { opacity: 0; transform: translateY(-40px) scale(1.5); }
  }
  .ground {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 5%;
    height: 4px;
    background: repeating-linear-gradient(90deg, var(--muted-deep) 0 14px, transparent 14px 22px);
  }
  .ground-shadow {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 5%;
    background: linear-gradient(180deg, transparent 0%, rgba(143,207,82,0.04) 100%);
  }
  .pigeon-wire { position: absolute; top: 7%; left: 4%; color: var(--muted-deep); font-size: 1.2rem; line-height: 1; white-space: pre; }
  .gremlin-perch { position: absolute; top: 12%; right: 7%; color: var(--muted-deep); font-size: 1.1rem; line-height: 1; white-space: pre; }
  .ogre-cave {
    position: absolute;
    top: 31%;
    left: 3%;
    width: 180px;
    height: 130px;
    border: 2px solid var(--muted-deep);
    border-radius: 90px 90px 0 0;
    background: radial-gradient(ellipse at 50% 60%, #060906 0%, #0a0e08 80%);
    box-shadow: inset 0 0 30px rgba(0,0,0,0.9);
  }
  .ogre-cave-label {
    position: absolute;
    top: 28%;
    left: 6%;
    color: var(--muted);
    font-size: 0.62rem;
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }
  .workshop {
    position: absolute;
    bottom: 14%;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    color: var(--muted);
    font-size: 0.66rem;
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }
  .workshop-fire { font-size: 2.2rem; filter: drop-shadow(0 0 12px rgba(243,160,82,0.5)); animation: fire-flicker 0.7s ease-in-out infinite alternate; }
  @keyframes fire-flicker {
    from { transform: scale(1); filter: drop-shadow(0 0 12px rgba(243,160,82,0.5)); }
    to { transform: scale(1.06); filter: drop-shadow(0 0 18px rgba(243,160,82,0.7)); }
  }
  .troll-bridge {
    position: absolute;
    bottom: 7%;
    right: 7%;
    width: 200px;
    color: var(--muted-deep);
    font-size: 0.72rem;
    line-height: 1.0;
    white-space: pre;
    text-align: center;
  }
  .raccoon-dump { position: absolute; bottom: 7%; left: 9%; font-size: 1.6rem; filter: brightness(0.7); line-height: 1; }
  .hoard {
    position: absolute;
    bottom: 22%;
    left: 50%;
    transform: translateX(-50%);
    font-size: 1.6rem;
    line-height: 1;
    opacity: 1;
    filter: drop-shadow(0 0 10px rgba(243,223,122,0.4));
    text-align: center;
    z-index: 2;
  }
  .creature {
    position: absolute;
    font-size: 2.6rem;
    line-height: 1;
    z-index: 4;
    transition: filter .25s, opacity .3s;
    user-select: none;
  }
  .creature .emoji { display: block; line-height: 1; }
  .creature .sprite-shell { display: none; margin: 0 auto; }
  .creature.pigeon-animated { font-size: 2.2rem; }
  .creature.pigeon-animated .emoji { display: none; }
  .creature.pigeon-animated .sprite-shell { display: block; width: 92px; height: 92px; }
  .creature.idle-sprite-animated .emoji { display: none; }
  .creature.idle-sprite-animated .idle-sprite { display: block; }
  .creature.raccoon-animated .emoji { display: none; }
  .creature.raccoon-animated .idle-sprite { display: block; width: 96px; height: 96px; }
  .creature.troll-animated .emoji { display: none; }
  .creature.troll-animated .idle-sprite { display: block; width: 96px; height: 96px; }
  .creature.gremlin-animated .idle-sprite { width: 96px; height: 96px; }
  .creature.ogre-animated .idle-sprite { width: 126px; height: 120px; }
  .idle-sprite, .pigeon-sprite, .goblin-sprite {
    display: block;
    image-rendering: pixelated;
  }
  .creature .label {
    display: block;
    margin-top: 0.15rem;
    text-align: center;
    color: var(--muted);
    font-size: 0.6rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .creature[data-state="idle"] { animation: sway var(--sway-dur, 4s) ease-in-out infinite; animation-delay: var(--sway-delay, 0s); }
  @keyframes sway {
    0%, 100% { transform: translate(0, 0); }
    25% { transform: translate(var(--sway-x, 2px), 0); }
    50% { transform: translate(0, var(--sway-y, -2px)); }
    75% { transform: translate(calc(var(--sway-x, 2px) * -1), 0); }
  }
  .creature[data-state="active"] { filter: drop-shadow(0 0 12px rgba(194,243,122,0.7)) brightness(1.2); }
  .creature[data-state="pass"] { filter: drop-shadow(0 0 14px rgba(182,243,122,0.85)) brightness(1.25) saturate(1.2); }
  .creature[data-state="fail"] { filter: drop-shadow(0 0 14px rgba(243,160,122,0.85)) hue-rotate(-30deg) brightness(0.95); }
  .creature[data-state="winner"] { filter: drop-shadow(0 0 18px rgba(243,223,122,0.95)) brightness(1.35) saturate(1.3); }
  .creature[data-state="cave"] { filter: brightness(0.45) blur(0.4px); opacity: 0.7; }
  .creature.ogre-animated[data-state="cave"] { opacity: 1; filter: brightness(0.55) saturate(0.85); }
  .pos-pigeon { top: 4%; left: 4%; }
  .pos-gremlin { top: 9%; right: 12%; }
  .pos-ogre { top: 35%; left: 7%; }
  .pos-goblins { position: absolute; top: 28%; left: 50%; transform: translateX(-50%); width: min(92%, 760px); z-index: 4; }
  .pos-raccoon { bottom: 8%; left: 12%; }
  .pos-troll { bottom: 11%; right: 11%; }
  .goblin-pile {
    position: relative;
    z-index: 2;
    display: flex;
    flex-wrap: wrap-reverse;
    gap: 0.45rem 0.7rem;
    align-items: flex-end;
    justify-content: center;
  }
  .goblin-wrap {
    width: 92px;
    min-height: 112px;
    display: flex;
    flex-direction: column;
    align-items: center;
    transition: opacity 0.25s ease, transform 0.25s ease;
  }
  .goblin-wrap[data-home="true"] { opacity: 0; transform: translateY(10px) scale(0.72); pointer-events: none; }
  .goblin-wrap[data-home="false"] { opacity: 1; transform: translateY(0) scale(1); }
  .goblin-wrap[data-specialist="true"] .goblin-sprite { filter: invert(1) hue-rotate(160deg) saturate(1.45) contrast(1.08); }
  .goblin-sprite { width: 96px; height: 96px; }
  .personality {
    margin-top: 0.15rem;
    font-size: 0.58rem;
    color: var(--muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .bubble-layer { position: absolute; inset: 0; pointer-events: none; z-index: 6; }
  .bubble, .think-bubble {
    position: absolute;
    max-width: 24ch;
    padding: 0.45rem 0.65rem;
    background: var(--bubble-bg);
    border: 1px solid var(--bubble-border);
    border-radius: 6px;
    color: var(--fg-bright);
    font-size: 0.74rem;
    line-height: 1.35;
    box-shadow: 0 4px 16px rgba(0,0,0,0.55);
    white-space: pre-wrap;
  }
  .bubble::after, .think-bubble::after {
    content: "";
    position: absolute;
    left: 1rem;
    bottom: -6px;
    width: 10px;
    height: 10px;
    background: var(--bubble-bg);
    border-right: 1px solid var(--bubble-border);
    border-bottom: 1px solid var(--bubble-border);
    transform: rotate(45deg);
  }
  .dag-panel, .result-panel {
    position: absolute;
    z-index: 7;
    right: 0.8rem;
    width: min(330px, calc(100% - 1.6rem));
    border: 1px solid rgba(124,255,91,0.16);
    border-radius: 8px;
    background: rgba(13,15,12,0.78);
    padding: 0.75rem;
    color: var(--muted);
    font-size: 0.72rem;
  }
  .dag-panel { top: 3.4rem; }
  .result-panel { bottom: 0.8rem; }
  .dag-panel h4, .result-panel h4 { margin: 0 0 0.45rem; color: var(--fg-bright); font-size: 0.78rem; }
  .dag-panel pre, .result-panel pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
  @media (max-width: 760px) {
    .tank-shell { grid-template-columns: 1fr; }
    .sidebar { min-height: 170px; border-right: 0; border-bottom: 1px solid var(--line); }
    .sidebar-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .tank { min-height: 560px; }
    .pos-goblins { top: 34%; }
    .dag-panel { display: none; }
  }
</style>
</head>
<body>
<main class="tank-shell" id="hosted-tank">
  <aside class="sidebar">
    <div class="sidebar-head">
      <span class="clock" id="surface-mode">hosted</span>
      <h1>AI Autopilot Tank</h1>
      <span class="clock">ChatGPT-hosted Tank</span>
    </div>
    <div class="sidebar-list">
      <button class="sidebar-item active" type="button"><strong>raccoon</strong><span id="side-raccoon">idle</span></button>
      <button class="sidebar-item" type="button"><strong>goblin pack</strong><span id="side-pack">home</span></button>
      <button class="sidebar-item" type="button"><strong>gremlin</strong><span id="side-gremlin">idle</span></button>
      <button class="sidebar-item" type="button"><strong>troll</strong><span id="side-troll">idle</span></button>
      <button class="sidebar-item" type="button"><strong>ogre</strong><span id="side-ogre">cave</span></button>
      <button class="sidebar-item" type="button"><strong>pigeon</strong><span id="side-pigeon">idle</span></button>
    </div>
    <div class="sidebar-foot">
      <button id="open-tank" type="button">Expand Tank</button>
      <button id="ask-rite" type="button">Run rite here</button>
    </div>
  </aside>

  <div class="tank warren" id="tank" data-visual-tier="4">
    <div id="hosted-board-flow" class="clock" style="position:absolute;left:0.8rem;top:0.8rem;z-index:8;">raccoon -> goblin pack -> gremlin -> troll -> ogre -> pigeon</div>
    <span class="hosted-badge">ChatGPT-hosted Tank</span>
    <img class="tank-logo-mark" src="${assetDomain.replace(/\/+$/u, "")}/gtowntextmark.png" alt="" aria-hidden="true" decoding="async">
    <span class="star" style="top: 5%; left: 18%;">*</span>
    <span class="star" style="top: 8%; left: 38%; animation-delay: -1s;">*</span>
    <span class="star" style="top: 4%; left: 62%; animation-delay: -2s;">.</span>
    <span class="star" style="top: 9%; left: 75%; animation-delay: -3s;">*</span>
    <span class="star" style="top: 6%; left: 88%;">.</span>
    <div class="mountains t4">🏔️ 🏔️ 🏔️ 🏔️ 🏔️</div>
    <div class="skyline back t3">🛖 🛖 🏚️ 🛖 🏚️ 🛖 🏚️ 🛖</div>
    <div class="skyline mid t4-flex" style="justify-content: center; gap: 0.9rem;">
      <span>🏚️</span><span>🛖</span><span>🏚️</span><span>🛖</span><span>🏠</span><span>🛖</span><span>🏚️</span>
    </div>
    <span class="smoke t2" style="top: 19%; left: 47%;">~</span>
    <span class="smoke t2" style="top: 19%; left: 41%; animation-delay: -1.4s;">~</span>
    <span class="smoke t2" style="top: 19%; left: 55%; animation-delay: -2.6s;">~</span>
    <pre class="banner t2">┌──── GOBLINTOWN ────┐
└── est. 2026 · MIT ─┘</pre>
    <div class="trees left t3">🌲🌲</div>
    <div class="trees right t3">🌲🌲</div>
    <span class="lantern" style="top: 36%; left: 26%;">🏮</span>
    <span class="lantern" style="top: 36%; right: 26%;">🏮</span>
    <span class="lantern" style="top: 56%; left: 18%; animation-delay: -1s;">🏮</span>
    <div class="ground"></div>
    <div class="ground-shadow"></div>
<pre class="pigeon-wire" id="pigeon-wire">═══════════════
        │
        │</pre>
<pre class="gremlin-perch">    │
    │
 ───┴───</pre>
    <div class="ogre-cave"></div>
    <div class="ogre-cave-label">ogre's cave</div>
    <div class="workshop"><div class="workshop-fire">🔥</div><div>workshop</div></div>
<pre class="troll-bridge">▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▌
▌                  ▐
~~~~~~~~~~~~~~~~~~~~</pre>
    <div class="raccoon-dump">🗑️ 📦</div>
    <div class="hoard" id="hoard">💰 ✨ 🧪</div>

    <div class="creature pos-pigeon" id="c-pigeon" data-state="idle" style="--sway-dur: 3.6s; --sway-x: 3px; --sway-delay: -0.8s;">
      <canvas class="sprite-shell pigeon-sprite" id="c-pigeon-sprite" width="128" height="128" aria-hidden="true"></canvas>
      <span class="emoji">🐦</span><span class="label">pigeon</span>
    </div>
    <div class="creature pos-gremlin" id="c-gremlin" data-state="idle" style="--sway-dur: 3.2s; --sway-x: 4px; --sway-delay: -2.1s;">
      <canvas class="sprite-shell idle-sprite" id="c-gremlin-sprite" width="130" height="130" aria-hidden="true"></canvas>
      <span class="emoji">😈</span><span class="label">gremlin</span>
    </div>
    <div class="creature pos-ogre" id="c-ogre" data-state="cave" style="--sway-dur: 6s; --sway-x: 1px; font-size: 3rem;">
      <canvas class="sprite-shell idle-sprite" id="c-ogre-sprite" width="128" height="128" aria-hidden="true"></canvas>
      <span class="emoji">👹</span><span class="label">ogre</span>
    </div>
    <div class="pos-goblins" id="c-goblins">
      <div class="goblin-pile" id="goblin-pile"></div>
      <span id="hosted-goblin-pack" hidden></span>
    </div>
    <div class="creature pos-raccoon" id="c-raccoon" data-state="idle" style="--sway-dur: 4.4s; --sway-x: 3px; --sway-delay: -1.3s;">
      <canvas class="sprite-shell idle-sprite" id="c-raccoon-sprite" width="128" height="128" aria-hidden="true"></canvas>
      <span class="emoji">🦝</span><span class="label">raccoon</span><span id="hosted-raccoon" hidden></span>
    </div>
    <div class="creature pos-troll" id="c-troll" data-state="idle" style="--sway-dur: 5.2s; --sway-x: 2px; --sway-delay: -3s; font-size: 2.8rem;">
      <canvas class="sprite-shell idle-sprite" id="c-troll-sprite" width="128" height="128" aria-hidden="true"></canvas>
      <span class="emoji">🧌</span><span class="label">troll</span>
    </div>
    <div class="bubble-layer" id="bubble-layer"></div>
    <div class="dag-panel" id="dag-panel"><h4>rite</h4><pre id="dag-text">Ask ChatGPT to run a rite. The Tank will light up the same positions as the local app.</pre></div>
    <div class="result-panel" id="result-panel"><h4>status</h4><pre id="status">Tank ready inside ChatGPT.</pre></div>
  </div>
</main>

<script>
const bridge = window.openai;
const widgetTemplateUri = ${widgetUri};
const assetBase = ${assetBase};
const $ = (id) => document.getElementById(id);
const tank = $("tank");
const bubbleLayer = $("bubble-layer");
const statusEl = $("status");
const dagText = $("dag-text");
const goblinPile = $("goblin-pile");
const side = {
  raccoon: $("side-raccoon"),
  pack: $("side-pack"),
  gremlin: $("side-gremlin"),
  troll: $("side-troll"),
  ogre: $("side-ogre"),
  pigeon: $("side-pigeon")
};
let tankState = {
  tankUrl: "https://goblintown-mcp.vercel.app",
  hosted: true,
  externalLaunchAvailable: false,
  openAction: "chatgpt_widget"
};

function asset(name) {
  return assetBase + "/" + name;
}

function payloadFrom(value) {
  if (!value || typeof value !== "object") return {};
  return value.structuredContent ||
    value.result?.structuredContent ||
    value.mcp_tool_result?.structuredContent ||
    value.call_tool_result?.structuredContent ||
    value;
}

function extractTankState(value) {
  const payload = payloadFrom(value);
  return {
    tankUrl: typeof payload.tankUrl === "string" ? payload.tankUrl : "",
    hosted: payload.hosted === true,
    externalLaunchAvailable: typeof payload.externalLaunchAvailable === "boolean" ? payload.externalLaunchAvailable : undefined,
    openAction: typeof payload.openAction === "string" ? payload.openAction : ""
  };
}

function mergeTankState(current, ...candidates) {
  const next = { ...current };
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.tankUrl) next.tankUrl = candidate.tankUrl;
    if (candidate.hosted) next.hosted = true;
    if (typeof candidate.externalLaunchAvailable === "boolean") next.externalLaunchAvailable = candidate.externalLaunchAvailable;
    if (candidate.openAction) next.openAction = candidate.openAction;
  }
  if (next.hosted || next.externalLaunchAvailable === false) {
    next.openAction = "chatgpt_widget";
    next.externalLaunchAvailable = false;
  }
  return next;
}

function tankIsChatGptHosted(state) {
  return state.hosted || state.externalLaunchAvailable === false || state.openAction === "chatgpt_widget";
}

function loadSheet(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load sprite sheet: " + src));
    img.src = src;
  });
}

function buildLinearFrameOrder(total) {
  return Array.from({ length: Math.max(0, total || 0) }, (_, i) => i);
}

function drawFrame(ctx, canvas, image, cols, rows, frame, mirror) {
  if (!ctx || !canvas || !image) return;
  const frameW = Math.floor(image.naturalWidth / cols);
  const frameH = Math.floor(image.naturalHeight / rows);
  if (!frameW || !frameH) return;
  const safeFrame = Math.max(0, Math.min(frame || 0, cols * rows - 1));
  const sx = (safeFrame % cols) * frameW;
  const sy = Math.floor(safeFrame / cols) * frameH;
  const dw = canvas.width;
  const dh = canvas.height;
  const scale = Math.min(dw / frameW, dh / frameH);
  const drawW = frameW * scale;
  const drawH = frameH * scale;
  const dx = (dw - drawW) / 2;
  const dy = dh - drawH;
  ctx.clearRect(0, 0, dw, dh);
  ctx.imageSmoothingEnabled = false;
  if (mirror) {
    ctx.save();
    ctx.translate(dw, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(image, sx, sy, frameW, frameH, dx, dy, drawW, drawH);
    ctx.restore();
  } else {
    ctx.drawImage(image, sx, sy, frameW, frameH, dx, dy, drawW, drawH);
  }
}

function bootLoopingSprite(config) {
  const creatureEl = $(config.creatureId);
  const canvas = $(config.canvasId);
  const ctx = canvas ? canvas.getContext("2d") : null;
  if (!creatureEl || !canvas || !ctx) return;
  loadSheet(config.src).then((image) => {
    const order = config.frameOrder || buildLinearFrameOrder(config.totalFrames);
    const state = { cursor: 0, acc: 0, last: 0 };
    creatureEl.classList.add("idle-sprite-animated", config.className);
    function tick(ts) {
      if (!state.last) state.last = ts;
      const delta = Math.max(0, ts - state.last);
      state.last = ts;
      state.acc += delta;
      const frameMs = 1000 / Math.max(1, config.fps || 6);
      while (state.acc >= frameMs) {
        state.acc -= frameMs;
        state.cursor = (state.cursor + 1) % Math.max(1, order.length);
      }
      drawFrame(ctx, canvas, image, config.cols, config.rows, order[state.cursor] || 0, false);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }).catch((err) => console.warn(config.creatureId + "-sprite-disabled", err));
}

function bootPigeonSprite() {
  const creatureEl = $("c-pigeon");
  const canvas = $("c-pigeon-sprite");
  const ctx = canvas ? canvas.getContext("2d") : null;
  if (!creatureEl || !canvas || !ctx) return;
  loadSheet(asset("pigeon-walk-right.png")).then((image) => {
    creatureEl.classList.add("pigeon-animated");
    const order = buildLinearFrameOrder(25);
    let cursor = 0;
    let acc = 0;
    let last = 0;
    function tick(ts) {
      if (!last) last = ts;
      const delta = Math.max(0, ts - last);
      last = ts;
      acc += delta;
      while (acc >= 110) {
        acc -= 110;
        cursor = (cursor + 1) % order.length;
      }
      drawFrame(ctx, canvas, image, 5, 5, order[cursor], false);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }).catch((err) => console.warn("pigeon-sprite-disabled", err));
}

const RACCOON_SPRITE_CONFIG = {
  src: asset("raccoon-sleep.png"),
  getUpSrc: asset("raccoon-get-up.png"),
  scurrySrc: asset("raccoon-scurry.png"),
  creatureId: "c-raccoon",
  canvasId: "c-raccoon-sprite",
  className: "raccoon-animated",
  cols: 16,
  rows: 1,
  totalFrames: 16,
  fps: 5,
  getUpFrames: 23,
  getUpFps: 12,
  scurryFrames: 10,
  scurryFps: 12
};
const raccoonState = { mode: "sleep", cursor: 0, acc: 0, last: 0, images: {}, order: buildLinearFrameOrder(16), fps: 5, facing: "right" };

function setRaccoonMode(mode) {
  raccoonState.mode = mode;
  raccoonState.cursor = 0;
  raccoonState.acc = 0;
  if (mode === "wake") {
    raccoonState.order = buildLinearFrameOrder(RACCOON_SPRITE_CONFIG.getUpFrames);
    raccoonState.fps = RACCOON_SPRITE_CONFIG.getUpFps;
  } else if (mode === "awake") {
    raccoonState.order = [RACCOON_SPRITE_CONFIG.getUpFrames - 1];
    raccoonState.fps = 1;
  } else if (mode === "scurry") {
    raccoonState.order = buildLinearFrameOrder(RACCOON_SPRITE_CONFIG.scurryFrames);
    raccoonState.fps = RACCOON_SPRITE_CONFIG.scurryFps;
  } else {
    raccoonState.order = buildLinearFrameOrder(RACCOON_SPRITE_CONFIG.totalFrames);
    raccoonState.fps = RACCOON_SPRITE_CONFIG.fps;
  }
}

function bootRaccoonSprite() {
  const creatureEl = $("c-raccoon");
  const canvas = $("c-raccoon-sprite");
  const ctx = canvas ? canvas.getContext("2d") : null;
  if (!creatureEl || !canvas || !ctx) return;
  Promise.all([
    loadSheet(RACCOON_SPRITE_CONFIG.src),
    loadSheet(RACCOON_SPRITE_CONFIG.getUpSrc).catch(() => null),
    loadSheet(RACCOON_SPRITE_CONFIG.scurrySrc).catch(() => null)
  ]).then(([sleep, getUp, scurry]) => {
    raccoonState.images = { sleep, getUp, scurry };
    creatureEl.classList.add(RACCOON_SPRITE_CONFIG.className);
    setRaccoonMode("sleep");
    function tick(ts) {
      if (!raccoonState.last) raccoonState.last = ts;
      const delta = Math.max(0, ts - raccoonState.last);
      raccoonState.last = ts;
      raccoonState.acc += delta;
      const frameMs = 1000 / Math.max(1, raccoonState.fps);
      while (raccoonState.acc >= frameMs) {
        raccoonState.acc -= frameMs;
        if (raccoonState.mode === "sleep") raccoonState.cursor = (raccoonState.cursor + 1) % raccoonState.order.length;
        else if (raccoonState.cursor < raccoonState.order.length - 1) raccoonState.cursor += 1;
        else if (raccoonState.mode === "wake") setRaccoonMode("awake");
        else if (raccoonState.mode === "scurry") setRaccoonMode("awake");
      }
      const image = raccoonState.mode === "scurry"
        ? (raccoonState.images.scurry || raccoonState.images.getUp || raccoonState.images.sleep)
        : (raccoonState.mode === "sleep" ? raccoonState.images.sleep : (raccoonState.images.getUp || raccoonState.images.sleep));
      const cols = raccoonState.mode === "scurry"
        ? (raccoonState.images.scurry ? RACCOON_SPRITE_CONFIG.scurryFrames : RACCOON_SPRITE_CONFIG.getUpFrames)
        : (raccoonState.mode === "sleep" ? RACCOON_SPRITE_CONFIG.cols : RACCOON_SPRITE_CONFIG.getUpFrames);
      drawFrame(ctx, canvas, image, cols, 1, raccoonState.order[raccoonState.cursor] || 0, raccoonState.facing === "left" && raccoonState.mode !== "sleep");
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }).catch((err) => console.warn("raccoon-sprite-disabled", err));
}

const GOBLIN_VARIANT_WEIGHTS = [
  { variant: "green", weight: 0.46 },
  { variant: "fire", weight: 0.27 },
  { variant: "spear", weight: 0.17 },
  { variant: "sceptre", weight: 0.10 }
];
const GOBLIN_ACTION_SHEETS = {
  green: {
    argue: { src: asset("goblin-green-argue.png"), frames: 12, fps: 9 },
    defend: { src: asset("goblin-green-defend.png"), frames: 12, fps: 10 },
    "go-home": { src: asset("goblin-green-go-home.png"), frames: 12, fps: 10 },
    "come-out": { src: asset("goblin-green-come-out.png"), frames: 12, fps: 10 }
  },
  fire: {
    argue: { src: asset("goblin-fire-argue.png"), frames: 12, fps: 9 },
    defend: { src: asset("goblin-fire-defend.png"), frames: 12, fps: 10 },
    "go-home": { src: asset("goblin-fire-go-home.png"), frames: 14, fps: 10 },
    "come-out": { src: asset("goblin-fire-come-out.png"), frames: 12, fps: 10 }
  },
  spear: {
    argue: { src: asset("goblin-spear-argue.png"), frames: 12, fps: 9 },
    defend: { src: asset("goblin-spear-defend.png"), frames: 12, fps: 10 },
    "go-home": { src: asset("goblin-spear-go-home.png"), frames: 12, fps: 10 },
    "come-out": { src: asset("goblin-spear-come-out.png"), frames: 13, fps: 10 }
  },
  sceptre: {
    argue: { src: asset("goblin-sceptre-argue.png"), frames: 12, fps: 9 },
    defend: { src: asset("goblin-sceptre-defend.png"), frames: 22, fps: 12 },
    "go-home": { src: asset("goblin-sceptre-go-home.png"), frames: 12, fps: 10 },
    "come-out": { src: asset("goblin-sceptre-come-out.png"), frames: 12, fps: 10 }
  }
};
const goblinByIndex = {};
const goblinImageCache = new Map();

function pickGoblinVariant() {
  const roll = Math.random();
  let cursor = 0;
  for (const entry of GOBLIN_VARIANT_WEIGHTS) {
    cursor += entry.weight;
    if (roll <= cursor) return entry.variant;
  }
  return "green";
}

function getGoblinSheet(variant, action) {
  const byVariant = GOBLIN_ACTION_SHEETS[variant] || GOBLIN_ACTION_SHEETS.green;
  return byVariant[action] || byVariant["come-out"];
}

function loadGoblinSheet(src) {
  if (!goblinImageCache.has(src)) goblinImageCache.set(src, loadSheet(src));
  return goblinImageCache.get(src);
}

function renderGoblinSlots(packSize, personalities) {
  goblinPile.innerHTML = "";
  Object.keys(goblinByIndex).forEach((key) => delete goblinByIndex[key]);
  const visible = Math.max(1, Math.floor(packSize || 1));
  for (let i = 0; i < visible; i++) {
    const variant = pickGoblinVariant();
    const wrap = document.createElement("div");
    wrap.className = "goblin-wrap";
    wrap.dataset.home = "true";
    wrap.dataset.specialist = "false";
    const div = document.createElement("div");
    div.className = "creature goblin goblin-sprite-animated";
    div.dataset.state = "home";
    div.dataset.variant = variant;
    const canvas = document.createElement("canvas");
    canvas.className = "goblin-sprite";
    canvas.width = 128;
    canvas.height = 128;
    canvas.setAttribute("aria-hidden", "true");
    div.appendChild(canvas);
    const emoji = document.createElement("span");
    emoji.className = "emoji";
    emoji.textContent = "👺";
    div.appendChild(emoji);
    const tag = document.createElement("span");
    tag.className = "personality";
    tag.textContent = personalities?.[i] || variant;
    wrap.appendChild(div);
    wrap.appendChild(tag);
    goblinPile.appendChild(wrap);
    goblinByIndex[i] = {
      el: div,
      wrap,
      canvas,
      ctx: canvas.getContext("2d"),
      tag,
      index: i,
      variant,
      frames: 1,
      fps: 10,
      frameOrder: [0],
      frameCursor: 0,
      frameAccumulatorMs: 0,
      lastTickMs: 0,
      rafId: 0,
      loop: false
    };
  }
}

function drawGoblinFrame(slot) {
  if (!slot || !slot.ctx || !slot.canvas || !slot.image) return;
  const frame = slot.frameOrder[slot.frameCursor % slot.frameOrder.length] || 0;
  drawFrame(slot.ctx, slot.canvas, slot.image, slot.frames, 1, frame, false);
}

function tickGoblinAction(slot, ts) {
  if (!slot || !slot.image) return;
  if (!slot.lastTickMs) slot.lastTickMs = ts;
  const delta = Math.max(0, ts - slot.lastTickMs);
  slot.lastTickMs = ts;
  const frameMs = 1000 / Math.max(1, slot.fps || 10);
  slot.frameAccumulatorMs += delta;
  while (slot.frameAccumulatorMs >= frameMs) {
    slot.frameAccumulatorMs -= frameMs;
    if (slot.frameCursor < slot.frameOrder.length - 1) slot.frameCursor += 1;
    else if (slot.loop) slot.frameCursor = 0;
  }
  drawGoblinFrame(slot);
  if (slot.loop || slot.frameCursor < slot.frameOrder.length - 1) {
    slot.rafId = requestAnimationFrame((nextTs) => tickGoblinAction(slot, nextTs));
  } else {
    slot.rafId = 0;
  }
}

async function playGoblinAction(slot, action, options) {
  if (!slot) return;
  options = options || {};
  if (slot.rafId) cancelAnimationFrame(slot.rafId);
  const sheet = getGoblinSheet(slot.variant, action);
  slot.wrap.dataset.home = "false";
  slot.el.dataset.action = action;
  slot.el.dataset.state = options.state || "active";
  try {
    const image = await loadGoblinSheet(sheet.src);
    slot.image = image;
    slot.frames = sheet.frames;
    slot.frameOrder = buildLinearFrameOrder(sheet.frames);
    slot.frameCursor = 0;
    slot.frameAccumulatorMs = 0;
    slot.lastTickMs = 0;
    slot.fps = sheet.fps;
    slot.loop = !!options.loop;
    drawGoblinFrame(slot);
    slot.rafId = requestAnimationFrame((ts) => tickGoblinAction(slot, ts));
  } catch {
    slot.el.classList.remove("goblin-sprite-animated");
  }
}

function wakeGoblins(action) {
  Object.values(goblinByIndex).forEach((slot, index) => {
    setTimeout(() => playGoblinAction(slot, action || "argue", { loop: true, state: "active" }), index * 130);
  });
}

function setState(id, state) {
  const el = $(id);
  if (!el) return;
  el.dataset.state = state;
  const key = id.replace(/^c-/, "");
  if (side[key]) side[key].textContent = state;
}

function shortText(value, max) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "", null, 2);
  return text.length > max ? text.slice(0, max) + "\\n..." : text;
}

function bubbleFor(id, text) {
  const target = $(id);
  if (!target || !bubbleLayer) return;
  const bubble = document.createElement("div");
  bubble.className = "think-bubble";
  bubble.textContent = shortText(text, 220);
  bubbleLayer.appendChild(bubble);
  const tankRect = tank.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const top = Math.max(8, rect.top - tankRect.top - 62);
  const left = Math.min(Math.max(8, rect.left - tankRect.left), Math.max(8, tankRect.width - 240));
  bubble.style.top = top + "px";
  bubble.style.left = left + "px";
  setTimeout(() => bubble.remove(), 9000);
}

function clearBubbles() {
  bubbleLayer.querySelectorAll(".bubble,.think-bubble").forEach((node) => node.remove());
}

function renderHostRun(payload) {
  const hostRun = payload.hostRun && typeof payload.hostRun === "object" ? payload.hostRun : {};
  const kind = hostRun.kind || payload.mode || "tank";
  const task = hostRun.task || payload.task || "";
  statusEl.textContent = task ? "task: " + task : "Tank ready inside ChatGPT.";
  if (kind === "rite") {
    const prompts = hostRun.prompts && typeof hostRun.prompts === "object" ? hostRun.prompts : {};
    const goblins = Array.isArray(prompts.goblins) ? prompts.goblins : [];
    const personalities = goblins.map((entry) => entry.personality || "goblin");
    renderGoblinSlots(goblins.length || payload.packSize || 3, personalities);
    side.raccoon.textContent = hostRun.scannedFiles?.length ? "scavenged" : "task";
    side.pack.textContent = String(goblins.length || payload.packSize || 3);
    side.gremlin.textContent = "chaos";
    side.troll.textContent = "review";
    side.ogre.textContent = "fallback";
    side.pigeon.textContent = "scribe";
    dagText.textContent = [
      "Raccoon: " + (hostRun.scannedFiles?.length ? hostRun.scannedFiles.join(", ") : "task context"),
      "Goblin pack: " + (goblins.length || payload.packSize || 3) + " candidates",
      "Gremlin: attacks candidates",
      "Troll: pass/fail gate",
      "Ogre: fallback if needed",
      "Pigeon: scribe note"
    ].join("\\n");
    setState("c-raccoon", "active");
    setState("c-gremlin", "active");
    setState("c-troll", "active");
    setState("c-ogre", "active");
    setState("c-pigeon", "active");
    setRaccoonMode("wake");
    setTimeout(() => setRaccoonMode("scurry"), 1500);
    wakeGoblins("argue");
    clearBubbles();
    bubbleFor("c-raccoon", hostRun.scannedFiles?.length ? "loaded prior artifacts" : "task context only");
    bubbleFor("c-gremlin", prompts.gremlinSystemPrompt || "attack edge cases");
    bubbleFor("c-troll", prompts.trollSystemPrompt || "judge candidates");
    bubbleFor("c-ogre", (hostRun.instructions || []).slice(-2).join("\\n") || "fallback if all fail");
    return;
  }
  if (kind === "plan") {
    renderGoblinSlots(3, ["planner", "node", "synth"]);
    wakeGoblins("defend");
    setState("c-raccoon", "active");
    setState("c-gremlin", "idle");
    setState("c-troll", "active");
    setState("c-ogre", "active");
    dagText.textContent = shortText(hostRun.plannerPrompt || task || "planner ready", 900);
    bubbleFor("c-ogre", "planner DAG");
    return;
  }
  if (!Object.keys(goblinByIndex).length) renderGoblinSlots(3, ["goblin", "goblin", "goblin"]);
}

function render() {
  const output = bridge?.toolOutput || {};
  const payload = payloadFrom(output);
  tankState = mergeTankState(tankState, extractTankState(bridge?.toolResponseMetadata), extractTankState(output));
  renderHostRun(payload);
}

window.addEventListener("openai:set_globals", render);

async function openTankUrl(target) {
  if (!target) return;
  if (bridge?.openExternal) {
    await bridge.openExternal({ href: target, redirectUrl: false });
    return;
  }
  window.open(target, "_blank", "noopener");
}

async function openTank(state) {
  if (tankIsChatGptHosted(state)) {
    if (bridge?.requestDisplayMode) {
      await bridge.requestDisplayMode({ mode: "fullscreen" });
      statusEl.textContent = "Tank expanded in ChatGPT.";
      return;
    }
    if (bridge?.requestModal) {
      await bridge.requestModal({ template: widgetTemplateUri });
      statusEl.textContent = "Tank opened in ChatGPT.";
      return;
    }
    statusEl.textContent = "Tank is already open in ChatGPT. Ask for a rite or plan to run it here.";
    return;
  }
  await openTankUrl(state.tankUrl);
}

$("open-tank").addEventListener("click", async () => {
  statusEl.textContent = "Opening Tank...";
  try {
    if (bridge?.callTool) {
      const result = await bridge.callTool("goblintown_tank", {});
      tankState = mergeTankState(tankState, extractTankState(result), extractTankState(bridge?.toolResponseMetadata), extractTankState(bridge?.toolOutput));
      render();
    }
    await openTank(tankState);
  } catch (err) {
    statusEl.textContent = "Open failed: " + (err?.message || err);
  }
});

$("ask-rite").addEventListener("click", async () => {
  if (typeof bridge?.callTool !== "function") {
    statusEl.textContent = "No tool channel available in this context.";
    return;
  }
  statusEl.textContent = "Running rite...";
  try {
    const result = await bridge.callTool("goblintown_rite", {
      task: "Run a Goblintown rite for the current task using the real board loop.",
      packSize: 5
    });
    renderHostRun(payloadFrom(result));
  } catch (err) {
    statusEl.textContent = "Rite failed: " + (err?.message || String(err));
  }
});

bootPigeonSprite();
bootRaccoonSprite();
bootLoopingSprite({
  src: asset("troll-idle.png"),
  creatureId: "c-troll",
  canvasId: "c-troll-sprite",
  className: "troll-animated",
  cols: 24,
  rows: 1,
  totalFrames: 24,
  fps: 6
});
bootLoopingSprite({
  src: asset("gremlin-idle.png"),
  creatureId: "c-gremlin",
  canvasId: "c-gremlin-sprite",
  className: "gremlin-animated",
  cols: 5,
  rows: 4,
  totalFrames: 20,
  frameOrder: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 17, 16, 15, 14, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  fps: 6
});
bootLoopingSprite({
  src: asset("ogre-idle.png"),
  creatureId: "c-ogre",
  canvasId: "c-ogre-sprite",
  className: "ogre-animated",
  cols: 8,
  rows: 4,
  totalFrames: 32,
  frameOrder: [0, 8, 16, 24, 1, 9, 17, 25, 2, 10, 18, 26, 3, 11, 19, 27, 4, 12, 20, 28, 5, 13, 21, 29, 6, 14, 22, 30, 7, 15, 23, 31],
  fps: 6
});
renderGoblinSlots(3, ["goblin", "goblin", "goblin"]);
render();
</script>
</body>
</html>`;
}

function buildChatGptTankWidgetHtml(assetDomain = "/assets"): string {
  const raccoonIdleSrc = `${assetDomain}/raccoon-sleep.png`;
  const gremlinSrc = `${assetDomain}/gremlin-idle.png`;
  const trollSrc = `${assetDomain}/troll-idle.png`;
  const ogreSrc = `${assetDomain}/ogre-idle.png`;
  const goblinSrc = `${assetDomain}/goblin-green-defend.png`;
  const logoMarkSrc = `${assetDomain}/gtowntextmark.png`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    color-scheme: dark;
    --ink: #f3ead2;
    --muted: #aaa28f;
    --panel: rgba(18, 20, 17, .92);
    --panel-2: rgba(9, 12, 12, .88);
    --line: rgba(243, 234, 210, .14);
    --acid: #b8f05f;
    --teal: #2dd4bf;
    --ember: #ff7a3d;
    --red: #ea4335;
    --shadow: rgba(0, 0, 0, .36);
    font-family: Avenir Next, ui-rounded, Trebuchet MS, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background:
      linear-gradient(120deg, rgba(45, 212, 191, .18), transparent 36%),
      linear-gradient(300deg, rgba(255, 122, 61, .2), transparent 34%),
      #0b0d0c;
    color: var(--ink);
  }
  button {
    border: 1px solid rgba(243, 234, 210, .18);
    background: #f2ead4;
    color: #11130f;
    padding: 10px 14px;
    min-height: 40px;
    border-radius: 6px;
    font: 700 13px/1 Avenir Next, ui-rounded, sans-serif;
    cursor: pointer;
  }
  button.secondary { background: #151816; color: var(--ink); }
  button:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .hosted-tank {
    min-height: 620px;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    border: 1px solid var(--line);
    background:
      radial-gradient(circle at 18% 12%, rgba(184, 240, 95, .14), transparent 32%),
      linear-gradient(180deg, rgba(255, 255, 255, .04), rgba(255, 255, 255, 0)),
      #151715;
    overflow: hidden;
  }
  .tank-top {
    min-height: 58px;
    padding: 12px 16px;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid var(--line);
    background: rgba(12, 13, 12, .82);
  }
  .brand {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 12px;
  }
  .brand-mark {
    width: 42px;
    height: 42px;
    object-fit: contain;
    image-rendering: pixelated;
  }
  h1 { margin: 0; font-size: 17px; line-height: 1.15; }
  .subline {
    margin-top: 3px;
    color: var(--muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mode-pill {
    border: 1px solid rgba(184, 240, 95, .36);
    border-radius: 999px;
    color: var(--acid);
    padding: 7px 10px;
    font-size: 11px;
    font-weight: 800;
    white-space: nowrap;
    text-transform: uppercase;
  }
  .app-shell {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(190px, 25%) minmax(0, 1fr);
  }
  .side-rail {
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    border-right: 1px solid var(--line);
    background: rgba(8, 9, 8, .42);
  }
  .status-panel { padding: 14px; border-bottom: 1px solid var(--line); }
  .status { margin: 0; color: var(--ink); font-size: 13px; line-height: 1.4; }
  .tank-output {
    margin: 10px 0 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
  }
  .tool-list {
    min-height: 0;
    overflow: auto;
    padding: 10px;
    display: grid;
    gap: 8px;
    align-content: start;
  }
  .tool-row {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 9px;
    align-items: center;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: rgba(255, 255, 255, .025);
  }
  .tool-row img {
    width: 34px;
    height: 34px;
    object-fit: cover;
    image-rendering: pixelated;
    border: 1px solid rgba(243, 234, 210, .18);
  }
  .tool-row b { display: block; font-size: 12px; }
  .tool-row span {
    display: block;
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .stage-wrap {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: minmax(320px, 1fr) auto;
    background:
      linear-gradient(rgba(243, 234, 210, .035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(243, 234, 210, .035) 1px, transparent 1px),
      #0b1214;
    background-size: 42px 42px;
  }
  .tank-stage {
    position: relative;
    min-height: 420px;
    overflow: hidden;
  }
  .tank-stage::before {
    content: "";
    position: absolute;
    inset: 0;
    background:
      radial-gradient(circle at 50% 48%, rgba(45, 212, 191, .14), transparent 30%),
      linear-gradient(90deg, rgba(4, 6, 8, .58), transparent 22%, transparent 75%, rgba(4, 6, 8, .48));
    pointer-events: none;
  }
  .tank-logo {
    position: absolute;
    left: 50%;
    top: 47%;
    width: min(44vw, 360px);
    max-height: 120px;
    object-fit: contain;
    opacity: .09;
    transform: translate(-50%, -50%);
    image-rendering: pixelated;
    pointer-events: none;
  }
  .board-flow {
    position: absolute;
    left: 16px;
    right: 16px;
    top: 14px;
    display: grid;
    grid-template-columns: repeat(5, minmax(92px, 1fr));
    gap: 8px;
    z-index: 3;
  }
  .board-flow span {
    min-height: 34px;
    display: grid;
    place-items: center;
    border: 1px solid rgba(243, 234, 210, .16);
    border-radius: 6px;
    background: rgba(8, 12, 14, .78);
    color: var(--muted);
    font-size: 11px;
    font-weight: 800;
    text-align: center;
    white-space: nowrap;
  }
  .board-flow span.active {
    color: #10140d;
    background: var(--acid);
    border-color: var(--acid);
    box-shadow: 0 10px 28px rgba(184, 240, 95, .2);
  }
  .position-grid {
    position: absolute;
    inset: 66px 16px 16px;
    display: grid;
    grid-template-columns: 1fr 1.35fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 10px;
    z-index: 2;
  }
  .lane {
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 8px;
    padding: 10px;
    border: 1px solid rgba(243, 234, 210, .12);
    border-radius: 6px;
    background: rgba(8, 11, 11, .68);
    box-shadow: 0 18px 34px var(--shadow);
  }
  .lane.main { grid-row: 1 / span 2; grid-column: 2; }
  .lane-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
    font-size: 11px;
    font-weight: 900;
    color: var(--ink);
    text-transform: uppercase;
  }
  .lane-title img {
    width: 26px;
    height: 26px;
    object-fit: cover;
    image-rendering: pixelated;
  }
  .lane-body {
    min-height: 0;
    overflow: auto;
    color: var(--muted);
    font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .main .lane-body {
    color: var(--ink);
    font-size: 12px;
  }
  .creature-token {
    position: absolute;
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border: 1px solid rgba(184, 240, 95, .6);
    border-radius: 6px;
    background: rgba(10, 14, 8, .6);
    box-shadow: 0 0 18px rgba(184, 240, 95, .14);
    z-index: 4;
  }
  .creature-token img {
    width: 42px;
    height: 42px;
    object-fit: cover;
    image-rendering: pixelated;
  }
  .raccoon { left: 4%; bottom: 18%; animation: hosted-scurry 5.5s ease-in-out infinite; }
  .gremlin { right: 28%; top: 28%; }
  .troll { right: 4%; top: 46%; }
  .ogre { left: 31%; bottom: 12%; }
  .goblin-pack {
    position: absolute;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    display: grid;
    grid-template-columns: repeat(5, 28px);
    gap: 7px;
    align-items: end;
    z-index: 4;
  }
  .goblin-pack img {
    display: block;
    width: 28px;
    height: 28px;
    object-fit: cover;
    image-rendering: pixelated;
    border: 1px solid rgba(184, 240, 95, .64);
    border-radius: 4px;
    animation: hosted-argue 1.6s ease-in-out infinite;
  }
  .goblin-pack img:nth-child(2) { animation-delay: .12s; }
  .goblin-pack img:nth-child(3) { animation-delay: .28s; }
  .goblin-pack img:nth-child(4) { animation-delay: .43s; }
  .goblin-pack img:nth-child(5) { animation-delay: .57s; }
  .action-bar {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 10px;
    padding: 14px;
    border-top: 1px solid var(--line);
    background: rgba(10, 10, 9, .72);
  }
  .tank-frame-wrap {
    grid-column: 1 / -1;
    border-top: 1px solid var(--line);
    min-height: 320px;
    background: #080c06;
  }
  .tank-frame {
    display: block;
    width: 100%;
    min-height: 320px;
    border: 0;
  }
  @keyframes hosted-scurry {
    0%, 100% { transform: translateX(0); }
    38% { transform: translateX(22px); }
    62% { transform: translateX(-9px); }
  }
  @keyframes hosted-argue {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-7px); }
  }
  @media (max-width: 760px) {
    .hosted-tank { min-height: 720px; }
    .tank-top { grid-template-columns: 1fr; }
    .app-shell { grid-template-columns: 1fr; }
    .side-rail { border-right: 0; border-bottom: 1px solid var(--line); }
    .tool-list { grid-template-columns: repeat(2, minmax(0, 1fr)); max-height: 168px; }
    .tank-stage { min-height: 520px; }
    .board-flow { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .position-grid { inset-top: 124px; grid-template-columns: 1fr; grid-template-rows: repeat(5, minmax(110px, auto)); }
    .lane.main { grid-row: auto; grid-column: auto; }
    .creature-token, .goblin-pack { display: none; }
  }
</style>
</head>
<body>
<main class="hosted-tank" id="hosted-tank">
  <div class="tank-top">
    <div class="brand">
      <img class="brand-mark" src="${logoMarkSrc}" alt="">
      <div>
        <h1>Goblintown Tank</h1>
        <div class="subline" id="task-line">Route ChatGPT through the board positions.</div>
      </div>
    </div>
    <span class="mode-pill">ChatGPT-hosted Tank</span>
  </div>
  <section class="app-shell" aria-label="Goblintown ChatGPT app surface">
    <aside class="side-rail">
      <div class="status-panel">
        <p class="status" id="status">Ready for a ChatGPT handoff.</p>
        <p class="tank-output" id="details">Ask for a rite or plan; the result will be routed into the positions here.</p>
      </div>
      <div class="tool-list" aria-label="Board positions">
        <div class="tool-row"><img src="${raccoonIdleSrc}" alt=""><div><b>Context</b><span id="side-context">Waiting</span></div></div>
        <div class="tool-row"><img src="${goblinSrc}" alt=""><div><b>Candidates</b><span id="side-pack">Waiting</span></div></div>
        <div class="tool-row"><img src="${gremlinSrc}" alt=""><div><b>Pressure</b><span id="side-pressure">Waiting</span></div></div>
        <div class="tool-row"><img src="${trollSrc}" alt=""><div><b>Gate</b><span id="side-gate">Waiting</span></div></div>
        <div class="tool-row"><img src="${ogreSrc}" alt=""><div><b>Fallback</b><span id="side-fallback">Waiting</span></div></div>
      </div>
    </aside>
    <div class="stage-wrap">
      <section class="tank-stage" aria-label="Board loop">
        <img class="tank-logo" src="${logoMarkSrc}" alt="">
        <div class="board-flow" id="hosted-board-flow">
          <span data-phase="context">Context</span>
          <span data-phase="pack">Pack</span>
          <span data-phase="pressure">Pressure</span>
          <span data-phase="gate">Gate</span>
          <span data-phase="fallback">Fallback</span>
        </div>
        <div class="position-grid">
          <article class="lane" id="lane-context"><div class="lane-title"><span>Context Intake</span><img src="${raccoonIdleSrc}" alt=""></div><div class="lane-body">No context packet yet.</div></article>
          <article class="lane main" id="lane-pack"><div class="lane-title"><span>Candidate Pack</span><img src="${goblinSrc}" alt=""></div><div class="lane-body">Run a rite to generate independent candidate prompts.</div></article>
          <article class="lane" id="lane-pressure"><div class="lane-title"><span>Pressure Test</span><img src="${gremlinSrc}" alt=""></div><div class="lane-body">Waiting for failure-mode checks.</div></article>
          <article class="lane" id="lane-gate"><div class="lane-title"><span>Review Gate</span><img src="${trollSrc}" alt=""></div><div class="lane-body">Waiting for pass/fail review.</div></article>
          <article class="lane" id="lane-fallback"><div class="lane-title"><span>Recovery</span><img src="${ogreSrc}" alt=""></div><div class="lane-body">Recovery path appears only when needed.</div></article>
        </div>
      <div class="creature-token raccoon" id="hosted-raccoon" title="context">
        <img src="${raccoonIdleSrc}" alt="raccoon">
      </div>
      <div class="goblin-pack" id="hosted-goblin-pack" aria-label="candidate pack">
        <img src="${goblinSrc}" alt="goblin">
        <img src="${goblinSrc}" alt="goblin">
        <img src="${goblinSrc}" alt="goblin">
        <img src="${goblinSrc}" alt="goblin">
        <img src="${goblinSrc}" alt="goblin">
      </div>
      <div class="creature-token gremlin" title="chaos">
        <img src="${gremlinSrc}" alt="gremlin">
      </div>
      <div class="creature-token troll" title="review">
        <img src="${trollSrc}" alt="troll">
      </div>
      <div class="creature-token ogre" title="planner">
        <img src="${ogreSrc}" alt="ogre">
      </div>
      </section>
      <div class="action-bar">
        <button id="open-tank">Expand Tank</button>
        <button class="secondary" id="ask-rite">Run rite here</button>
      </div>
    </div>
  </section>
  <section class="tank-frame-wrap" id="tank-frame-wrap" hidden>
    <iframe class="tank-frame" id="tank-frame" title="Goblintown Tank" loading="lazy" referrerpolicy="no-referrer"></iframe>
  </section>
</main>
<script>
const bridge = window.openai;
const widgetTemplateUri = ${JSON.stringify(GOBLINTOWN_CHATGPT_WIDGET_URI)};
const statusEl = document.getElementById("status");
const detailsEl = document.getElementById("details");
const taskLineEl = document.getElementById("task-line");
const openTankButton = document.getElementById("open-tank");
const tankFrame = document.getElementById("tank-frame");
const tankFrameWrap = document.getElementById("tank-frame-wrap");
const laneMap = {
  context: document.querySelector("#lane-context .lane-body"),
  pack: document.querySelector("#lane-pack .lane-body"),
  pressure: document.querySelector("#lane-pressure .lane-body"),
  gate: document.querySelector("#lane-gate .lane-body"),
  fallback: document.querySelector("#lane-fallback .lane-body")
};
const sideMap = {
  context: document.getElementById("side-context"),
  pack: document.getElementById("side-pack"),
  pressure: document.getElementById("side-pressure"),
  gate: document.getElementById("side-gate"),
  fallback: document.getElementById("side-fallback")
};
let tankState = {
  tankUrl: "http://localhost:7777/",
  hosted: false,
  externalLaunchAvailable: true,
  openAction: "external_url"
};
  tankState = mergeTankState(tankState, extractTankState(bridge?.toolResponseMetadata), extractTankState(bridge?.toolOutput));

function payloadFrom(value) {
  if (!value || typeof value !== "object") return {};
  return value.structuredContent ||
    value.result?.structuredContent ||
    value.mcp_tool_result?.structuredContent ||
    value.call_tool_result?.structuredContent ||
    value;
}

function stringifyCompact(value, max = 900) {
  if (value === undefined || value === null || value === "") return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > max ? text.slice(0, max) + "\\n..." : text;
}

function firstLines(value, count = 8) {
  return stringifyCompact(value, 1800)
    .split(/\\r?\\n/u)
    .filter((line) => line.trim())
    .slice(0, count)
    .join("\\n");
}

function setLane(name, text, sideText) {
  if (laneMap[name]) laneMap[name].textContent = text || "Waiting.";
  if (sideMap[name]) sideMap[name].textContent = sideText || (text ? "Ready" : "Waiting");
}

function setActivePhases(phases) {
  const active = new Set(phases);
  document.querySelectorAll("#hosted-board-flow [data-phase]").forEach((node) => {
    node.classList.toggle("active", active.has(node.getAttribute("data-phase")));
  });
}

function renderPacket(payload) {
  const hostRun = payload.hostRun && typeof payload.hostRun === "object" ? payload.hostRun : {};
  const kind = typeof hostRun.kind === "string" ? hostRun.kind : payload.mode || "tank";
  const task = typeof hostRun.task === "string" ? hostRun.task : payload.task;
  if (taskLineEl && task) taskLineEl.textContent = task;

  if (kind === "rite") {
    const prompts = hostRun.prompts && typeof hostRun.prompts === "object" ? hostRun.prompts : {};
    const goblins = Array.isArray(prompts.goblins) ? prompts.goblins : [];
    setActivePhases(["context", "pack", "pressure", "gate", "fallback"]);
    setLane("context", hostRun.scannedFiles?.length
      ? "Scanned files:\\n" + hostRun.scannedFiles.join("\\n")
      : "Task context only. ChatGPT should separate facts from guesses.", hostRun.scannedFiles?.length ? "Files loaded" : "Task only");
    setLane("pack", goblins.length
      ? goblins.map((entry, index) => "#" + (index + 1) + " " + (entry.personality || "candidate") + "\\n" + firstLines(entry.userPrompt, 5)).join("\\n\\n")
      : firstLines(hostRun.prompt, 12), goblins.length ? goblins.length + " candidates" : "Prompt ready");
    setLane("pressure", firstLines(prompts.gremlinSystemPrompt || "Stress each candidate for edge cases, hidden assumptions, and failure modes.", 9), "Loaded");
    setLane("gate", firstLines(prompts.trollSystemPrompt || "Review each candidate and return pass/fail with score.", 9), "Loaded");
    setLane("fallback", firstLines((hostRun.instructions || []).join("\\n"), 10), hostRun.openAiApiKeyRequired === false ? "No API key" : "Recovery");
    return;
  }

  if (kind === "plan") {
    setActivePhases(["context", "pack", "gate"]);
    setLane("context", firstLines(hostRun.plannerPrompt || task || "Planning context ready.", 12), "Planner");
    setLane("pack", firstLines((hostRun.instructions || []).join("\\n"), 12), "DAG");
    setLane("pressure", "Each planned node becomes a hosted rite with the same review gates.", "Queued");
    setLane("gate", "Completed node artifacts feed dependent nodes before final synthesis.", "Synthesis");
    setLane("fallback", "Replan budget: " + (hostRun.maxReplan ?? "default"), "Recovery");
    return;
  }

  setActivePhases(["context"]);
  setLane("context", "Hosted app surface is ready.", "Ready");
  setLane("pack", "Call goblintown_rite or goblintown_plan to fill this board.", "Waiting");
  setLane("pressure", "", "Waiting");
  setLane("gate", "", "Waiting");
  setLane("fallback", "", "Waiting");
}

function extractTankState(value) {
  const payload = payloadFrom(value);
  return {
    tankUrl: typeof payload.tankUrl === "string" ? payload.tankUrl : "",
    hosted: payload.hosted === true,
    externalLaunchAvailable: typeof payload.externalLaunchAvailable === "boolean"
      ? payload.externalLaunchAvailable
      : undefined,
    openAction: typeof payload.openAction === "string" ? payload.openAction : ""
  };
}

function mergeTankState(current, ...candidates) {
  const next = { ...current };
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.tankUrl) next.tankUrl = candidate.tankUrl;
    if (candidate.hosted) next.hosted = true;
    if (typeof candidate.externalLaunchAvailable === "boolean") {
      next.externalLaunchAvailable = candidate.externalLaunchAvailable;
    }
    if (candidate.openAction) next.openAction = candidate.openAction;
  }
  if (next.hosted || next.externalLaunchAvailable === false) {
    next.openAction = "chatgpt_widget";
    next.externalLaunchAvailable = false;
  }
  return next;
}

function tankIsChatGptHosted(state) {
  return state.hosted || state.externalLaunchAvailable === false || state.openAction === "chatgpt_widget";
}

function render() {
  const output = bridge?.toolOutput || {};
  const payload = payloadFrom(output);
  tankState = mergeTankState(tankState, extractTankState(bridge?.toolResponseMetadata), extractTankState(output));
  renderPacket(payload);
  if (tankIsChatGptHosted(tankState)) {
    statusEl.textContent = payload.runMode === "chatgpt" ? "Board packet routed into the ChatGPT surface." : "Tank ready inside ChatGPT.";
    openTankButton.textContent = "Expand Tank";
    if (tankFrameWrap) tankFrameWrap.hidden = true;
    if (tankFrame) tankFrame.removeAttribute("src");
  } else {
    statusEl.textContent = tankState.tankUrl ? "Tank ready: " + tankState.tankUrl : "Ready for a ChatGPT handoff.";
    openTankButton.textContent = "Open Tank";
    if (tankFrameWrap) {
      tankFrameWrap.hidden = true;
    }
    if (tankFrame) {
      tankFrame.removeAttribute("src");
    }
  }
  detailsEl.textContent = payload.runId || payload.lootId
    ? "Run id: " + (payload.runId || payload.lootId)
    : "ChatGPT is the host model surface. Goblintown provides the board packet; no OpenAI API key is required.";
}

window.addEventListener("openai:set_globals", render);
render();

async function openTankUrl(target) {
  if (!target) return;
  if (bridge?.openExternal) {
    await bridge.openExternal({ href: target, redirectUrl: false });
    return;
  }
  window.open(target, "_blank", "noopener");
}

async function openTank(state) {
  if (tankIsChatGptHosted(state)) {
    if (bridge?.requestDisplayMode) {
      await bridge.requestDisplayMode({ mode: "fullscreen" });
      statusEl.textContent = "Tank expanded in ChatGPT.";
      return;
    }
    if (bridge?.requestModal) {
      await bridge.requestModal({ template: widgetTemplateUri });
      statusEl.textContent = "Tank opened in ChatGPT.";
      return;
    }
    statusEl.textContent = "Tank is already open in ChatGPT. Ask for a rite or plan to run it here.";
    return;
  }
  await openTankUrl(state.tankUrl);
}

document.getElementById("open-tank").addEventListener("click", async () => {
  statusEl.textContent = "Opening Tank...";
  try {
    if (bridge?.callTool) {
      const result = await bridge.callTool("goblintown_tank", {});
      tankState = mergeTankState(tankState, extractTankState(result), extractTankState(bridge?.toolResponseMetadata), extractTankState(bridge?.toolOutput));
      render();
    }
    await openTank(tankState);
  } catch (err) {
    statusEl.textContent = "Open failed: " + (err?.message || err);
  }
});

document.getElementById("ask-rite").addEventListener("click", async () => {
  if (typeof bridge?.callTool !== "function") {
    statusEl.textContent = "No tool channel available in this context. I can only run a rite from ChatGPT widget/tool surface.";
    return;
  }

  statusEl.textContent = "Running rite...";
  try {
    const result = await bridge.callTool("goblintown_rite", {
      task: "Run a Goblintown rite for the current task using the real board loop.",
    });
    tankState = mergeTankState(
      tankState,
      extractTankState(result),
      extractTankState(bridge?.toolResponseMetadata),
      extractTankState(bridge?.toolOutput),
    );
    render();
  } catch (err) {
    statusEl.textContent = "Rite failed: " + (err?.message || String(err));
  }
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
  if (raw === "harness" || raw === "host" || raw === "host_harness") return "board";
  return raw && (MCP_EXECUTION_MODES as readonly string[]).includes(raw)
    ? (raw as McpExecutionMode)
    : "board";
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
