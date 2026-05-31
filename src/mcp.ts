import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  normalizeChatMessages,
  runSingleGoblinChat,
  type ChatMessage,
} from "./chat.js";
import { buildToolRegistry } from "./addons.js";
import { normalizeOutputFormat } from "./formatting.js";
import { planTask } from "./planner.js";
import { executePlan } from "./plan-executor.js";
import { resolveProviderRuntime, resolveProviderRuntimeForSlot } from "./providers.js";
import { loadRewardPlugin } from "./reward-plugin.js";
import { performRite, type RiteStep } from "./rite.js";
import { loadWarren, type Warren } from "./warren.js";
import type { Artifact, ModelSlot, OutputFormat, Personality } from "./types.js";

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

type JsonObject = Record<string, unknown>;

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

export interface NormalizedMcpChatArgs {
  messages: ChatMessage[];
  personality?: Personality;
  modelSlot?: ModelSlot;
  maxOutputTokens?: number;
}

export const GOBLINTOWN_MCP_TOOLS: Tool[] = [
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
      "Run a full Goblintown rite: context scan, goblin pack, review, fallback/recovery, and scribe artifact creation.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task for the full Goblintown rite." },
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
      "Build and execute a planner DAG for complex work. Each node runs a sub-rite and feeds artifacts forward.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Complex task for the planner DAG." },
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
    const warren = await loadWarren(cwd);
    const runtime = resolveProviderRuntime(warren.manifest.provider);
    payload.projectReady = true;
    payload.warrenRoot = warren.root;
    payload.warren = {
      ok: true,
      root: warren.root,
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
      nextStep: "Run `goblintown init` in a project folder before using rite/chat tools there.",
    };
    payload.warnings = [
      "Goblintown MCP is installable from this package, but this directory is not a Warren yet.",
    ];
  }
  return payload;
}

