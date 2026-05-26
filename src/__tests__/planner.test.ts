import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildPlannerPrompt,
  hasCycle,
  parsePlanJson,
  topologicalOrder,
  validatePlan,
} from "../planner.js";
import type { Artifact, Plan } from "../types.js";

describe("buildPlannerPrompt", () => {
  it("includes the task and DAG schema", () => {
    const out = buildPlannerPrompt({ task: "ROOT_TASK_X" });
    assert.ok(out.includes("ROOT_TASK_X"));
    assert.ok(out.includes("synthesize"));
    assert.ok(out.includes("packSize"));
    assert.ok(out.includes("personality"));
    assert.ok(out.includes("nodes"));
    assert.ok(out.includes("edges"));
  });

  it("includes parent artifact summaries when provided", () => {
    const a: Artifact = {
      id: "a-1", riteId: "r-1", task: "PRIOR", outcome: "winner",
      claims: [{ text: "key claim", confidence: "established" }],
      evidence: [], openQuestions: [], nextSteps: [], parentArtifactIds: [],
      keywords: [], timestamp: 0,
    };
    const out = buildPlannerPrompt({ task: "T", parentArtifacts: [a] });
    assert.ok(out.includes("a-1"));
    assert.ok(out.includes("key claim"));
  });

  it("includes failure context for replan", () => {
    const partialPlan: Plan = {
      id: "p", rootTask: "T", nodes: [], edges: [], replanDepth: 0, createdAt: 0,
    };
    const out = buildPlannerPrompt({
      task: "T",
      failureContext: { failedNodeId: "n5", reason: "ogre fallback failed", partialPlan },
    });
    assert.ok(out.includes("n5"));
    assert.ok(out.includes("ogre fallback failed"));
    assert.ok(out.includes("revised plan"));
  });

  it("respects max-nodes cap", () => {
    const out = buildPlannerPrompt({ task: "T", maxNodes: 4 });
    assert.ok(/1-4 sub-rites/.test(out));
  });
});

describe("parsePlanJson", () => {
  it("parses a clean linear plan", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "n1", task: "scavenge", inputs: [], kind: "sub_rite", packSize: 2, personality: "stoic" },
        { id: "n2", task: "design", inputs: ["n1"], kind: "sub_rite", packSize: 3, personality: "nerdy" },
        { id: "n3", task: "synthesize", inputs: ["n2"], kind: "synthesize", packSize: 1, personality: "stoic" },
      ],
      edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }],
    });
    const plan = parsePlanJson(json, "ROOT");
    assert.equal(plan.nodes.length, 3);
    assert.equal(plan.edges.length, 2);
    assert.equal(plan.rootTask, "ROOT");
    assert.equal(plan.nodes[0].packSize, 2);
    assert.equal(plan.nodes[2].kind, "synthesize");
  });

  it("strips fences and tolerates leading prose", () => {
    const json = "Here is the plan:\n```json\n" + JSON.stringify({
      nodes: [{ id: "a", task: "do", inputs: [], kind: "sub_rite" }],
      edges: [],
    }) + "\n```";
    const plan = parsePlanJson(json, "X");
    assert.equal(plan.nodes.length, 1);
  });

  it("auto-fills edges from node.inputs when planner forgot the edges array", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", task: "first", inputs: [], kind: "sub_rite" },
        { id: "b", task: "second", inputs: ["a"], kind: "sub_rite" },
      ],
      edges: [],
    });
    const plan = parsePlanJson(json, "X");
    assert.equal(plan.edges.length, 1);
    assert.equal(plan.edges[0].from, "a");
    assert.equal(plan.edges[0].to, "b");
  });

  it("auto-fills node.inputs from edges when planner forgot inputs", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", task: "first", inputs: [], kind: "sub_rite" },
        { id: "b", task: "second", inputs: [], kind: "sub_rite" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const plan = parsePlanJson(json, "X");
    assert.deepEqual(plan.nodes[1].inputs, ["a"]);
  });

  it("drops edges that reference unknown nodes", () => {
    const json = JSON.stringify({
      nodes: [{ id: "a", task: "x", inputs: [], kind: "sub_rite" }],
      edges: [{ from: "a", to: "ghost" }],
    });
    const plan = parsePlanJson(json, "X");
    assert.equal(plan.edges.length, 0);
  });

  it("accepts goblin_mode as a valid planner personality", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "n", task: "t", inputs: [], kind: "sub_rite", packSize: 3, personality: "goblin_mode" },
      ],
      edges: [],
    });
    const plan = parsePlanJson(json, "X");
    assert.equal(plan.nodes[0].personality, "goblin_mode");
  });

  it("coerces unknown personality to undefined and clamps packSize", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "n", task: "t", inputs: [], kind: "sub_rite", packSize: 99, personality: "elven" },
      ],
      edges: [],
    });
    const plan = parsePlanJson(json, "X");
    assert.equal(plan.nodes[0].personality, undefined);
    assert.equal(plan.nodes[0].packSize, undefined, "out-of-range packSize dropped");
  });

  it("dedupes nodes by id", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", task: "first", inputs: [], kind: "sub_rite" },
        { id: "a", task: "duplicate", inputs: [], kind: "sub_rite" },
      ],
      edges: [],
    });
    const plan = parsePlanJson(json, "X");
    assert.equal(plan.nodes.length, 1);
    assert.equal(plan.nodes[0].task, "first");
  });

  it("returns an empty plan for malformed input", () => {
    const plan = parsePlanJson("totally not json", "X");
    assert.equal(plan.nodes.length, 0);
    assert.equal(plan.edges.length, 0);
  });
});

