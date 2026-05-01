import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoard } from "../hoard.js";
import type { Loot, Quest, Rite } from "../types.js";

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
    outputWordCount: 0,
    driftRate: 0,
  };
}

function makeLoot(overrides: Partial<Loot> = {}): Loot {
  return {
    id: "",
    creatureKind: "goblin",
    personality: "nerdy",
    model: "test-model",
    prompt: "p",
    output: "o",
    timestamp: 0,
    drift: emptyDrift(),
    ...overrides,
  };
}

let dir: string;
let hoard: Hoard;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "goblintown-test-"));
  hoard = new Hoard(join(dir, "hoard"));
  await hoard.init();
});

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("Hoard", () => {
  it("assigns a content-addressed id on stash", async () => {
    const id = await hoard.stash(makeLoot());
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it("stash is deterministic for identical (model, prompt, output)", async () => {
    const a = await hoard.stash(makeLoot({ output: "same" }));
    const b = await hoard.stash(makeLoot({ output: "same" }));
    assert.equal(a, b);
  });

  it("stash differs when any of (model, prompt, output) changes", async () => {
    const a = await hoard.stash(makeLoot({ output: "alpha" }));
    const b = await hoard.stash(makeLoot({ output: "beta" }));
    const c = await hoard.stash(makeLoot({ prompt: "different" }));
    const d = await hoard.stash(makeLoot({ model: "another-model" }));
    assert.equal(new Set([a, b, c, d]).size, 4);
  });

  it("getLoot round-trips a stashed Loot", async () => {
    const id = await hoard.stash(makeLoot({ output: "hello" }));
    const got = await hoard.getLoot(id);
    assert.ok(got);
    assert.equal(got!.output, "hello");
  });

  it("getLoot returns null for missing ids", async () => {
    const got = await hoard.getLoot("deadbeef00000000");
    assert.equal(got, null);
  });

  it("allLoot lists every stashed Loot", async () => {
    await hoard.stash(makeLoot({ output: "a" }));
    await hoard.stash(makeLoot({ output: "b" }));
    await hoard.stash(makeLoot({ output: "c" }));
    const all = await hoard.allLoot();
    assert.equal(all.length, 3);
  });

  it("stashes and reads quests", async () => {
    const q: Quest = {
      id: "q1",
      task: "t",
      packSize: 1,
      personality: "nerdy",
      lootIds: [],
      trollVerdicts: {},
      startedAt: 0,
    };
    await hoard.stashQuest(q);
    const all = await hoard.allQuests();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, "q1");
  });

  it("stashes and reads rites", async () => {
    const r: Rite = {
      id: "r1",
      task: "t",
      scanGlobs: [],
      packSize: 1,
      personality: "nerdy",
      goblinLootIds: [],
      chaosLootIds: {},
      trollVerdicts: {},
      outcome: "all_failed",
      startedAt: 0,
    };
    await hoard.stashRite(r);
    const got = await hoard.getRite("r1");
    assert.ok(got);
    assert.equal(got!.id, "r1");
  });
});

