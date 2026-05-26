import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildVoiceTranscriptionRequest,
  normalizeVoiceConfig,
  parseVoiceTranscript,
  transcribeVoiceAudio,
} from "../voice.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");

describe("voice connectors", () => {
  it("normalizes browser voice as the no-key default", () => {
    const config = normalizeVoiceConfig(undefined);

    assert.deepEqual(config, {
      provider: "browser",
      language: "en-US",
      prompt: "Goblintown chat, rites, Tank, Hoard, loot, model settings, and local AI workbench commands.",
    });
  });

  it("keeps voice connector settings independent from text model providers", () => {
    const config = normalizeVoiceConfig({
      provider: "deepgram",
      apiKeyEnv: "DEEPGRAM_API_KEY",
      model: "nova-3",
      language: "en",
      prompt: "Prefer Goblintown product terms.",
    });

    assert.equal(config.provider, "deepgram");
    assert.equal(config.apiKeyEnv, "DEEPGRAM_API_KEY");
    assert.equal(config.model, "nova-3");
    assert.equal(config.language, "en");
    assert.match(config.prompt ?? "", /Goblintown/);
  });

  it("normalizes Deepgram voice models to speech-to-text models", () => {
    assert.equal(
      normalizeVoiceConfig({ provider: "deepgram", model: "aura-2-draco-en" }).model,
      "nova-3",
    );
    assert.equal(
      normalizeVoiceConfig({ provider: "deepgram" }).model,
      "nova-3",
    );
  });

  it("rejects malformed config values back to safe browser defaults", () => {
    const config = normalizeVoiceConfig({
      provider: "../deepgram",
      apiKeyEnv: "not-a-real env",
      baseURL: "   ",
      language: "",
      prompt: "",
    });

    assert.equal(config.provider, "browser");
    assert.equal(config.apiKeyEnv, undefined);
    assert.equal(config.baseURL, undefined);
    assert.equal(config.language, "en-US");
    assert.match(config.prompt ?? "", /Goblintown chat/);
  });

  it("builds OpenAI transcription requests as multipart form data", () => {
    const request = buildVoiceTranscriptionRequest({
      config: normalizeVoiceConfig({
        provider: "openai",
        apiKeyEnv: "OPENAI_API_KEY",
        model: "gpt-4o-mini-transcribe",
        prompt: "Goblintown terms: rite, Tank, Hoard.",
      }),
      apiKey: "sk-test",
      audio: Buffer.from("audio"),
      mimeType: "audio/webm",
    });

    assert.equal(request.url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(request.headers.Authorization, "Bearer sk-test");
    assert.equal(request.bodyKind, "form");
    assert.equal(request.formFields.model, "gpt-4o-mini-transcribe");
    assert.equal(request.formFields.prompt, "Goblintown terms: rite, Tank, Hoard.");
  });

  it("builds Deepgram transcription requests as direct audio uploads", () => {
    const request = buildVoiceTranscriptionRequest({
      config: normalizeVoiceConfig({
        provider: "deepgram",
        apiKeyEnv: "DEEPGRAM_API_KEY",
        model: "nova-3",
        language: "en-US",
      }),
      apiKey: "dg-test",
      audio: Buffer.from("audio"),
      mimeType: "audio/webm",
    });

    assert.match(request.url, /^https:\/\/api\.deepgram\.com\/v1\/listen\?/);
    assert.match(request.url, /model=nova-3/);
    assert.match(request.url, /language=en-US/);
    assert.equal(request.headers.Authorization, "Token dg-test");
    assert.equal(request.headers["Content-Type"], "audio/webm");
    assert.equal(request.bodyKind, "audio");
  });

  it("builds local and custom transcription requests without requiring a built-in provider", () => {
    const local = buildVoiceTranscriptionRequest({
      config: normalizeVoiceConfig({ provider: "local", model: "whisper-large-v3" }),
      apiKey: "",
      audio: Buffer.from("audio"),
      mimeType: "audio/webm",
    });
    const custom = buildVoiceTranscriptionRequest({
      config: normalizeVoiceConfig({
        provider: "custom",
        baseURL: "http://localhost:8787/transcribe",
        apiKeyEnv: "VOICE_API_KEY",
        model: "my-stt",
      }),
      apiKey: "local-secret",
      audio: Buffer.from("audio"),
      mimeType: "audio/webm",
    });

    assert.equal(local.url, "http://localhost:8000/v1/audio/transcriptions");
    assert.equal(local.bodyKind, "form");
    assert.equal(local.headers.Authorization, undefined);
    assert.equal(custom.url, "http://localhost:8787/transcribe");
    assert.equal(custom.headers.Authorization, "Bearer local-secret");
    assert.equal(custom.formFields.model, "my-stt");
  });

  it("parses common transcript response shapes", () => {
    assert.equal(parseVoiceTranscript({ text: "hello" }), "hello");
    assert.equal(parseVoiceTranscript({ transcript: "hi" }), "hi");
    assert.equal(
      parseVoiceTranscript({
        results: { channels: [{ alternatives: [{ transcript: "deepgram words" }] }] },
      }),
      "deepgram words",
    );
  });

  it("returns an empty transcript for malformed provider payloads", () => {
    assert.equal(parseVoiceTranscript(null), "");
    assert.equal(parseVoiceTranscript({ text: "   " }), "");
    assert.equal(parseVoiceTranscript({ results: { channels: [] } }), "");
  });

  it("refuses empty audio before calling a provider", async () => {
    await assert.rejects(
      () =>
        transcribeVoiceAudio({
          config: normalizeVoiceConfig({ provider: "local" }),
          apiKey: "",
          audioBase64: "",
          mimeType: "audio/webm",
          fetchImpl: async () => {
            throw new Error("fetch should not run");
          },
        }),
      /audio is required/,
    );
  });

  it("wires voice mode into the Tank without reusing text provider controls", () => {
    assert.match(serverSource, /id="voice-popover"/);
    assert.match(serverSource, /id="voice-provider"/);
    assert.match(serverSource, /id="voice-prompt"/);
    assert.match(serverSource, /app\.get\("\/api\/voice"/);
    assert.match(serverSource, /app\.post\("\/api\/voice"/);
    assert.match(serverSource, /app\.post\("\/api\/voice\/transcribe"/);
    assert.match(serverSource, /SpeechRecognition \|\| window\.webkitSpeechRecognition/);
    assert.match(serverSource, /function goblinifyVoiceTranscript/);
    assert.match(serverSource, /function voiceInputErrorMessage\(err\)/);
    assert.match(serverSource, /microphone permission denied; allow/);
    assert.match(serverSource, /Privacy & Security > Microphone/);
    assert.match(serverSource, /fetch\("\/api\/voice\/transcribe"/);
  });

  it("treats Chat Live as a hands-free conversation loop", () => {
    assert.match(serverSource, /let rootChatVoiceMode = "text"/);
    assert.match(serverSource, /let voiceSessionGeneration = 0/);
    assert.match(serverSource, /function scheduleLiveVoiceRestart\(generation\)/);
    assert.match(serverSource, /function submitLiveVoiceInput\(\)/);
    assert.match(serverSource, /voiceSessionGeneration !== expectedGeneration/);
    assert.match(serverSource, /function stopVoiceInput\(invalidate\)[\s\S]*voiceSessionGeneration \+= 1/);
    assert.match(serverSource, /if \(rootChatSpeaking\) return/);
    assert.match(serverSource, /rootChatSpeaking \|\| voiceSessionGeneration !== expectedGeneration/);
    assert.match(serverSource, /recognition\.continuous = rootChatVoiceMode === "full"/);
    assert.match(serverSource, /submitLiveVoiceInput\(\);/);
    assert.match(serverSource, /scheduleLiveVoiceRestart\(activeGeneration\);/);
    assert.match(serverSource, /if \(voiceRecorder === recorder\) voiceRecorder = null/);
    assert.match(serverSource, /live listening/);
    assert.doesNotMatch(serverSource, /recording; click Voice again to stop/);
  });

  it("surfaces live voice actions from the full settings workbench", () => {
    assert.match(serverSource, /data-settings-section="voice"/);
    assert.match(serverSource, /settings-live-voice/);
    assert.match(serverSource, /settings-voice-config/);
    assert.match(serverSource, /settings-live-voice[\s\S]*setRootChatSpeakEnabled\(true\)[\s\S]*beginSpeechInput\(\)/);
    assert.match(serverSource, /settings-voice-config[\s\S]*voiceChip\.click\(\)/);
  });
});
