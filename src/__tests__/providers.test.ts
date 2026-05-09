import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_SLOTS,
  PROVIDER_PRESETS,
  normalizeProviderConfig,
  resolveModelForSlot,
  resolveProviderRuntimeForSlot,
  resolveProviderRuntime,
} from "../providers.js";
import {
  clearProviderSecretForRoot,
  providerSecretsPathForRoot,
  readProviderSecretsForRootSync,
  setProviderSecretForRoot,
} from "../provider-secrets.js";
import { initWarren, loadWarren } from "../warren.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "goblintown-provider-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("provider presets", () => {
  it("includes the common OpenAI-compatible API targets", () => {
    assert.deepEqual(
      Object.keys(PROVIDER_PRESETS).sort(),
      [
        "anthropic",
        "custom",
        "deepseek",
        "gemini",
        "groq",
        "lmstudio",
        "mistral",
        "ollama",
        "openai",
        "openrouter",
        "together",
      ],
    );
  });

  it("normalizes unknown or partial config to a safe OpenAI default", () => {
    const cfg = normalizeProviderConfig({
      preset: "unknown",
      baseURL: "   ",
      apiKeyEnv: "not a valid env var",
      outputFormat: "xml",
      models: { goblin: "  custom-goblin  ", nope: "bad" },
    });

    assert.equal(cfg.preset, "openai");
    assert.equal(cfg.baseURL, undefined);
    assert.equal(cfg.apiKeyEnv, "OPENAI_API_KEY");
    assert.equal(cfg.outputFormat, "freeform");
    assert.deepEqual(cfg.models, { goblin: "custom-goblin" });
  });

  it("resolves local providers with a dummy API key when no key is set", () => {
    const runtime = resolveProviderRuntime(
      { preset: "ollama", outputFormat: "markdown" },
      {},
    );

    assert.equal(runtime.id, "ollama");
    assert.equal(runtime.baseURL, "http://localhost:11434/v1");
    assert.equal(runtime.apiKey, "ollama");
    assert.equal(runtime.outputFormat, "markdown");
  });

  it("does not send a malformed dummy token to LM Studio", () => {
    const runtime = resolveProviderRuntime({ preset: "lmstudio" }, {});

    assert.equal(runtime.id, "lmstudio");
    assert.equal(runtime.apiKeyEnv, "LM_API_TOKEN");
    assert.equal(runtime.apiKey, "");
    assert.equal(runtime.missingApiKey, undefined);
  });

  it("uses LM_API_TOKEN for LM Studio even when an older env name is configured", () => {
    const runtime = resolveProviderRuntime(
      { preset: "lmstudio", apiKeyEnv: "LMSTUDIO_API_KEY" },
      { LM_API_TOKEN: "sk-lm-real-token" },
    );

    assert.equal(runtime.apiKeyEnv, "LM_API_TOKEN");
    assert.equal(runtime.apiKey, "sk-lm-real-token");
  });

  it("keeps the older LMSTUDIO_API_KEY name as an alias", () => {
    const runtime = resolveProviderRuntime(
      { preset: "lmstudio" },
      { LMSTUDIO_API_KEY: "sk-lm-legacy-token" },
    );

    assert.equal(runtime.apiKeyEnv, "LM_API_TOKEN");
    assert.equal(runtime.apiKey, "sk-lm-legacy-token");
  });

  it("prefers provider-specific keys but falls back to OPENAI_API_KEY", () => {
    const specific = resolveProviderRuntime(
      { preset: "groq" },
      { GROQ_API_KEY: "groq-key", OPENAI_API_KEY: "generic-key" },
    );
    assert.equal(specific.apiKey, "groq-key");

    const fallback = resolveProviderRuntime(
      { preset: "groq" },
      { OPENAI_API_KEY: "generic-key" },
    );
    assert.equal(fallback.apiKey, "generic-key");
  });

  it("prefers environment keys over saved local secrets", () => {
    const runtime = resolveProviderRuntime(
      { preset: "groq" },
      { GROQ_API_KEY: "env-key" },
      { GROQ_API_KEY: "stored-key" },
    );
    assert.equal(runtime.apiKey, "env-key");
    assert.equal(runtime.apiKeySource, "env");
  });

  it("falls back to saved local secrets when env is missing", () => {
    const runtime = resolveProviderRuntime(
      { preset: "groq" },
      {},
      { GROQ_API_KEY: "stored-key" },
    );
    assert.equal(runtime.apiKey, "stored-key");
    assert.equal(runtime.apiKeySource, "stored");
  });

  it("resolves model slots from explicit config before preset defaults", () => {
    const cfg = normalizeProviderConfig({
      preset: "deepseek",
      models: { goblin: "deepseek-v4-flash", ogre: "deepseek-v4-pro" },
    });

    assert.equal(resolveModelForSlot("goblin", "gpt-5.4-mini", cfg), "deepseek-v4-flash");
    assert.equal(resolveModelForSlot("ogre", "gpt-5.5", cfg), "deepseek-v4-pro");
    assert.ok(MODEL_SLOTS.includes("scribe"));
  });

  it("supports per-slot provider routes", () => {
    const cfg = normalizeProviderConfig({
      preset: "openai",
      models: { goblin: "gpt-5.4-mini" },
      routes: {
        goblin: {
          preset: "ollama",
          model: "gemma3:27b",
          baseURL: "http://localhost:11434/v1",
        },
      },
    });
    const goblinRuntime = resolveProviderRuntimeForSlot("goblin", cfg, {});
    assert.equal(goblinRuntime.id, "ollama");
    assert.equal(goblinRuntime.baseURL, "http://localhost:11434/v1");
    assert.equal(
      resolveModelForSlot("goblin", "gpt-5.4-mini", cfg, {}),
      "gemma3:27b",
    );
    const ogreRuntime = resolveProviderRuntimeForSlot("ogre", cfg, {});
    assert.equal(ogreRuntime.id, "openai");
  });
});