describe("validatePlan", () => {
  const make = (nodes: Plan["nodes"], edges: Plan["edges"]): Plan => ({
    id: "p", rootTask: "t", nodes, edges, replanDepth: 0, createdAt: 0,
  });
  it("flags empty plans", () => {
    const v = validatePlan(make([], []));
    assert.equal(v.ok, false);
  });
  it("flags more than one synthesize node", () => {
    const v = validatePlan(make([
      { id: "a", task: "x", inputs: [], kind: "synthesize", status: "pending" },
      { id: "b", task: "y", inputs: [], kind: "synthesize", status: "pending" },
    ], []));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("more than one synthesize")));
  });
  it("flags a synthesize node with outgoing edges", () => {
    const v = validatePlan(make(
      [
        { id: "a", task: "x", inputs: [], kind: "synthesize", status: "pending" },
        { id: "b", task: "y", inputs: ["a"], kind: "sub_rite", status: "pending" },
      ],
      [{ from: "a", to: "b" }],
    ));
    assert.equal(v.ok, false);
  });
  it("flags cycles", () => {
    const v = validatePlan(make(
      [
        { id: "a", task: "x", inputs: ["b"], kind: "sub_rite", status: "pending" },
        { id: "b", task: "y", inputs: ["a"], kind: "sub_rite", status: "pending" },
      ],
      [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    ));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("cycle")));
  });
  it("accepts a valid linear plan", () => {
    const v = validatePlan(make(
      [
        { id: "a", task: "x", inputs: [], kind: "sub_rite", status: "pending" },
        { id: "b", task: "y", inputs: ["a"], kind: "synthesize", status: "pending" },
      ],
      [{ from: "a", to: "b" }],
    ));
    assert.equal(v.ok, true, v.errors.join("; "));
  });
});

describe("topologicalOrder", () => {
  const make = (nodes: Plan["nodes"], edges: Plan["edges"]): Plan => ({
    id: "p", rootTask: "t", nodes, edges, replanDepth: 0, createdAt: 0,
  });

  it("orders a diamond DAG correctly", () => {
    const plan = make(
      [
        { id: "a", task: "1", inputs: [], kind: "sub_rite", status: "pending" },
        { id: "b", task: "2", inputs: ["a"], kind: "sub_rite", status: "pending" },
        { id: "c", task: "3", inputs: ["a"], kind: "sub_rite", status: "pending" },
        { id: "d", task: "4", inputs: ["b", "c"], kind: "synthesize", status: "pending" },
      ],
      [
        { from: "a", to: "b" }, { from: "a", to: "c" },
        { from: "b", to: "d" }, { from: "c", to: "d" },
      ],
    );
    const order = topologicalOrder(plan);
    const idx = (id: string) => order.findIndex((n) => n.id === id);
    assert.ok(idx("a") < idx("b"));
    assert.ok(idx("a") < idx("c"));
    assert.ok(idx("b") < idx("d"));
    assert.ok(idx("c") < idx("d"));
  });

  it("throws on a cyclic plan", () => {
    const plan = make(
      [
        { id: "a", task: "x", inputs: [], kind: "sub_rite", status: "pending" },
        { id: "b", task: "y", inputs: [], kind: "sub_rite", status: "pending" },
      ],
      [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    );
    assert.throws(() => topologicalOrder(plan), /cyclic/);
  });
});

describe("hasCycle", () => {
  it("detects a self-loop", () => {
    const plan: Plan = {
      id: "p", rootTask: "t", replanDepth: 0, createdAt: 0,
      nodes: [{ id: "a", task: "x", inputs: [], kind: "sub_rite", status: "pending" }],
      edges: [{ from: "a", to: "a" }],
    };
    assert.equal(hasCycle(plan), true);
  });
});
