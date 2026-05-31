import type { VoiceConfig, VoiceProviderId } from "./types.js";

export const DEFAULT_VOICE_PROMPT =
  "Goblintown chat, rites, Tank, Hoard, loot, model settings, and local AI workbench commands.";
export const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
export const OPENAI_REALTIME_MODEL = "gpt-realtime-2";
export const OPENAI_REALTIME_VOICE = "marin";
export const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

export interface VoiceTranscriptionRequest {
  url: string;
  headers: Record<string, string | undefined>;
  bodyKind: "form" | "audio";
  formFields: Record<string, string>;
  audio: Buffer;
  mimeType: string;
}

export interface VoiceTranscriptionInput {
  config: VoiceConfig;
  apiKey: string;
  audio: Buffer;
  mimeType: string;
}

export interface OpenAIRealtimeSessionConfig {
  type: "realtime";
  model: string;
  output_modalities: ["audio"];
  audio: {
    input: {
      transcription: {
        model: string;
      };
      turn_detection: {
        type: "server_vad";
        create_response: boolean;
        interrupt_response: boolean;
      };
    };
    output: {
      voice: string;
    };
  };
  instructions: string;
  max_output_tokens: number;
}

export function normalizeVoiceConfig(value: unknown): VoiceConfig {
  if (!value || typeof value !== "object") {
    return {
      provider: "browser",
      language: "en-US",
      prompt: DEFAULT_VOICE_PROMPT,
    };
  }
  const input = value as Record<string, unknown>;
  const provider = normalizeVoiceProvider(input.provider);
  const baseURL = stringOrUndefined(input.baseURL);
  const apiKeyEnv = isEnvName(input.apiKeyEnv) ? input.apiKeyEnv : undefined;
  const model = normalizeVoiceModel(provider, stringOrUndefined(input.model));
  const outputVoice = normalizeOutputVoice(input.outputVoice);
  const language = stringOrUndefined(input.language) ?? "en-US";
  const prompt = stringOrUndefined(input.prompt) ?? DEFAULT_VOICE_PROMPT;
  return {
    provider,
    ...(baseURL ? { baseURL } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(model ? { model } : {}),
    ...(outputVoice ? { outputVoice } : {}),
    language,
    prompt,
  };
}

export function voiceApiKeyEnv(config: VoiceConfig): string {
  if (config.apiKeyEnv) return config.apiKeyEnv;
  if (config.provider === "deepgram") return "DEEPGRAM_API_KEY";
  if (config.provider === "openai") return "OPENAI_API_KEY";
  return "VOICE_API_KEY";
}

export function voiceProviderNeedsServer(config: VoiceConfig): boolean {
  return config.provider !== "browser";
}

export function buildVoiceTranscriptionRequest(
  input: VoiceTranscriptionInput,
): VoiceTranscriptionRequest {
  const config = normalizeVoiceConfig(input.config);
  const mimeType = input.mimeType || "audio/webm";
  if (config.provider === "deepgram") {
    const url = new URL(config.baseURL || "https://api.deepgram.com/v1/listen");
    if (config.model) url.searchParams.set("model", config.model);
    if (config.language) url.searchParams.set("language", config.language);
    url.searchParams.set("smart_format", "true");
    return {
      url: url.toString(),
      headers: {
        Authorization: input.apiKey ? `Token ${input.apiKey}` : undefined,
        "Content-Type": mimeType,
      },
      bodyKind: "audio",
      formFields: {},
      audio: input.audio,
      mimeType,
    };
  }

  const url =
    config.provider === "openai"
      ? config.baseURL || "https://api.openai.com/v1/audio/transcriptions"
      : config.baseURL || "http://localhost:8000/v1/audio/transcriptions";
  const model =
    openAITranscriptionModel(config) ||
    (config.provider === "openai" ? OPENAI_TRANSCRIPTION_MODEL : undefined);
  const formFields: Record<string, string> = {};
  if (model) formFields.model = model;
  if (config.language) formFields.language = config.language;
  if (config.prompt) formFields.prompt = config.prompt;
  return {
    url,
    headers: {
      Authorization: input.apiKey ? `Bearer ${input.apiKey}` : undefined,
    },
    bodyKind: "form",
    formFields,
    audio: input.audio,
    mimeType,
  };
}

export function openAIRealtimeCallURL(config: VoiceConfig): string {
  const normalized = normalizeVoiceConfig(config);
  if (normalized.provider === "openai" && normalized.baseURL && /\/realtime\/calls\/?$/i.test(normalized.baseURL)) {
    return normalized.baseURL;
  }
  return OPENAI_REALTIME_CALLS_URL;
}

export function buildOpenAIRealtimeSessionConfig(
  config: VoiceConfig,
  options: { personality?: string } = {},
): OpenAIRealtimeSessionConfig {
  const normalized = normalizeVoiceConfig(config);
  return {
    type: "realtime",
    model: openAIRealtimeModel(normalized.model),
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: {
          model: OPENAI_TRANSCRIPTION_MODEL,
        },
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        voice: normalized.outputVoice || OPENAI_REALTIME_VOICE,
      },
    },
    instructions: openAIRealtimeInstructions(normalized, options.personality),
    max_output_tokens: 900,
  };
}

