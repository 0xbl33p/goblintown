import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildClusterPrompt,
  buildSpecialistPrompt,
  parseClustersJson,
  pickSeedLoot,
} from "../specialist.js";
import type { Loot, TrollVerdict } from "../types.js";

const makeLoot = (id: string, output: string, reward = 0): Loot => ({
  id,
  riteId: "rite-1",
  creatureKind: "goblin",
  personality: "nerdy",
  model: "gpt-5.4-mini",
  prompt: "p",
  output,
  reward,
  timestamp: 0,
  drift: {
    creatureMentions: { goblin: 0, gremlin: 0, raccoon: 0, troll: 0, ogre: 0, pigeon: 0 },
    totalCreatureWords: 0,
    outputWordCount: output.split(/\s+/).length,
    driftRate: 0,
  },
});

const makeVerdict = (lootId: string, score: number, passed = false): TrollVerdict => ({
  lootId, passed, score, critique: "fails because " + lootId,
});

describe("buildClusterPrompt", () => {
  it("includes task, all goblins, verdicts, and gremlin attacks", () => {
    const goblinLoot = [
      makeLoot("g0", "first attempt"),
      makeLoot("g1", "second attempt"),
    ];
    const verdicts = {
      g0: makeVerdict("g0", 0.3),
      g1: makeVerdict("g1", 0.4),
    };
    const gremlinByGoblinId = {
      g0: makeLoot("gr0", "g0 fails on null input"),
      g1: makeLoot("gr1", "g1 fails on empty array"),
    };
    const out = buildClusterPrompt({
      task: "TASK_X", goblinLoot, verdicts, gremlinLootByGoblinId: gremlinByGoblinId, maxClusters: 3,
    });
    assert.ok(out.includes("TASK_X"));
    assert.ok(out.includes("first attempt"));
    assert.ok(out.includes("g0 fails on null input"));
    assert.ok(out.includes("Goblin #0"));
    assert.ok(out.includes("Goblin #1"));
    assert.ok(out.includes("clusters"));
    assert.ok(out.includes("severity"));
  });
});

describe("parseClustersJson", () => {
  it("parses a clean cluster array", () => {
    const json = JSON.stringify({
      clusters: [
        { name: "null-handling", description: "ignores null", affectedGoblinIndexes: [0, 1], specialistFocus: "handle null", severity: "high" },
        { name: "off-by-one", description: "loop bounds wrong", affectedGoblinIndexes: [2], specialistFocus: "fix bounds", severity: "medium" },
      ],
    });
    const out = parseClustersJson(json, 3, 5);
    assert.equal(out.length, 2);
    assert.equal(out[0].name, "null-handling");
    assert.equal(out[0].severity, "high");
    assert.deepEqual(out[0].affectedGoblinIndexes, [0, 1]);
  });

  it("strips code fences and leading prose", () => {
    const json = "Here are the clusters:\n```json\n" + JSON.stringify({
      clusters: [{ name: "n", description: "d", affectedGoblinIndexes: [], specialistFocus: "f", severity: "low" }],
    }) + "\n```";
    const out = parseClustersJson(json, 3, 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "n");
  });

  it("sorts by severity descending and respects the cap", () => {
    const json = JSON.stringify({
      clusters: [
        { name: "low-thing", description: "x", specialistFocus: "fix x", severity: "low" },
        { name: "high-thing", description: "y", specialistFocus: "fix y", severity: "high" },
        { name: "med-thing", description: "z", specialistFocus: "fix z", severity: "medium" },
        { name: "low-other", description: "w", specialistFocus: "fix w", severity: "low" },
      ],
    });
    const out = parseClustersJson(json, 3, 2);
    assert.equal(out.length, 2);
    assert.equal(out[0].name, "high-thing");
    assert.equal(out[1].name, "med-thing");
  });

  it("filters out invalid goblin indexes", () => {
    const json = JSON.stringify({
      clusters: [{ name: "n", description: "d", specialistFocus: "f", affectedGoblinIndexes: [0, 5, -1, 2], severity: "high" }],
    });
    const out = parseClustersJson(json, 3, 5);
    assert.deepEqual(out[0].affectedGoblinIndexes, [0, 2]);
  });

  it("coerces unknown severity to 'medium'", () => {
    const json = JSON.stringify({
      clusters: [{ name: "n", description: "d", specialistFocus: "f", severity: "catastrophic" }],
    });
    const out = parseClustersJson(json, 3, 5);
    assert.equal(out[0].severity, "medium");
  });

  it("drops clusters missing required fields", () => {
    const json = JSON.stringify({
      clusters: [
        { name: "", description: "missing name", specialistFocus: "f", severity: "high" },
        { name: "valid", description: "ok", specialistFocus: "f", severity: "high" },
        { name: "missing-focus", description: "ok", severity: "high" },
      ],
    });
    const out = parseClustersJson(json, 3, 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "valid");
  });

  it("returns [] for malformed JSON without throwing", () => {
    const out = parseClustersJson("totally not json", 3, 5);
    assert.deepEqual(out, []);
  });

  it("returns [] when 'clusters' is missing", () => {
    const out = parseClustersJson(JSON.stringify({ stuff: 1 }), 3, 5);
    assert.deepEqual(out, []);
  });

  it("falls back description to specialistFocus when description is empty", () => {
    const json = JSON.stringify({
      clusters: [{ name: "n", description: "", specialistFocus: "do the thing", severity: "high" }],
    });
    const out = parseClustersJson(json, 3, 5);
    assert.equal(out[0].description, "do the thing");
  });
});

describe("buildSpecialistPrompt", () => {
  it("includes task, focus, severity, seed, and gremlin critique", () => {
    const out = buildSpecialistPrompt({
      task: "TASK_Y",
      cluster: { name: "n", description: "DESCR", specialistFocus: "FOCUS", affectedGoblinIndexes: [0], severity: "high" },
      seedLoot: makeLoot("seed-1", "SEED_OUTPUT"),
      seedGremlinCritique: "GREMLIN_SAID",
    });
    assert.ok(out.includes("TASK_Y"));
    assert.ok(out.includes("FOCUS"));
    assert.ok(out.includes("DESCR"));
    assert.ok(out.includes("SEED_OUTPUT"));
    assert.ok(out.includes("GREMLIN_SAID"));
    assert.ok(out.includes("high"));
  });

  it("works without a gremlin critique", () => {
    const out = buildSpecialistPrompt({
      task: "T",
      cluster: { name: "n", description: "d", specialistFocus: "f", affectedGoblinIndexes: [], severity: "low" },
      seedLoot: makeLoot("s", "S"),
    });
    assert.ok(out.includes("T"));
    assert.ok(!out.includes("Gremlin's specific complaint"));
  });
});

describe("pickSeedLoot", () => {
  it("returns the highest-reward goblin", () => {
    const loots = [
      makeLoot("a", "x", 0.2),
      makeLoot("b", "y", 0.5),
      makeLoot("c", "z", 0.1),
    ];
    const seed = pickSeedLoot(loots, {});
    assert.equal(seed?.id, "b");
  });

  it("falls back to highest verdict score when reward is missing", () => {
    const loots = [
      makeLoot("a", "x"),
      makeLoot("b", "y"),
    ];
    delete loots[0].reward;
    delete loots[1].reward;
    const verdicts = {
      a: makeVerdict("a", 0.3),
      b: makeVerdict("b", 0.7),
    };
    const seed = pickSeedLoot(loots, verdicts);
    assert.equal(seed?.id, "b");
  });

  it("returns undefined for empty list", () => {
    assert.equal(pickSeedLoot([], {}), undefined);
  });
});
