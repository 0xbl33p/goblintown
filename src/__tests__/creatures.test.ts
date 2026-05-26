import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { makeGoblin } from "../creatures.js";

describe("makeGoblin", () => {
  it("supports goblin_mode personality in the system prompt", () => {
    const goblin = makeGoblin("goblin_mode");
    assert.equal(goblin.personality, "goblin_mode");
    assert.match(goblin.systemPrompt, /Personality: goblin_mode/);
    assert.match(goblin.systemPrompt, /chaotic gremlin-coder/i);
  });
});
