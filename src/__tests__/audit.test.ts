import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoard } from "../hoard.js";
import { auditRite, collectRiteLootIds } from "../audit.js";
import type { CreatureKind, Loot, Rite, TokenUsage } from "../types.js";

function emptyDrift(rate = 0) {
  return {
    creatureMentions: {
      goblin: 0,
      gremlin: 0,
      raccoon: 0,
      troll: 0,
      ogre: 0,
      pigeon: 0,
    },
    totalCreatureWords: 0,
    outputWordCount: 100,
    driftRate: rate,
  };
}

function tokens(t: number, model = "test"): TokenUsage {
  return {
    promptTokens: Math.floor(t * 0.6),
    completionTokens: t - Math.floor(t * 0.6),
    totalTokens: t,
    model,
  };
}

function loot(
  kind: CreatureKind,
  output: string,
  parents?: string[],
  rate = 0,
  tok = 100,
): Loot {
  return {
    id: "",
    riteId: "test-rite",
    creatureKind: kind,
    personality: "nerdy",
    model: "test",
    prompt: kind + " prompt " + output,
    output,
    parentLootIds: parents,
    timestamp: Date.now(),
    drift: emptyDrift(rate),
    usage: tokens(tok),
  };
}

let dir: string;
let hoard: Hoard;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "goblintown-audit-"));
  hoard = new Hoard(join(dir, "hoard"));
  await hoard.init();
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("auditRite", () => {
  it("returns null for an unknown rite", async () => {
    const out = await auditRite(hoard, "nope");
    assert.equal(out, null);
  });

  it("aggregates tokens, drift, and longest chain", async () => {
    const raccoon = loot("raccoon", "facts", undefined, 0.0, 80);
    const ra = await hoard.stash(raccoon);
    const goblin = loot("goblin", "draft answer", [ra], 0.05, 200);
    const ga = await hoard.stash(goblin);
    const gremlin = loot("gremlin", "attacks", [ga], 0.1, 150);
    const gra = await hoard.stash(gremlin);
    const troll = loot("troll", '{"passed":true,"score":0.8,"critique":"ok"}', [
      ga,
      gra,
    ], 0.0, 50);
    const ta = await hoard.stash(troll);

    const rite: Rite = {
      id: "r1",
      task: "do thing",
      scanGlobs: ["src/**/*.ts"],
      packSize: 1,
      personality: "nerdy",
      contextLootId: ra,
      goblinLootIds: [ga],
      chaosLootIds: { [ga]: gra },
      trollVerdicts: {
        [ga]: { lootId: ga, passed: true, score: 0.8, critique: "ok" },
      },
      winnerLootId: ga,
      outcome: "winner",
      startedAt: 0,
    };
    await hoard.stashRite(rite);
    // Troll loot lives outside the rite manifest, so audit totals don't
    // include it — the manifest is the source of truth for what's "in" a rite.
    void ta;

    const report = await auditRite(hoard, "r1");
    assert.ok(report);
    assert.equal(report!.totalLoot, 3, "raccoon + goblin + gremlin");
    assert.equal(report!.totalTokens, 80 + 200 + 150);
    assert.equal(report!.byKind.goblin.count, 1);
    assert.equal(report!.byKind.gremlin.count, 1);
    assert.equal(report!.byKind.raccoon.count, 1);

    // Highest drift rate is the gremlin at 0.1
    assert.ok(report!.highestDrift);
    assert.equal(report!.highestDrift!.kind, "gremlin");

    // Longest chain: raccoon → goblin → gremlin = depth 3
    assert.equal(report!.longestChain.length, 3);
    assert.deepEqual(report!.longestChain.lootIds, [ra, ga, gra]);
    assert.equal(report!.warnings.length, 0);
  });

  it("warns when ogre_fallback was declared but no ogre loot is present", async () => {
    const goblinId = await hoard.stash(loot("goblin", "fail attempt"));
    const rite: Rite = {
      id: "r2",
      task: "t",
      scanGlobs: [],
      packSize: 1,
      personality: "nerdy",
      goblinLootIds: [goblinId],
      chaosLootIds: {},
      trollVerdicts: {},
      outcome: "ogre_fallback",
      startedAt: 0,
    };
    await hoard.stashRite(rite);
    const report = await auditRite(hoard, "r2");
    assert.ok(report);
    assert.ok(
      report!.warnings.some((w) => w.includes("ogre")),
      "should warn about missing ogre loot",
    );
  });
});

describe("collectRiteLootIds", () => {
  it("dedupes across all loot id sources", () => {
    const r: Rite = {
      id: "r",
      task: "t",
      scanGlobs: [],
      packSize: 2,
      personality: "nerdy",
      contextLootId: "ctx",
      goblinLootIds: ["g1", "g2", "g1"],
      chaosLootIds: { g1: "x1", g2: "x2" },
      ogreLootId: "o1",
      trollVerdicts: {},
      outcome: "ogre_fallback",
      startedAt: 0,
    };
    const ids = collectRiteLootIds(r);
    assert.deepEqual(new Set(ids), new Set(["ctx", "g1", "g2", "x1", "x2", "o1"]));
  });
});
