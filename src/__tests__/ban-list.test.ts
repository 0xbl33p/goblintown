import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { CREATURE_KINDS, type CreatureKind } from "../types.js";

// Roster is pinned to the bestiary OpenAI's Codex was instructed to avoid.
// Changing this list is a deliberate protocol change — the test is here so
// it can't happen quietly.
const ROSTER: CreatureKind[] = [
  "goblin",
  "gremlin",
  "raccoon",
  "troll",
  "ogre",
  "pigeon",
];

describe("creature roster", () => {
  it("matches the pinned bestiary", () => {
    assert.deepEqual([...CREATURE_KINDS].sort(), [...ROSTER].sort());
  });

  it("contains exactly six creatures", () => {
    assert.equal(CREATURE_KINDS.length, 6);
  });
});
