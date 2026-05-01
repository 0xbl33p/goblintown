import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRewardPlugin } from "../reward-plugin.js";
import type { Loot, TrollVerdict } from "../types.js";

function makeLoot(): Loot {
  return {
    id: "x",
    creatureKind: "goblin",
    personality: "nerdy",
    model: "test",
    prompt: "p",
    output: "o",
    timestamp: 0,
    drift: {
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
    },
  };
}

function makeVerdict(score = 0.5): TrollVerdict {
  return { lootId: "x", passed: false, score, critique: "" };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "goblintown-reward-"));
  await mkdir(join(dir, ".goblintown"), { recursive: true });
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("loadRewardPlugin", () => {
  it("returns the builtin shinies when no plugin is present", async () => {
    const plugin = await loadRewardPlugin(dir);
    assert.equal(plugin.source, "builtin");
    const r = plugin.fn(makeLoot(), makeVerdict(0.5));
    assert.ok(r >= 0 && r <= 1);
  });

  it("loads a reward.mjs that exports a default function", async () => {
    const path = join(dir, ".goblintown", "reward.mjs");
    await writeFile(
      path,
      `export default function(loot, verdict) { return verdict.score * 0.5; }\n`,
      "utf8",
    );
    const plugin = await loadRewardPlugin(dir);
    assert.equal(plugin.source, path);
    assert.equal(plugin.fn(makeLoot(), makeVerdict(0.6)), 0.3);
  });

  it("clamps plugin output to [0, 1]", async () => {
    const path = join(dir, ".goblintown", "reward.mjs");
    await writeFile(
      path,
      `export default function() { return 99; }\n`,
      "utf8",
    );
    const plugin = await loadRewardPlugin(dir);
    assert.equal(plugin.fn(makeLoot(), makeVerdict()), 1);
  });

  it("rejects a plugin that does not export a function", async () => {
    const path = join(dir, ".goblintown", "reward.mjs");
    await writeFile(path, `export default { not: "a function" };\n`, "utf8");
    await assert.rejects(() => loadRewardPlugin(dir), /must export a default function/);
  });

  it("returns 0 for non-numeric plugin output", async () => {
    const path = join(dir, ".goblintown", "reward.mjs");
    await writeFile(
      path,
      `export default function() { return "not a number"; }\n`,
      "utf8",
    );
    const plugin = await loadRewardPlugin(dir);
    assert.equal(plugin.fn(makeLoot(), makeVerdict()), 0);
  });
});
