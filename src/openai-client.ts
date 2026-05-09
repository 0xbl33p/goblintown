import OpenAI from "openai";
import { sharedSemaphore } from "./concurrency.js";
import {
  appendFormatInstruction,
  assertOutputFormat,
  buildFormatRepairPrompt,
  normalizeOutputFormat,
} from "./formatting.js";
import {
  loadProviderConfigFromCwd,
  providerRuntimeSignature,
  type ProviderRuntime,
  resolveProviderRuntimeForSlot,
} from "./providers.js";
import type {
  Creature,
  ModelSlot,
  OutputFormat,
  TokenUsage,
} from "./types.js";

const _clients = new Map<string, OpenAI>();

function getClient(runtime: ProviderRuntime): OpenAI {
  if (runtime.missingApiKey) {
    throw new Error(`${runtime.missingApiKey} is not set.`);
  }
  const signature = providerRuntimeSignature(runtime);
  const existing = _clients.get(signature);
  if (existing) return existing;
  const client = new OpenAI({
    apiKey: runtime.apiKey,
    baseURL: runtime.baseURL,
    maxRetries: 4,
    defaultHeaders: runtime.defaultHeaders,
  });
  _clients.set(signature, client);
  return client;
}

export interface CallOptions {
  maxOutputTokens?: number;
  signal?: AbortSignal;
  outputFormat?: OutputFormat;
}

export interface CreatureResponse {
  text: string;
  usage: TokenUsage;
}

// gpt-5 and o-series reasoning models reject `temperature` and use
// `max_completion_tokens` instead of `max_tokens`. Also covers the same
// families when accessed through OpenRouter as `openai/gpt-5...` or
// `openai/o3...`, plus DeepSeek-R and explicit `*-thinking` variants.
export function isFixedSamplingModel(model: string): boolean {
  const name = model.includes("/") ? model.split("/").slice(-1)[0] : model;
  return /^(gpt-5|o\d|deepseek-r\d)/i.test(name) || /-thinking$/i.test(name);
}

// OpenRouter addresses models as `vendor/name`. When OPENAI_BASE_URL points
// at OpenRouter and the configured model has no vendor prefix, default to
// the `openai/` namespace so the project's defaults (`gpt-5.4-mini`,
// `gpt-5.5`, etc.) keep working unchanged.
export function resolveModel(
  model: string,
  baseURL: string | undefined = process.env.OPENAI_BASE_URL,
): string {
  if (model.includes("/")) return model;
  if (!baseURL) return model;
  if (!/openrouter\.ai/i.test(baseURL)) return model;
  return `openai/${model}`;
}

interface BaseParams {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?: { type: "json_object" };
}

function buildBaseParams(
  creature: Creature,
  slot: ModelSlot,
  userPrompt: string,
  opts: CallOptions,
  runtime: ProviderRuntime,
): BaseParams {
  const model = resolveModel(runtime.models[slot] || creature.model, runtime.baseURL);
  const fixed = isFixedSamplingModel(model);
  const outputFormat = normalizeOutputFormat(opts.outputFormat ?? runtime.outputFormat);
  const params: BaseParams = {
    model,
    messages: [
      { role: "system", content: creature.systemPrompt },
      { role: "user", content: appendFormatInstruction(userPrompt, outputFormat) },
    ],
  };
  if (outputFormat === "json") {
    params.response_format = { type: "json_object" };
  }
  if (!fixed && creature.temperature !== undefined) {
    params.temperature = creature.temperature;
  }
  if (opts.maxOutputTokens !== undefined) {
    if (fixed) params.max_completion_tokens = opts.maxOutputTokens;
    else params.max_tokens = opts.maxOutputTokens;
  }
  return params;
}