describe("Warren provider config", () => {
  it("initializes new warrens with provider config and no stored secrets", async () => {
    const w = await initWarren(dir);

    assert.equal(w.manifest.provider?.preset, "openai");
    assert.equal(w.manifest.provider?.apiKeyEnv, "OPENAI_API_KEY");
    assert.equal("apiKey" in (w.manifest.provider as object), false);

    const raw = await readFile(join(dir, ".goblintown", "warren.json"), "utf8");
    assert.equal(raw.includes("sk-"), false);
  });

  it("loads older warrens by adding an in-memory provider default", async () => {
    await initWarren(dir);
    const manifestPath = join(dir, ".goblintown", "warren.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete raw.provider;
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(manifestPath, JSON.stringify(raw, null, 2), "utf8"),
    );

    const loaded = await loadWarren(dir);
    assert.equal(loaded.manifest.provider?.preset, "openai");
  });

  it("stores and clears provider secrets in a local file outside warren.json", async () => {
    await initWarren(dir);
    const secretPath = providerSecretsPathForRoot(dir);
    await setProviderSecretForRoot(dir, "GROQ_API_KEY", "sk-local");
    const secrets = readProviderSecretsForRootSync(dir);
    assert.equal(secrets.GROQ_API_KEY, "sk-local");

    const manifestRaw = await readFile(join(dir, ".goblintown", "warren.json"), "utf8");
    assert.equal(manifestRaw.includes("sk-local"), false);

    await clearProviderSecretForRoot(dir, "GROQ_API_KEY");
    const after = readProviderSecretsForRootSync(dir);
    assert.equal("GROQ_API_KEY" in after, false);
    const exists = await import("node:fs/promises").then(async ({ access }) => {
      try {
        await access(secretPath);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(exists, false);
  });
});
