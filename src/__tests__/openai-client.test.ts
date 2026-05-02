import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { isFixedSamplingModel, resolveModel } from "../openai-client.js";

// `isFixedSamplingModel` is a small but load-bearing heuristic: it decides
// whether a model rejects `temperature` and uses `max_completion_tokens`.
// Misclassification breaks calls in production. These tests pin the
// supported families and make sure we don't accidentally over-match
// unrelated models when reading them through OpenRouter's `vendor/model`
// addressing.

describe("isFixedSamplingModel", () => {
  describe("matches reasoning-style models", () => {
    it("matches gpt-5 family", () => {
      assert.equal(isFixedSamplingModel("gpt-5"), true);
      assert.equal(isFixedSamplingModel("gpt-5.4-mini"), true);
      assert.equal(isFixedSamplingModel("gpt-5.5"), true);
    });

    it("matches o-series", () => {
      assert.equal(isFixedSamplingModel("o1"), true);
      assert.equal(isFixedSamplingModel("o3-mini"), true);
    });

    it("matches openai/* via OpenRouter", () => {
      assert.equal(isFixedSamplingModel("openai/o3-mini"), true);
      assert.equal(isFixedSamplingModel("openai/gpt-5.4-mini"), true);
    });

    it("matches deepseek-r* family", () => {
      assert.equal(isFixedSamplingModel("deepseek-r1"), true);
      assert.equal(isFixedSamplingModel("deepseek/deepseek-r1"), true);
    });

    it("matches any *-thinking variant", () => {
      assert.equal(
        isFixedSamplingModel("anthropic/claude-opus-4.5-thinking"),
        true,
      );
      assert.equal(isFixedSamplingModel("some-vendor/qwen-thinking"), true);
    });

    it("is case-insensitive", () => {
      assert.equal(isFixedSamplingModel("GPT-5"), true);
      assert.equal(isFixedSamplingModel("OpenAI/O3-Mini"), true);
    });
  });

  describe("does not match standard sampling models", () => {
    it("does not match anthropic/claude-haiku-4.5", () => {
      assert.equal(isFixedSamplingModel("anthropic/claude-haiku-4.5"), false);
    });

    it("does not match anthropic/claude-sonnet-4.6", () => {
      assert.equal(isFixedSamplingModel("anthropic/claude-sonnet-4.6"), false);
    });

    it("does not match openai/gpt-4o-mini", () => {
      assert.equal(isFixedSamplingModel("openai/gpt-4o-mini"), false);
      assert.equal(isFixedSamplingModel("gpt-4o-mini"), false);
    });

    it("does not match google/gemini-2.5-flash", () => {
      assert.equal(isFixedSamplingModel("google/gemini-2.5-flash"), false);
    });

    it("does not match meta-llama/llama-3.3-70b-instruct", () => {
      assert.equal(
        isFixedSamplingModel("meta-llama/llama-3.3-70b-instruct"),
        false,
      );
    });

    it("does not match a vendor name that contains 'o' followed by digits", () => {
      // Guards the OpenRouter prefix-strip: only the model name (after the
      // last "/") should be inspected, not the vendor.
      assert.equal(isFixedSamplingModel("o2-labs/llama-3"), false);
    });
  });
});

// `resolveModel` lets the project ship its OpenAI-flavored defaults
// (`gpt-5.4-mini`, `gpt-5.5`, ...) unchanged and still work when
// `OPENAI_BASE_URL` points at OpenRouter. It must:
//   - prepend `openai/` only when the base URL is OpenRouter,
//   - never touch a model that already carries a vendor prefix,
//   - never touch a model when no base URL is set (default OpenAI).

describe("resolveModel", () => {
  const OPENROUTER = "https://openrouter.ai/api/v1";

  it("prepends openai/ for an unprefixed model on OpenRouter", () => {
    assert.equal(resolveModel("gpt-5.4-mini", OPENROUTER), "openai/gpt-5.4-mini");
    assert.equal(resolveModel("gpt-5.5", OPENROUTER), "openai/gpt-5.5");
    assert.equal(resolveModel("o3-mini", OPENROUTER), "openai/o3-mini");
  });

  it("leaves an already-prefixed model untouched on OpenRouter", () => {
    assert.equal(
      resolveModel("anthropic/claude-haiku-4.5", OPENROUTER),
      "anthropic/claude-haiku-4.5",
    );
    assert.equal(
      resolveModel("openai/gpt-4o-mini", OPENROUTER),
      "openai/gpt-4o-mini",
    );
    assert.equal(
      resolveModel("google/gemini-2.5-flash", OPENROUTER),
      "google/gemini-2.5-flash",
    );
  });

  it("does not prefix when no base URL is set (default OpenAI)", () => {
    assert.equal(resolveModel("gpt-5.4-mini", undefined), "gpt-5.4-mini");
    assert.equal(resolveModel("gpt-5.5", undefined), "gpt-5.5");
  });

  it("does not prefix on non-OpenRouter custom endpoints", () => {
    assert.equal(
      resolveModel("gpt-5.4-mini", "https://api.groq.com/openai/v1"),
      "gpt-5.4-mini",
    );
    assert.equal(
      resolveModel("llama-3.3", "http://localhost:11434/v1"),
      "llama-3.3",
    );
  });

  it("matches openrouter.ai case-insensitively", () => {
    assert.equal(
      resolveModel("gpt-5.5", "https://OpenRouter.AI/api/v1"),
      "openai/gpt-5.5",
    );
  });
});
