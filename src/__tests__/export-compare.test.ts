import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoard } from "../hoard.js";
import { exportRiteMarkdown } from "../export.js";
import { compareRites } from "../compare.js";
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

function loot(
  riteId: string,
  kind: CreatureKind,
  output: string,
  parents?: string[],
): Loot {
  return {
    id: "",
    riteId,
    creatureKind: kind,
    personality: "nerdy",
    model: "test-model",
    prompt: "p",
    output,
    parentLootIds: parents,
    timestamp: Date.now(),
    drift: emptyDrift(),
    usage: {
      promptTokens: 50,
      completionTokens: 50,
      totalTokens: 100,
      model: "test-model",
    },
  };
}

let dir: string;
let hoard: Hoard;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "goblintown-export-"));
  hoard = new Hoard(join(dir, "hoard"));
  await hoard.init();
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function buildRite(id: string, task: string): Promise<Rite> {
  const goblinId = await hoard.stash(loot(id, "goblin", `goblin-output-${id}`));
  const winnerLoot = (await hoard.getLoot(goblinId))!;
  winnerLoot.reward = 0.7;
  await hoard.stash(winnerLoot);
  const rite: Rite = {
    id,
    task,
    scanGlobs: [],
    packSize: 1,
    personality: "nerdy",
    goblinLootIds: [goblinId],
    chaosLootIds: {},
    trollVerdicts: {
      [goblinId]: {
        lootId: goblinId,
        passed: true,
        score: 0.7,
        critique: "good",
      },
    },
    winnerLootId: goblinId,
    outcome: "winner",
    startedAt: Date.now(),
    finishedAt: Date.now(),
  };
  await hoard.stashRite(rite);
  return rite;
}

describe("exportRiteMarkdown", () => {
  it("returns null for unknown rite", async () => {
    assert.equal(await exportRiteMarkdown(hoard, "nope"), null);
  });

  it("emits a markdown bundle covering task, goblin, winner", async () => {
    const r = await buildRite("rx", "do a thing");
    const md = await exportRiteMarkdown(hoard, "rx");
    assert.ok(md);
    assert.match(md!, /# Rite `rx`/);
    assert.match(md!, /## Task/);
    assert.match(md!, /do a thing/);
    assert.match(md!, /## Goblin pack/);
    assert.match(md!, /## Winner/);
    assert.ok(md!.includes(r.winnerLootId!));
  });
});

describe("compareRites", () => {
  it("returns null when either rite is missing", async () => {
    await buildRite("a", "t");
    assert.equal(await compareRites(hoard, "a", "missing"), null);
    assert.equal(await compareRites(hoard, "missing", "a"), null);
  });

  it("flags identical tasks as matching, distinct as not", async () => {
    await buildRite("a", "the same task");
    await buildRite("b", "the same task");
    await buildRite("c", "a different task");
    const ab = await compareRites(hoard, "a", "b");
    const ac = await compareRites(hoard, "a", "c");
    assert.ok(ab);
    assert.ok(ac);
    assert.equal(ab!.taskMatches, true);
    assert.equal(ac!.taskMatches, false);
  });

  it("aggregates total tokens and pass rate per rite", async () => {
    await buildRite("solo", "t");
    const cmp = await compareRites(hoard, "solo", "solo");
    assert.ok(cmp);
    assert.equal(cmp!.a.totalTokens, 100);
    assert.equal(cmp!.a.totalLoot, 1);
    assert.equal(cmp!.a.passRate, 1);
  });
});