export async function runGoblintownMcpServer(
  opts: { cwd?: string } = {},
): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const server = new Server(
    { name: "goblintown", version: process.env.npm_package_version ?? "0.7.0-beta.5" },
    {
      capabilities: { tools: {} },
      instructions:
        "Goblintown runs local Single Goblin calls, full rites, and planner DAGs from the current Warren. Use goblintown_doctor first when setup is uncertain.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: GOBLINTOWN_MCP_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    try {
      switch (request.params.name) {
        case "goblintown_chat":
          return await callMcpChat(cwd, args);
        case "goblintown_rite":
          return await callMcpRite(cwd, args);
        case "goblintown_plan":
          return await callMcpPlan(cwd, args);
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
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

async function callMcpChat(cwd: string, input: unknown): Promise<CallToolResult> {
  const args = normalizeMcpChatArgs(input);
  const warren = await loadWarren(cwd);
  const result = await runSingleGoblinChat({
    messages: args.messages,
    hoard: warren.hoard,
    personality: args.personality,
    modelSlot: args.modelSlot,
    maxOutputTokens: args.maxOutputTokens,
  });
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

async function callMcpRite(cwd: string, input: unknown): Promise<CallToolResult> {
  const raw = objectValue(input);
  const task = requiredString(raw.task, "goblintown_rite requires task");
  const warren = await loadWarren(cwd);
  const parentArtifacts = await loadMcpParentArtifacts(warren, {
    task,
    citeRiteIds: arrayOfStrings(raw.citeRiteIds),
    remember: booleanValue(raw.remember),
  });
  const rewardPlugin = await loadRewardPlugin(warren.root);
  const steps: string[] = [];
  const trollTools = booleanValue(raw.trollTools);
  const result = await performRite({
    task,
    packSize: numberValue(raw.packSize, 1, 8) ?? 3,
    scanGlobs: arrayOfStrings(raw.scanGlobs),
    cwd: warren.root,
    hoard: warren.hoard,
    personality: normalizePersonality(raw.personality),
    rewardFn: rewardPlugin.fn,
    noFallback: booleanValue(raw.noFallback),
    noSpecialist: booleanValue(raw.noSpecialist),
    specialistCap: numberValue(raw.specialistCap, 0, 8),
    debate: booleanValue(raw.debate),
    trollTools,
    tools: trollTools ? buildToolRegistry(warren.manifest) : undefined,
    budgetTokens: numberValue(raw.budgetTokens, 1),
    maxOutputTokensPerCall: numberValue(raw.maxOutputTokens, 64, 12000),
    outputFormat: normalizeMcpOutputFormat(raw.outputFormat, warren),
    parentArtifacts,
    onStep: (step) => {
      if (steps.length < 80) steps.push(formatMcpRiteStep(step));
    },
  });
  const artifact = await warren.hoard.getArtifactByRiteId(result.rite.id);
  return textResult({
    mode: "rite",
    riteId: result.rite.id,
    outcome: result.rite.outcome,
    winnerLootId: result.rite.winnerLootId,
    artifactId: artifact?.id,
    loadedArtifactIds: parentArtifacts.map((artifact) => artifact.id),
    steps,
  }, [
    `Rite ${result.rite.id} finished: ${result.rite.outcome}`,
    artifact ? `Artifact: ${artifact.id}` : "Artifact: none",
    `Winner loot: ${result.rite.winnerLootId}`,
    "",
    result.winnerLoot.output,
  ].join("\n"));
}

async function callMcpPlan(cwd: string, input: unknown): Promise<CallToolResult> {
  const raw = objectValue(input);
  const task = requiredString(raw.task, "goblintown_plan requires task");
  const warren = await loadWarren(cwd);
  const parentArtifacts = await loadMcpParentArtifacts(warren, {
    task,
    citeRiteIds: arrayOfStrings(raw.citeRiteIds),
    remember: booleanValue(raw.remember),
  });
  const outputFormat = normalizeMcpOutputFormat(raw.outputFormat, warren);
  const maxOutputTokensPerCall = numberValue(raw.maxOutputTokens, 64, 12000);
  const { plan } = await planTask({
    task,
    parentArtifacts,
    maxNodes: numberValue(raw.maxNodes, 1, 12) ?? 6,
    maxOutputTokens: maxOutputTokensPerCall,
  });
  const rewardPlugin = await loadRewardPlugin(warren.root);
  const events: string[] = [];
  const result = await executePlan({
    plan,
    cwd: warren.root,
    hoard: warren.hoard,
    rewardFn: rewardPlugin.fn,
    budgetTokens: numberValue(raw.budgetTokens, 1),
    maxOutputTokensPerCall,
    outputFormat,
    parentArtifacts,
    maxReplanDepth: numberValue(raw.maxReplan, 0, 6) ?? 2,
    onPlanEvent: (event) => {
      if (events.length < 80) events.push(JSON.stringify(event));
    },
    onStep: (nodeId, step) => {
      if (events.length < 120) events.push(`[${nodeId}] ${formatMcpRiteStep(step)}`);
    },
  });
  return textResult({
    mode: "plan",
    planId: result.plan.id,
    outcome: result.outcome,
    finalRiteId: result.finalRiteId,
    finalArtifactId: result.finalArtifact?.id,
    finalLootId: result.finalLootId,
    nodes: result.plan.nodes.map((node) => ({
      id: node.id,
      status: node.status,
      riteId: node.riteId,
      artifactId: node.artifactId,
      task: node.task,
    })),
    events,
  }, [
    `Plan ${result.plan.id} finished: ${result.outcome}`,
    result.finalArtifact ? `Final artifact: ${result.finalArtifact.id}` : "Final artifact: none",
    result.finalRiteId ? `Final rite: ${result.finalRiteId}` : "",
  ].filter(Boolean).join("\n"));
}

async function callMcpProvider(cwd: string, input: unknown): Promise<CallToolResult> {
  const raw = objectValue(input);
  const slot = normalizeModelSlot(raw.slot);
  const warren = await loadWarren(cwd);
  const runtime = slot
    ? resolveProviderRuntimeForSlot(slot, warren.manifest.provider)
    : resolveProviderRuntime(warren.manifest.provider);
  return textResult({
    warrenRoot: warren.root,
    slot,
    provider: safeProviderRuntime(runtime),
    routes: warren.manifest.provider?.routes ?? {},
  });
}

async function loadMcpParentArtifacts(
  warren: Warren,
  opts: { task: string; citeRiteIds: string[]; remember: boolean },
): Promise<Artifact[]> {
  const parentArtifacts: Artifact[] = [];
  for (const riteId of opts.citeRiteIds) {
    const artifact = await warren.hoard.getArtifactByRiteId(riteId);
    if (artifact) parentArtifacts.push(artifact);
  }
  if (opts.remember) {
    const all = await warren.hoard.allArtifacts();
    const { findRelevantArtifactsEmbedded } = await import("./embeddings.js");
    const auto = (await findRelevantArtifactsEmbedded({
      artifacts: all,
      queryText: opts.task,
      limit: 3,
      hoard: warren.hoard,
    })).filter((artifact) => !parentArtifacts.some((prior) => prior.id === artifact.id));
    parentArtifacts.push(...auto);
  }
  return parentArtifacts;
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

function normalizeMcpOutputFormat(value: unknown, warren: Warren): OutputFormat {
  return normalizeOutputFormat(value ?? warren.manifest.provider?.outputFormat);
}

function formatMcpRiteStep(step: RiteStep): string {
  const detail =
    "detail" in step && typeof step.detail === "string"
      ? step.detail
      : "message" in step && typeof step.message === "string"
        ? step.message
        : "lootId" in step && typeof step.lootId === "string"
          ? step.lootId
          : "";
  return detail ? `${step.kind}: ${detail}` : step.kind;
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