export async function callCreature(
  creature: Creature,
  userPrompt: string,
  opts: CallOptions = {},
): Promise<CreatureResponse> {
  const config = loadProviderConfigFromCwd();
  const slot = creature.modelSlot ?? creature.kind;
  const runtime = resolveProviderRuntimeForSlot(slot, config);
  const client = getClient(runtime);
  const sem = sharedSemaphore();
  return sem.run(async () => {
    const completion = await client.chat.completions.create(
      buildBaseParams(creature, slot, userPrompt, opts, runtime),
      { signal: opts.signal },
    );
    const text = completion.choices[0]?.message?.content;
    if (!text) {
      throw new Error(
        `Creature ${creature.kind} returned an empty response (model=${creature.model}).`,
      );
    }
    let usage: TokenUsage = {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens ?? 0,
      model: completion.model ?? creature.model,
    };
    const formatted = await ensureFormattedOutput({
      client,
      creature,
      slot,
      userPrompt,
      opts,
      runtime,
      text,
      usage,
      signal: opts.signal,
    });
    usage = formatted.usage;
    return { text: formatted.text, usage };
  });
}

export async function callCreatureStream(
  creature: Creature,
  userPrompt: string,
  onChunk: (chunk: string) => void,
  opts: CallOptions = {},
): Promise<CreatureResponse> {
  const config = loadProviderConfigFromCwd();
  const slot = creature.modelSlot ?? creature.kind;
  const runtime = resolveProviderRuntimeForSlot(slot, config);
  const client = getClient(runtime);
  const sem = sharedSemaphore();
  return sem.run(async () => {
    const stream = await client.chat.completions.create(
      {
        ...buildBaseParams(creature, slot, userPrompt, opts, runtime),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: opts.signal },
    );
    let text = "";
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      model: creature.model,
    };
    for await (const event of stream) {
      const delta = event.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        text += delta;
        onChunk(delta);
      }
      if (event.usage) {
        usage = {
          promptTokens: event.usage.prompt_tokens ?? 0,
          completionTokens: event.usage.completion_tokens ?? 0,
          totalTokens: event.usage.total_tokens ?? 0,
          model: event.model ?? creature.model,
        };
      }
    }
    if (text.length === 0) {
      throw new Error(
        `Creature ${creature.kind} streamed an empty response (model=${creature.model}).`,
      );
    }
    const formatted = await ensureFormattedOutput({
      client,
      creature,
      slot,
      userPrompt,
      opts,
      runtime,
      text,
      usage,
      signal: opts.signal,
    });
    text = formatted.text;
    usage = formatted.usage;
    return { text, usage };
  });
}

async function ensureFormattedOutput(opts: {
  client: OpenAI;
  creature: Creature;
  slot: ModelSlot;
  userPrompt: string;
  opts: CallOptions;
  runtime: ProviderRuntime;
  text: string;
  usage: TokenUsage;
  signal?: AbortSignal;
}): Promise<CreatureResponse> {
  const outputFormat = normalizeOutputFormat(opts.opts.outputFormat);
  if (outputFormat === "freeform") return { text: opts.text, usage: opts.usage };
  try {
    return {
      text: assertOutputFormat(opts.text, outputFormat),
      usage: opts.usage,
    };
  } catch (err) {
    const repairPrompt = buildFormatRepairPrompt({
      format: outputFormat,
      originalPrompt: opts.userPrompt,
      output: opts.text,
      error: err instanceof Error ? err.message : String(err),
    });
    const repair = await opts.client.chat.completions.create(
      buildBaseParams(
        opts.creature,
        opts.slot,
        repairPrompt,
        { ...opts.opts, outputFormat },
        opts.runtime,
      ),
      { signal: opts.signal },
    );
    const repairedText = repair.choices[0]?.message?.content;
    if (!repairedText) throw err;
    const repairedUsage: TokenUsage = {
      promptTokens:
        opts.usage.promptTokens + (repair.usage?.prompt_tokens ?? 0),
      completionTokens:
        opts.usage.completionTokens + (repair.usage?.completion_tokens ?? 0),
      totalTokens:
        opts.usage.totalTokens + (repair.usage?.total_tokens ?? 0),
      model: repair.model ?? opts.usage.model,
    };
    return {
      text: assertOutputFormat(repairedText, outputFormat),
      usage: repairedUsage,
    };
  }
}