export async function transcribeVoiceAudio(input: {
  config: VoiceConfig;
  apiKey: string;
  audioBase64: string;
  mimeType: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const audio = Buffer.from(input.audioBase64, "base64");
  if (audio.length === 0) throw new Error("audio is required");
  const request = buildVoiceTranscriptionRequest({
    config: input.config,
    apiKey: input.apiKey,
    audio,
    mimeType: input.mimeType,
  });
  const audioBuffer = new ArrayBuffer(request.audio.byteLength);
  new Uint8Array(audioBuffer).set(request.audio);
  const fetcher = input.fetchImpl ?? fetch;
  let response: Response;
  if (request.bodyKind === "audio") {
    response = await fetcher(request.url, {
      method: "POST",
      headers: compactHeaders(request.headers),
      body: audioBuffer,
    });
  } else {
    const form = new FormData();
    for (const [key, value] of Object.entries(request.formFields)) {
      form.set(key, value);
    }
    form.set(
      "file",
      new Blob([audioBuffer], { type: request.mimeType }),
      fileNameForMimeType(request.mimeType),
    );
    response = await fetcher(request.url, {
      method: "POST",
      headers: compactHeaders(request.headers),
      body: form,
    });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessageFromPayload(payload) || `voice provider returned ${response.status}`);
  }
  return parseVoiceTranscript(payload);
}

export function parseVoiceTranscript(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const input = payload as Record<string, unknown>;
  const direct = stringOrUndefined(input.text) ?? stringOrUndefined(input.transcript);
  if (direct) return direct;
  const results = input.results as Record<string, unknown> | undefined;
  const channels = Array.isArray(results?.channels) ? results.channels : [];
  const firstChannel = channels[0] as Record<string, unknown> | undefined;
  const alternatives = Array.isArray(firstChannel?.alternatives)
    ? firstChannel.alternatives
    : [];
  const firstAlternative = alternatives[0] as Record<string, unknown> | undefined;
  return stringOrUndefined(firstAlternative?.transcript) ?? "";
}

function normalizeVoiceProvider(value: unknown): VoiceProviderId {
  return value === "openai" ||
    value === "deepgram" ||
    value === "local" ||
    value === "custom" ||
    value === "browser"
    ? value
    : "browser";
}

function normalizeVoiceModel(provider: VoiceProviderId, model: string | undefined): string | undefined {
  if (provider === "deepgram") {
    if (!model || /^aura-/i.test(model)) return "nova-3";
  }
  return model;
}

function normalizeOutputVoice(value: unknown): string | undefined {
  const input = stringOrUndefined(value);
  if (!input || !/^[a-z0-9_-]+$/i.test(input)) return undefined;
  return input;
}

function openAITranscriptionModel(config: VoiceConfig): string | undefined {
  if (config.provider !== "openai") return config.model;
  if (!config.model || isOpenAIRealtimeModel(config.model)) return OPENAI_TRANSCRIPTION_MODEL;
  return config.model;
}

function openAIRealtimeModel(model: string | undefined): string {
  if (!model || !isOpenAIRealtimeModel(model)) return OPENAI_REALTIME_MODEL;
  return model;
}

function isOpenAIRealtimeModel(model: string): boolean {
  return /^gpt-(?:[a-z0-9.-]+-)?realtime/i.test(model) || /^gpt-audio/i.test(model);
}

function openAIRealtimeInstructions(config: VoiceConfig, personality: string | undefined): string {
  const style = personality && /^[a-z0-9_-]+$/i.test(personality) ? personality : "goblin_mode";
  const vocabulary = config.prompt || DEFAULT_VOICE_PROMPT;
  return [
    "You are the live voice for Goblintown's single-goblin chat.",
    "Use the active personality label as steering, not as a literal name: " + style + ".",
    "Keep content useful, direct, and a little weird in the Goblintown house style.",
    "Favor Goblintown vocabulary when it is relevant: " + vocabulary,
    "Sound lively and textured, with quick turns and expressive timing, but keep speech clear enough to follow.",
    "Answer in spoken conversational language. Avoid markdown tables, long lists, URLs, or code unless the user asks.",
    "Do not claim to run tools or rites unless the app actually starts them; describe the next action plainly when needed.",
  ].join("\n");
}

function compactHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value) out[key] = value;
  }
  return out;
}

function errorMessageFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const input = payload as Record<string, unknown>;
  return stringOrUndefined(input.error) ?? stringOrUndefined(input.message) ?? "";
}

function fileNameForMimeType(mimeType: string): string {
  if (/mp4/i.test(mimeType)) return "voice.mp4";
  if (/mpeg|mp3/i.test(mimeType)) return "voice.mp3";
  if (/wav/i.test(mimeType)) return "voice.wav";
  if (/ogg/i.test(mimeType)) return "voice.ogg";
  return "voice.webm";
}

function isEnvName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value.trim());
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
