import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { makeGoblin } from "../creatures.js";
import {
  GOBLIN_VARIANTS,
  variantForPackIndex,
} from "../goblin-variants.js";
import { CREATURE_KINDS } from "../types.js";

describe("Goblin variants", () => {
  it("does not change the pinned creature roster", () => {
    // Adding variants is a behavioural axis; CREATURE_KINDS must still match
    // the OpenAI ban-list bestiary exactly.
    assert.equal(CREATURE_KINDS.length, 6);
  });

  it("variantForPackIndex returns 'worker' for single-element packs", () => {
    assert.equal(variantForPackIndex(0, 1), "worker");
    assert.equal(variantForPackIndex(0, 0), "worker");
  });

  it("variantForPackIndex cycles through all variants", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) seen.add(variantForPackIndex(i, 4));
    assert.deepEqual([...seen].sort(), [...GOBLIN_VARIANTS].sort());
  });

  it("variantForPackIndex wraps around for packs larger than the variant pool", () => {
    assert.equal(
      variantForPackIndex(0, 9),
      variantForPackIndex(GOBLIN_VARIANTS.length, 9),
    );
  });

  it("makeGoblin variants change the system prompt", () => {
    const worker = makeGoblin("nerdy", "worker");
    const tinker = makeGoblin("nerdy", "tinker");
    const brawler = makeGoblin("nerdy", "brawler");
    const scout = makeGoblin("nerdy", "scout");
    assert.notEqual(worker.systemPrompt, tinker.systemPrompt);
    assert.notEqual(tinker.systemPrompt, brawler.systemPrompt);
    assert.notEqual(brawler.systemPrompt, scout.systemPrompt);
    assert.match(tinker.systemPrompt, /tinker variant/);
    assert.match(brawler.systemPrompt, /brawler variant/);
    assert.match(scout.systemPrompt, /scout variant/);
  });

  it("variants only adjust temperature, not kind or personality", () => {
    const a = makeGoblin("cynical", "scout");
    assert.equal(a.kind, "goblin");
    assert.equal(a.personality, "cynical");
    assert.ok(a.temperature > 0 && a.temperature < 2);
  });

  it("worker variant keeps the original temperature and prompt", () => {
    const w = makeGoblin("nerdy", "worker");
    const legacy = makeGoblin("nerdy");
    assert.equal(w.systemPrompt, legacy.systemPrompt);
    assert.equal(w.temperature, legacy.temperature);
  });
});
