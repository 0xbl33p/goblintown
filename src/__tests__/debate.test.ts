import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildDebatePrompt } from "../debate.js";

describe("buildDebatePrompt", () => {
  it("includes the original task and the goblin's own first attempt", () => {
    const out = buildDebatePrompt({
      task: "TASK_X",
      selfIndex: 0,
      selfOutput: "FIRST_TRY",
      selfPersonality: "stoic",
      peerOutputs: [],
    });
    assert.ok(out.includes("TASK_X"));
    assert.ok(out.includes("FIRST_TRY"));
    assert.ok(out.includes("Goblin #0"));
    assert.ok(out.includes("stoic"));
  });

  it("lists peer proposals with peer index and personality", () => {
    const out = buildDebatePrompt({
      task: "T",
      selfIndex: 0,
      selfOutput: "S",
      selfPersonality: "stoic",
      peerOutputs: [
        { index: 1, personality: "feral", output: "PEER_ONE" },
        { index: 2, personality: "chipper", output: "PEER_TWO" },
      ],
    });
    assert.ok(out.includes("PEER_ONE"));
    assert.ok(out.includes("PEER_TWO"));
    assert.ok(out.includes("Peer Goblin #1"));
    assert.ok(out.includes("feral"));
    assert.ok(out.includes("Peer Goblin #2"));
    assert.ok(out.includes("chipper"));
    assert.ok(out.includes("Cross-examine"));
  });

  it("notes degeneracy when there are no peers", () => {
    const out = buildDebatePrompt({
      task: "T",
      selfIndex: 0,
      selfOutput: "S",
      selfPersonality: "nerdy",
      peerOutputs: [],
    });
    assert.ok(out.includes("degenerate"));
  });

  it("truncates very long peer outputs", () => {
    const big = "X".repeat(5000);
    const out = buildDebatePrompt({
      task: "T",
      selfIndex: 0,
      selfOutput: "S",
      selfPersonality: "stoic",
      peerOutputs: [{ index: 1, personality: "feral", output: big }],
    });
    // truncate cap is 1200, plus "…"
    const peerSection = out.split("--- Peer Goblin #1")[1];
    assert.ok(peerSection.length < 5000, "peer section was truncated");
    assert.ok(peerSection.includes("…"));
  });
});
