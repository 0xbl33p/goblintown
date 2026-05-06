import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ModelSlot,
  OutputFormat,
  ProviderConfig,
  ProviderPresetId,
  WarrenManifest,
} from "./types.js";
import { normalizeOutputFormat } from "./formatting.js";

export const MODEL_SLOTS: ModelSlot[] = [
  "goblin",
  "gremlin",
  "raccoon",
  "troll",
  "ogre",
  "pigeon",
  "scribe",
  "embedding",
];

type Env = Record<string, string | undefined>;

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  baseURL?: string;
  apiKeyEnv: string;
  apiKeyEnvAliases?: string[];
  local?: boolean;
  dummyApiKey?: string;
  models: Record<ModelSlot, string>;
  note?: string;
}

export interface ProviderRuntime {
  id: ProviderPresetId;
  label: string;
  baseURL?: string;
  apiKeyEnv: string;
  apiKey: string;
  outputFormat: OutputFormat;
  models: Record<ModelSlot, string>;
  missingApiKey?: string;
  defaultHeaders?: Record<string, string>;
}

const OPENAI_MODELS: Record<ModelSlot, string> = {
  goblin: "gpt-5.4-mini",
  gremlin: "gpt-5.4-mini",
  raccoon: "gpt-5.4-mini",
  troll: "gpt-5.4-mini",
  ogre: "gpt-5.5",
  pigeon: "gpt-5.4-mini",
  scribe: "gpt-5.4-mini",
  embedding: "text-embedding-3-small",
};

function withChatModel(
  chatModel: string,
  embeddingModel: string = OPENAI_MODELS.embedding,
): Record<ModelSlot, string> {
  return {
    goblin: chatModel,
    gremlin: chatModel,
    raccoon: chatModel,
    troll: chatModel,
    ogre: chatModel,
    pigeon: chatModel,
    scribe: chatModel,
    embedding: embeddingModel,
  };
}

export const PROVIDER_PRESETS: Record<ProviderPresetId, ProviderPreset> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    apiKeyEnv: "OPENAI_API_KEY",
    models: OPENAI_MODELS,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: OPENAI_MODELS,
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    baseURL: "http://localhost:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    local: true,
    dummyApiKey: "ollama",
    models: withChatModel("llama3.2", "nomic-embed-text"),
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio",
    baseURL: "http://localhost:1234/v1",
    apiKeyEnv: "LM_API_TOKEN",
    apiKeyEnvAliases: ["LMSTUDIO_API_KEY"],
    local: true,
    dummyApiKey: "",
    models: withChatModel("local-model", "local-embedding-model"),
  },
  groq: {
    id: "groq",
    label: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    models: withChatModel("llama-3.3-70b-versatile"),
  },
  together: {
    id: "together",
    label: "Together AI",
    baseURL: "https://api.together.ai/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    models: withChatModel("meta-llama/Llama-3.3-70B-Instruct-Turbo"),
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    baseURL: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    models: {
      goblin: "mistral-small-latest",
      gremlin: "mistral-small-latest",
      raccoon: "mistral-small-latest",
      troll: "mistral-small-latest",
      ogre: "mistral-large-latest",
      pigeon: "mistral-small-latest",
      scribe: "mistral-small-latest",
      embedding: "mistral-embed",
    },
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: {
      ...withChatModel("deepseek-v4-flash"),
      ogre: "deepseek-v4-pro",
    },
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    baseURL: "https://api.anthropic.com/v1/",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: withChatModel("claude-opus-4-1-20250805"),
    note: "Uses Anthropic's OpenAI SDK compatibility layer.",
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    models: withChatModel("gemini-3-flash-preview", "gemini-embedding-001"),
  },
  custom: {
    id: "custom",
    label: "Custom",
    apiKeyEnv: "OPENAI_API_KEY",
    models: OPENAI_MODELS,
  },
};

export function defaultProviderConfig(): ProviderConfig {
  return normalizeProviderConfig({ preset: "openai" });
}

