import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoard } from "../hoard.js";
import { JsonHoardBackend } from "../hoard-json.js";
import { SqliteHoardBackend } from "../hoard-sqlite.js";
import { copyHoard } from "../migrate.js";
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
    prompt: "test prompt",
    output: "test output",
    timestamp: 1700000000000,
    drift: emptyDrift(),
    ...overrides,
  };
}

describe("SqliteHoardBackend", () => {
  let dir: string;
  let hoard: Hoard;
  let backend: SqliteHoardBackend;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gt-sqlite-"));
    backend = new SqliteHoardBackend(join(dir, "hoard.db"));
    hoard = new Hoard(dir, backend);
    await hoard.init();
  });

  afterEach(async () => {
    backend.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("stash/getLoot round-trips", async () => {
    const id = await hoard.stash(makeLoot({ output: "alpha" }));
    const back = await hoard.getLoot(id);
    assert.equal(back?.output, "alpha");
  });

  it("assigns the same id as JsonHoardBackend (content-addressed)", async () => {
    const jsonDir = await mkdtemp(join(tmpdir(), "gt-json-"));
    const jsonBackend = new JsonHoardBackend(jsonDir);
    const jsonHoard = new Hoard(jsonDir, jsonBackend);
    await jsonHoard.init();

    const sqliteId = await hoard.stash(makeLoot({ output: "x" }));
    const jsonId = await jsonHoard.stash(makeLoot({ output: "x" }));
    assert.equal(sqliteId, jsonId);

    await rm(jsonDir, { recursive: true, force: true });
  });

  it("allLoot lists every stashed Loot", async () => {
    await hoard.stash(makeLoot({ output: "a" }));
    await hoard.stash(makeLoot({ output: "b" }));
    await hoard.stash(makeLoot({ output: "c" }));
    const all = await hoard.allLoot();
    assert.equal(all.length, 3);
  });

  it("stashes and reads quests and rites", async () => {
    const quest: Quest = {
      id: "q1",
      task: "t",
      packSize: 2,
      personality: "nerdy",
      lootIds: ["a", "b"],
      trollVerdicts: {},
      startedAt: 1,
    };
    await hoard.stashQuest(quest);
    const qs = await hoard.allQuests();
    assert.equal(qs.length, 1);
    assert.equal(qs[0].id, "q1");

    const rite: Rite = {
      id: "r1",
      task: "t",
      scanGlobs: [],
      packSize: 2,
      personality: "nerdy",
      goblinLootIds: [],
      chaosLootIds: {},
      trollVerdicts: {},
      outcome: "winner",
      startedAt: 1,
    };
    await hoard.stashRite(rite);
    const r = await hoard.getRite("r1");
    assert.equal(r?.outcome, "winner");
  });
});

describe("copyHoard (json ↔ sqlite migration)", () => {
  let jsonDir: string;
  let sqliteDir: string;
  let sqliteBackend: SqliteHoardBackend;

  beforeEach(async () => {
    jsonDir = await mkdtemp(join(tmpdir(), "gt-mig-json-"));
    sqliteDir = await mkdtemp(join(tmpdir(), "gt-mig-sql-"));
    sqliteBackend = new SqliteHoardBackend(join(sqliteDir, "hoard.db"));
  });

  afterEach(async () => {
    sqliteBackend.close();
    await rm(jsonDir, { recursive: true, force: true });
    await rm(sqliteDir, { recursive: true, force: true });
  });

  it("preserves loot ids and counts across backends", async () => {
    const jsonBackend = new JsonHoardBackend(jsonDir);
    const src = new Hoard(jsonDir, jsonBackend);
    await src.init();
    const ids = [
      await src.stash(makeLoot({ output: "1" })),
      await src.stash(makeLoot({ output: "2" })),
      await src.stash(makeLoot({ output: "3" })),
    ];

    const result = await copyHoard(jsonBackend, sqliteBackend);
    assert.equal(result.loot, 3);

    const dst = new Hoard(sqliteDir, sqliteBackend);
    const all = await dst.allLoot();
    assert.deepEqual(
      all.map((l) => l.id).sort(),
      [...ids].sort(),
    );
  });
});
