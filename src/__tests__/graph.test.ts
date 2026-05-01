import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoard } from "../hoard.js";
import { renderLootAncestry, renderRiteGraph } from "../graph.js";
import type { CreatureKind, Loot, Rite } from "../types.js";

function emptyDrift() {
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
    outputWordCount: 1,
    driftRate: 0,
  };
}

function loot(kind: CreatureKind, output: string, parents?: string[]): Loot {
  return {
    id: "",
    riteId: "rg1",
    creatureKind: kind,
    personality: "nerdy",
    model: "test",
    prompt: kind + " " + output,
    output,
    parentLootIds: parents,
    timestamp: Date.now(),
    drift: emptyDrift(),
  };
}

let dir: string;
let hoard: Hoard;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "goblintown-graph-"));
  hoard = new Hoard(join(dir, "hoard"));
  await hoard.init();
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("renderRiteGraph", () => {
  it("returns null for an unknown rite", async () => {
    const out = await renderRiteGraph(hoard, "missing");
    assert.equal(out, null);
  });

  it("renders raccoon, goblin, gremlin, troll, and ogre rows", async () => {
    const ra = await hoard.stash(loot("raccoon", "facts"));
    const g1 = await hoard.stash(loot("goblin", "draft 1", [ra]));
    const g2 = await hoard.stash(loot("goblin", "draft 2", [ra]));
    const x1 = await hoard.stash(loot("gremlin", "attacks 1", [g1]));
    const x2 = await hoard.stash(loot("gremlin", "attacks 2", [g2]));
    const t1 = await hoard.stash(loot("troll", "verdict 1", [g1, x1]));
    const t2 = await hoard.stash(loot("troll", "verdict 2", [g2, x2]));
    const og = await hoard.stash(loot("ogre", "fallback", [g1, g2]));

    const rite: Rite = {
      id: "rg1",
      task: "render me",
      scanGlobs: [],
      packSize: 2,
      personality: "nerdy",
      contextLootId: ra,
      goblinLootIds: [g1, g2],
      chaosLootIds: { [g1]: x1, [g2]: x2 },
      ogreLootId: og,
      trollVerdicts: {
        [g1]: { lootId: g1, passed: false, score: 0.3, critique: "" },
        [g2]: { lootId: g2, passed: false, score: 0.4, critique: "" },
      },
      winnerLootId: og,
      outcome: "ogre_fallback",
      startedAt: 0,
    };
    await hoard.stashRite(rite);

    const out = await renderRiteGraph(hoard, "rg1");
    assert.ok(out);
    assert.match(out!, /raccoon\s+/);
    assert.match(out!, /goblin\s+/);
    assert.match(out!, /gremlin/);
    assert.match(out!, /ogre/);
    assert.match(out!, /★ winner \(fallback\)/);
    // Trolls should be picked up because their parent is one of the goblins
    assert.ok(out!.includes(t1) || out!.includes(t2));
  });
});

describe("renderLootAncestry", () => {
  it("walks parent chain back to roots", async () => {
    const root = await hoard.stash(loot("raccoon", "root"));
    const mid = await hoard.stash(loot("goblin", "mid", [root]));
    const top = await hoard.stash(loot("ogre", "top", [mid]));
    const out = await renderLootAncestry(hoard, top);
    assert.ok(out);
    assert.match(out!, /ogre\s+/);
    assert.match(out!, /goblin\s+/);
    assert.match(out!, /raccoon\s+/);
  });

  it("handles cycles without infinite recursion", async () => {
    const a = await hoard.stash(loot("goblin", "a"));
    // Tamper: rewrite a's parents to point to itself
    const aLoot = await hoard.getLoot(a);
    assert.ok(aLoot);
    aLoot!.parentLootIds = [a];
    await hoard.stash(aLoot!);
    const out = await renderLootAncestry(hoard, a);
    assert.ok(out);
    assert.match(out!, /cycle/);
  });
});
