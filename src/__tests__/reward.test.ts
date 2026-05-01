import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { shinies } from "../reward.js";
import type { Loot, TrollVerdict } from "../types.js";

function loot(output: string, kind: Loot["creatureKind"] = "goblin"): Loot {
  return {
    id: "x",
    creatureKind: kind,
    personality: "nerdy",
    model: "test",
    prompt: "p",
    output,
    timestamp: 0,
    drift: {
      // drift gets recomputed by shinies via crossCreatureDrift; this is unused
      creatureMentions: {
        goblin: 0,
        gremlin: 0,
        raccoon: 0,
        troll: 0,
        ogre: 0,
        pigeon: 0,
      },
      totalCreatureWords: 0,
      outputWordCount: 0,
      driftRate: 0,
    },
  };
}

function verdict(score: number, passed: boolean): TrollVerdict {
  return { lootId: "x", passed, score, critique: "" };
}

describe("shinies", () => {
  it("clean output passing review hits the pass bonus", () => {
    const r = shinies(loot("a clean answer with no creatures"), verdict(0.8, true));
    // 0.8 + 0.1 = 0.9
    assert.equal(r.toFixed(3), "0.900");
  });

  it("clean output failing review gets no pass bonus", () => {
    const r = shinies(loot("a clean answer"), verdict(0.4, false));
    assert.equal(r.toFixed(3), "0.400");
  });

  it("cross-creature drift penalises score", () => {
    // 4 words total, 1 raccoon (cross), goblin self-kind
    const drifty = shinies(
      loot("answer mentions a raccoon here", "goblin"),
      verdict(0.9, true),
    );
    const clean = shinies(
      loot("answer mentions zero creatures here", "goblin"),
      verdict(0.9, true),
    );
    assert.ok(drifty < clean, "drifty output should score lower than clean");
  });

  it("clamps to [0, 1]", () => {
    const r1 = shinies(loot("clean"), verdict(2, true));
    const r2 = shinies(loot("clean"), verdict(-1, false));
    assert.ok(r1 <= 1);
    assert.ok(r2 >= 0);
  });

  it("drift penalty is bounded", () => {
    // Wall of cross-creature words shouldn't drive shinies negative.
    const wall = "raccoon ".repeat(100);
    const r = shinies(loot(wall, "goblin"), verdict(0.5, true));
    assert.ok(r >= 0);
    assert.ok(r <= 1);
  });
});
