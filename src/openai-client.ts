import OpenAI from "openai";
import { sharedSemaphore } from "./concurrency.js";
import type { Creature, TokenUsage } from "./types.js";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set.");
  }
  const baseURL = process.env.OPENAI_BASE_URL;
  const referer = process.env.OPENROUTER_REFERER;
  const defaultHeaders = referer
    ? {
        "HTTP-Referer": referer,
        "X-Title": process.env.OPENROUTER_TITLE ?? "Goblintown",
      }
    : undefined;
  _client = new OpenAI({
    apiKey,
    baseURL,
    maxRetries: 4,
    defaultHeaders,
  });
  return _client;
}

export interface CallOptions {
  maxOutputTokens?: number;
  signal?: AbortSignal;
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
}

function buildBaseParams(
  creature: Creature,
  userPrompt: string,
  opts: CallOptions,
): BaseParams {
  const model = resolveModel(creature.model);
  const fixed = isFixedSamplingModel(model);
  const params: BaseParams = {
    model,
    messages: [
      { role: "system", content: creature.systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
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
  const client = getClient();
  const sem = sharedSemaphore();
  return sem.run(async () => {
    const completion = await client.chat.completions.create(
      buildBaseParams(creature, userPrompt, opts),
      { signal: opts.signal },
    );
    const text = completion.choices[0]?.message?.content;
    if (!text) {
      throw new Error(
        `Creature ${creature.kind} returned an empty response (model=${creature.model}).`,
      );
    }
    const usage: TokenUsage = {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens ?? 0,
      model: completion.model ?? creature.model,
    };
    return { text, usage };
  });
}

export async function callCreatureStream(
  creature: Creature,
  userPrompt: string,
  onChunk: (chunk: string) => void,
  opts: CallOptions = {},
): Promise<CreatureResponse> {
  const client = getClient();
  const sem = sharedSemaphore();
  return sem.run(async () => {
    const stream = await client.chat.completions.create(
      {
        ...buildBaseParams(creature, userPrompt, opts),
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
    return { text, usage };
  });
}
