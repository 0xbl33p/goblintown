import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { crossCreatureDrift, measureDrift } from "../drift.js";

describe("measureDrift", () => {
  it("returns a zeroed report for empty input", () => {
    const r = measureDrift("");
    assert.equal(r.totalCreatureWords, 0);
    assert.equal(r.outputWordCount, 0);
    assert.equal(r.driftRate, 0);
    for (const k of Object.keys(r.creatureMentions)) {
      assert.equal(r.creatureMentions[k as keyof typeof r.creatureMentions], 0);
    }
  });

  it("counts singular and plural creature mentions with word boundaries", () => {
    const r = measureDrift(
      "the goblin met two goblins and a Troll, but ignored the trolling reply.",
    );
    assert.equal(r.creatureMentions.goblin, 2, "goblin + goblins = 2");
    assert.equal(r.creatureMentions.troll, 1, "trolling should NOT match troll");
    assert.equal(r.totalCreatureWords, 3);
    assert.ok(r.driftRate > 0);
  });

  it("does not double-count overlapping creature roots", () => {
    const r = measureDrift("Pigeons and pigeon. ogre. ogres.");
    assert.equal(r.creatureMentions.pigeon, 2);
    assert.equal(r.creatureMentions.ogre, 2);
  });

  it("treats unrelated text as zero drift", () => {
    const r = measureDrift("the quick brown fox jumps over the lazy dog");
    assert.equal(r.totalCreatureWords, 0);
    assert.equal(r.driftRate, 0);
  });
});

describe("crossCreatureDrift", () => {
  it("excludes self-mentions when computing cross-creature drift", () => {
    const text = "goblin goblin goblin raccoon";
    const cross = crossCreatureDrift(text, "goblin");
    // 1 cross word (raccoon) over 4 total words = 0.25
    assert.equal(cross, 0.25);
  });

  it("returns 0 when only self-mentions are present", () => {
    const text = "troll troll trolls";
    assert.equal(crossCreatureDrift(text, "troll"), 0);
  });

  it("returns 0 for empty input", () => {
    assert.equal(crossCreatureDrift("", "goblin"), 0);
  });
});
