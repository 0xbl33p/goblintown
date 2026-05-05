import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildFoldPrompt, clusterByKeywords } from "../fold.js";
import type { Artifact } from "../types.js";

const make = (id: string, keywords: string[], task = "T", over: Partial<Artifact> = {}): Artifact => ({
  id, riteId: "r-" + id, task, outcome: "winner",
  claims: [], evidence: [], openQuestions: [], nextSteps: [],
  parentArtifactIds: [], keywords, timestamp: 0,
  ...over,
});

describe("clusterByKeywords", () => {
  it("groups artifacts sharing >= minOverlap keywords", () => {
    const arts = [
      make("a", ["sql", "migration", "schema"]),
      make("b", ["sql", "migration", "rollback"]),
      make("c", ["css", "layout"]),
      make("d", ["sql", "schema", "design"]),
    ];
    const clusters = clusterByKeywords(arts, 2, 10);
    // a, b, d share sql + (migration|schema). c isolated.
    assert.equal(clusters.length, 2);
    const sizes = clusters.map((c) => c.length).sort();
    assert.deepEqual(sizes, [1, 3]);
  });

  it("respects maxClusterSize cap", () => {
    const arts = [
      make("a", ["x", "y"]),
      make("b", ["x", "y"]),
      make("c", ["x", "y"]),
      make("d", ["x", "y"]),
    ];
    const clusters = clusterByKeywords(arts, 2, 2);
    assert.equal(clusters.length, 2);
    assert.equal(clusters[0].length, 2);
    assert.equal(clusters[1].length, 2);
  });

  it("returns each artifact alone when overlap is too low", () => {
    const arts = [
      make("a", ["one"]),
      make("b", ["two"]),
      make("c", ["three"]),
    ];
    const clusters = clusterByKeywords(arts, 2, 10);
    assert.equal(clusters.length, 3);
    assert.ok(clusters.every((c) => c.length === 1));
  });

  it("preserves order: earliest artifact is the seed of its cluster", () => {
    const arts = [
      make("a", ["sql", "migration"]),
      make("b", ["css"]),
      make("c", ["sql", "migration", "schema"]),
    ];
    const clusters = clusterByKeywords(arts, 2, 10);
    const aCluster = clusters.find((c) => c.some((x) => x.id === "a"));
    assert.equal(aCluster?.[0].id, "a");
    assert.ok(aCluster?.some((x) => x.id === "c"));
  });
});

describe("buildFoldPrompt", () => {
  it("includes every artifact's task and id, plus the schema", () => {
    const group = [
      make("a", ["x"], "task one", { claims: [{ text: "claim A", confidence: "established" }] }),
      make("b", ["x"], "task two", { openQuestions: ["why?"] }),
    ];
    const out = buildFoldPrompt(group);
    assert.ok(out.includes("Fold 2"));
    assert.ok(out.includes("task one"));
    assert.ok(out.includes("task two"));
    assert.ok(out.includes("claim A"));
    assert.ok(out.includes("why?"));
    assert.ok(out.includes("claims"));
    assert.ok(out.includes("openQuestions"));
    assert.ok(out.includes("keywords"));
  });
});