export function normalizeProviderConfig(value: unknown): ProviderConfig {
  const input =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const preset = isProviderPresetId(input.preset) ? input.preset : "openai";
  const presetInfo = PROVIDER_PRESETS[preset];
  const baseURL = stringOrUndefined(input.baseURL) ?? presetInfo.baseURL;
  const requestedApiKeyEnv = isEnvName(input.apiKeyEnv)
    ? input.apiKeyEnv
    : presetInfo.apiKeyEnv;
  const apiKeyEnv =
    preset === "lmstudio" && requestedApiKeyEnv === "LMSTUDIO_API_KEY"
      ? presetInfo.apiKeyEnv
      : requestedApiKeyEnv;
  const outputFormat = normalizeOutputFormat(input.outputFormat);
  const models: Partial<Record<ModelSlot, string>> = {};
  const rawModels =
    input.models && typeof input.models === "object"
      ? (input.models as Record<string, unknown>)
      : {};
  for (const slot of MODEL_SLOTS) {
    const model = stringOrUndefined(rawModels[slot]);
    if (model) models[slot] = model;
  }

  return {
    preset,
    ...(baseURL ? { baseURL } : {}),
    apiKeyEnv,
    ...(Object.keys(models).length > 0 ? { models } : {}),
    outputFormat,
  };
}

export function resolveProviderRuntime(
  config: ProviderConfig | undefined,
  env: Env = process.env,
): ProviderRuntime {
  const normalized = normalizeProviderConfig(config);
  const preset = PROVIDER_PRESETS[normalized.preset];
  const apiKeyEnv = normalized.apiKeyEnv ?? preset.apiKeyEnv;
  const apiKey = resolveApiKey(apiKeyEnv, preset, env);
  const missingApiKey = apiKey || preset.local ? undefined : apiKeyEnv;
  const baseURL = normalized.baseURL ?? env.OPENAI_BASE_URL;
  const referer = env.OPENROUTER_REFERER;
  const defaultHeaders =
    baseURL && /openrouter\.ai/i.test(baseURL) && referer
      ? {
          "HTTP-Referer": referer,
          "X-OpenRouter-Title": env.OPENROUTER_TITLE ?? "Goblintown",
        }
      : undefined;

  return {
    id: normalized.preset,
    label: preset.label,
    baseURL,
    apiKeyEnv,
    apiKey,
    outputFormat: normalized.outputFormat ?? "freeform",
    models: {
      ...preset.models,
      ...(normalized.models ?? {}),
    },
    missingApiKey,
    ...(defaultHeaders ? { defaultHeaders } : {}),
  };
}

export function resolveModelForSlot(
  slot: ModelSlot,
  fallbackModel: string,
  config: ProviderConfig | undefined = loadProviderConfigFromCwd(),
  env: Env = process.env,
): string {
  const envModel = modelEnvValue(slot, env);
  if (envModel) return envModel;
  const runtime = resolveProviderRuntime(config, env);
  const model = runtime.models[slot] || fallbackModel;
  return resolveOpenRouterModel(model, runtime.baseURL);
}

export function loadProviderConfigFromCwd(cwd = process.cwd()): ProviderConfig {
  const manifestPath = findManifestPath(cwd);
  if (!manifestPath) return defaultProviderConfig();
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WarrenManifest;
    return normalizeProviderConfig(manifest.provider);
  } catch {
    return defaultProviderConfig();
  }
}

export function providerRuntimeSignature(runtime: ProviderRuntime): string {
  return JSON.stringify({
    id: runtime.id,
    baseURL: runtime.baseURL,
    apiKeyEnv: runtime.apiKeyEnv,
    apiKey: runtime.apiKey,
    headers: runtime.defaultHeaders,
  });
}

function resolveOpenRouterModel(model: string, baseURL: string | undefined): string {
  if (model.includes("/")) return model;
  if (!baseURL || !/openrouter\.ai/i.test(baseURL)) return model;
  return `openai/${model}`;
}

function resolveApiKey(
  apiKeyEnv: string,
  preset: ProviderPreset,
  env: Env,
): string {
  const candidates = [
    apiKeyEnv,
    preset.apiKeyEnv,
    ...(preset.apiKeyEnvAliases ?? []),
    "OPENAI_API_KEY",
  ];
  for (const key of Array.from(new Set(candidates))) {
    const value = stringOrUndefined(env[key]);
    if (value) return value;
  }
  return (preset.local ? preset.dummyApiKey : undefined) ?? "";
}

function modelEnvValue(slot: ModelSlot, env: Env): string | undefined {
  const key =
    slot === "scribe"
      ? "GOBLINTOWN_MODEL_SCRIBE"
      : slot === "embedding"
        ? "GOBLINTOWN_EMBEDDING_MODEL"
        : `GOBLINTOWN_MODEL_${slot.toUpperCase()}`;
  return stringOrUndefined(env[key]);
}

function isProviderPresetId(value: unknown): value is ProviderPresetId {
  return typeof value === "string" && value in PROVIDER_PRESETS;
}

function isEnvName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function findManifestPath(start: string): string | null {
  let cur = start;
  while (true) {
    const candidate = join(cur, ".goblintown", "warren.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
