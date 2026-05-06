import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  appendFormatInstruction,
  assertOutputFormat,
  buildFormatRepairPrompt,
  normalizeOutputFormat,
} from "../formatting.js";

describe("output formatting", () => {
  it("normalizes unsupported formats to freeform", () => {
    assert.equal(normalizeOutputFormat("markdown"), "markdown");
    assert.equal(normalizeOutputFormat("json"), "json");
    assert.equal(normalizeOutputFormat("xml"), "freeform");
    assert.equal(normalizeOutputFormat(undefined), "freeform");
  });

  it("adds markdown instructions without changing freeform prompts", () => {
    assert.equal(appendFormatInstruction("answer this", "freeform"), "answer this");

    const prompt = appendFormatInstruction("answer this", "markdown");
    assert.match(prompt, /answer this/);
    assert.match(prompt, /Markdown/);
    assert.match(prompt, /Do not wrap the entire answer in a code fence/);
  });

  it("adds JSON-object instructions", () => {
    const prompt = appendFormatInstruction("answer this", "json");
    assert.match(prompt, /valid JSON object/);
    assert.match(prompt, /Do not include Markdown fences/);
  });

  it("extracts and canonicalizes a JSON object from fenced model output", () => {
    const out = assertOutputFormat("```json\n{\"answer\":\"yes\",\"count\":2}\n```", "json");
    assert.equal(out, JSON.stringify({ answer: "yes", count: 2 }, null, 2));
  });

  it("rejects arrays and malformed JSON when JSON object output is required", () => {
    assert.throws(
      () => assertOutputFormat("[1,2,3]", "json"),
      /valid JSON object/,
    );
    assert.throws(
      () => assertOutputFormat("{ nope", "json"),
      /valid JSON object/,
    );
  });

  it("builds a repair prompt that preserves the original task and bad output", () => {
    const prompt = buildFormatRepairPrompt({
      format: "json",
      originalPrompt: "Return status",
      output: "status: ok",
      error: "not json",
    });

    assert.match(prompt, /Return status/);
    assert.match(prompt, /status: ok/);
    assert.match(prompt, /not json/);
    assert.match(prompt, /valid JSON object/);
  });
});
