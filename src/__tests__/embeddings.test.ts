import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  artifactRetrievalText,
  cosineSimilarity,
  mergeRanks,
  scoreEmbedded,
} from "../embeddings.js";
import type { Artifact } from "../types.js";

const make = (over: Partial<Artifact> = {}): Artifact => ({
  id: "a", riteId: "r", task: "T", outcome: "winner",
  claims: [], evidence: [], openQuestions: [], nextSteps: [],
  parentArtifactIds: [], keywords: [], timestamp: Date.now(),
  ...over,
});

describe("cosineSimilarity", () => {
  it("identical vectors → 1", () => {
    assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]).toFixed(6), "1.000000");
  });
  it("orthogonal vectors → 0", () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });
  it("opposite vectors → -1", () => {
    assert.equal(cosineSimilarity([1, 1], [-1, -1]).toFixed(6), "-1.000000");
  });
  it("returns 0 on length mismatch or empty", () => {
    assert.equal(cosineSimilarity([], []), 0);
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });
  it("returns 0 on zero vector", () => {
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  });
});

describe("scoreEmbedded", () => {
  const now = 1_700_000_000_000;
  it("returns 0 when artifact has no embedding", () => {
    assert.equal(scoreEmbedded(make({ timestamp: now }), [1, 0], now), 0);
  });
  it("higher cosine sim → higher score", () => {
    const high = scoreEmbedded(make({ embedding: [1, 0], timestamp: now }), [1, 0], now);
    const low  = scoreEmbedded(make({ embedding: [0, 1], timestamp: now }), [1, 0], now);
    assert.ok(high > low);
  });
  it("recency tilts ties (small effect)", () => {
    const fresh = scoreEmbedded(make({ embedding: [1, 0], timestamp: now }), [1, 0], now);
    const stale = scoreEmbedded(make({ embedding: [1, 0], timestamp: now - 30 * 86_400_000 }), [1, 0], now);
    assert.ok(fresh > stale);
  });
  it("clamps negative cosine to 0", () => {
    const opposite = scoreEmbedded(make({ embedding: [-1, 0], timestamp: now }), [1, 0], now);
    // negative similarity gets clamped → only the recency component survives
    assert.ok(opposite >= 0);
    assert.ok(opposite < 0.2);
  });
});

describe("mergeRanks (reciprocal rank fusion)", () => {
  it("ranks an item that appears top in both lists above one that appears in only one", () => {
    const top = mergeRanks([
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [{ id: "a" }, { id: "x" }, { id: "y" }],
    ]);
    assert.equal(top[0], "a");
  });
  it("handles disjoint lists", () => {
    const out = mergeRanks([[{ id: "a" }], [{ id: "b" }]]);
    assert.deepEqual(new Set(out), new Set(["a", "b"]));
  });
  it("returns empty for empty input", () => {
    assert.deepEqual(mergeRanks([]), []);
  });
  it("higher k flattens differences", () => {
    const high_k = mergeRanks([
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [{ id: "c" }, { id: "b" }, { id: "a" }],
    ], 1000);
    // With huge k the contribution of position differences shrinks; expect all ids present.
    assert.equal(new Set(high_k).size, 3);
  });
});

describe("artifactRetrievalText", () => {
  it("joins task, claims, and open questions", () => {
    const a = make({
      task: "the task",
      claims: [{ text: "claim one", confidence: "established" }],
      openQuestions: ["q1"],
    });
    const out = artifactRetrievalText(a);
    assert.ok(out.includes("the task"));
    assert.ok(out.includes("claim one"));
    assert.ok(out.includes("q1"));
  });
});
