import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { exportRunAsMasTrace } from "../trace-export.js";
import type { RunRecord } from "../run-store.js";

const baseRun = (over: Partial<RunRecord> = {}): RunRecord => ({
  runId: "run-abc12345",
  task: "do something useful",
  packSize: 3,
  scanGlobs: [],
  events: [],
  done: true,
  startedAt: 1_000_000,
  finishedAt: 1_005_000,
  ...over,
});

const step = (data: unknown, seq: number) => ({ seq, kind: "step" as const, data });

describe("exportRunAsMasTrace", () => {
  it("emits a valid trace skeleton even for an empty run", () => {
    const t = exportRunAsMasTrace(baseRun());
    assert.equal(t.trace_id, "run-abc12345");
    assert.equal(t.topology, "centralized");
    assert.equal(t.events.length, 1, "starts with orchestrator_decision");
    assert.equal(t.events[0].type, "orchestrator_decision");
    assert.equal(t.events[0].agent, "orchestrator");
    assert.ok(t.costs.wall_clock_s >= 0);
  });

  it("maps scavenge:start/done to spawn + return for raccoon", () => {
    const t = exportRunAsMasTrace(baseRun({
      events: [
        step({ kind: "scavenge:start", globs: ["src/**/*.ts"] }, 0),
        step({ kind: "scavenge:done", lootId: "loot-r", fileCount: 7 }, 1),
      ],
    }));
    const types = t.events.map((e) => e.type);
    assert.ok(types.includes("spawn"));
    assert.ok(types.includes("return"));
    const ret = t.events.find((e) => e.type === "return");
    assert.equal(ret?.agent, "raccoon");
    assert.equal(ret?.content_ref, "loot-r");
  });

  it("maps pack:start to one orchestrator_decision + N spawns", () => {
    const t = exportRunAsMasTrace(baseRun({
      events: [
        step({ kind: "pack:start", size: 3 }, 0),
      ],
    }));
    const decisions = t.events.filter((e) => e.type === "orchestrator_decision");
    const spawns = t.events.filter((e) => e.type === "spawn" && typeof e.agent === "string" && e.agent.startsWith("goblin#"));
    assert.equal(decisions.length, 2, "initial + dispatch_pack");
    assert.equal(spawns.length, 3);
    assert.deepEqual(spawns.map((s) => s.agent), ["goblin#0", "goblin#1", "goblin#2"]);
  });

  it("links pack:goblin returns to their spawn events via causal edge", () => {
    const t = exportRunAsMasTrace(baseRun({
      events: [
        step({ kind: "pack:start", size: 2 }, 0),
        step({ kind: "pack:goblin", lootId: "g0", index: 0, personality: "nerdy" }, 1),
        step({ kind: "pack:goblin", lootId: "g1", index: 1, personality: "feral" }, 2),
      ],
    }));
    const returnEdges = t.edges.filter((e) => e.type === "return");
    assert.equal(returnEdges.length, 2);
  });

  it("maps chaos:done to a message edge from gremlin to goblin", () => {
    const t = exportRunAsMasTrace(baseRun({
      events: [
        step({ kind: "pack:start", size: 1 }, 0),
        step({ kind: "pack:goblin", lootId: "g0", index: 0 }, 1),
        step({ kind: "chaos:start" }, 2),
        step({ kind: "chaos:done", goblinId: "g0", gremlinId: "gr0" }, 3),
      ],
    }));
    const msg = t.events.find((e) => e.type === "message" && e.agent === "gremlin");
    assert.ok(msg);
    assert.equal(msg!.to, "goblin#0");
    assert.equal(msg!.content_ref, "gr0");
  });

  it("maps review:verdict to aggregate events with passed/score", () => {
    const t = exportRunAsMasTrace(baseRun({
      events: [
        step({ kind: "review:start" }, 0),
        step({ kind: "review:verdict", verdict: { lootId: "g0", passed: true, score: 0.8, critique: "ok" } }, 1),
      ],
    }));
    const agg = t.events.find((e) => e.type === "aggregate");
    assert.ok(agg);
    assert.equal(agg!.passed, true);
    assert.equal(agg!.score, 0.8);
  });

  it("classifies topology as 'mixed' when specialists were spawned", () => {
    const t = exportRunAsMasTrace(baseRun({
      events: [
        step({ kind: "specialist:spawn", index: 0, focus: "fix x" }, 0),
        step({ kind: "specialist:done", lootId: "s0", index: 0 }, 1),
      ],
    }));
    assert.equal(t.topology, "mixed");
    assert.ok(t.events.some((e) => e.agent === "specialist#0"));
  });

  it("maps budget:exceeded and scribe:error to safety_event", () => {
    const t = exportRunAsMasTrace(baseRun({
      events: [
        step({ kind: "budget:exceeded", used: 100, cap: 50, phase: "scavenge" }, 0),
        step({ kind: "scribe:error", message: "kaboom" }, 1),
      ],
    }));
    const safety = t.events.filter((e) => e.type === "safety_event");
    assert.equal(safety.length, 2);
  });

  it("ignores 'thinking' deltas (they are below trace abstraction)", () => {
    const t = exportRunAsMasTrace(baseRun({
      events: [
        step({ kind: "thinking", slot: "ogre", text: "partial..." }, 0),
        step({ kind: "thinking", slot: "ogre", text: "partial..." }, 1),
      ],
    }));
    // Only the orchestrator_decision boot event remains.
    assert.equal(t.events.length, 1);
  });

  it("classifies topology as 'planner_executor_critic' when plan events exist", () => {
    const t = exportRunAsMasTrace(baseRun({
      events: [
        { seq: 0, kind: "plan:planning", data: {} },
        { seq: 1, kind: "plan:built", data: { plan: { nodes: [{ id: "n1" }] } } },
      ],
    }));
    assert.equal(t.topology, "planner_executor_critic");
    const decisions = t.events.filter((e) => e.type === "orchestrator_decision" && e.agent === "planner");
    assert.ok(decisions.length >= 2, "planner orchestrator_decision events present");
  });

  it("unwraps plan-mode { nodeId, step } envelopes for sub-rite steps", () => {
    const t = exportRunAsMasTrace(baseRun({
      events: [
        { seq: 0, kind: "plan:built", data: { plan: { nodes: [{ id: "n1" }] } } },
        { seq: 1, kind: "plan:node:start", data: { nodeId: "n1" } },
        { seq: 2, kind: "step", data: { nodeId: "n1", step: { kind: "scavenge:start", globs: ["src/**"] } } },
        { seq: 3, kind: "step", data: { nodeId: "n1", step: { kind: "scavenge:done", lootId: "L", fileCount: 3 } } },
        { seq: 4, kind: "plan:node:done", data: { nodeId: "n1", outcome: "winner", riteId: "R", artifactId: "A" } },
      ],
    }));
    // Expect raccoon spawn + return events to be present even though they're plan-wrapped.
    assert.ok(t.events.some((e) => e.type === "spawn" && e.agent === "raccoon"));
    assert.ok(t.events.some((e) => e.type === "return" && e.agent === "raccoon"));
  });

  it("maps plan:replan to an orchestrator_decision with reason", () => {
    const t = exportRunAsMasTrace(baseRun({
      events: [
        { seq: 0, kind: "plan:replan", data: { depth: 1, reason: "node n3 failed" } },
      ],
    }));
    const ev = t.events.find((e) => e.agent === "planner" && e.decision === "replan");
    assert.ok(ev);
    assert.equal(ev!.depth, 1);
    assert.equal(ev!.reason, "node n3 failed");
  });

  it("every non-first event has an incoming temporal edge", () => {
    const t = exportRunAsMasTrace(baseRun({
      events: [
        step({ kind: "scavenge:start", globs: [] }, 0),
        step({ kind: "scavenge:done", lootId: "x", fileCount: 1 }, 1),
        step({ kind: "rite:done", outcome: "winner" }, 2),
      ],
    }));
    const ids = new Set(t.events.map((e) => e.id));
    const hasIncoming = new Set<string>();
    for (const e of t.edges) if (e.type === "temporal" && ids.has(e.dst)) hasIncoming.add(e.dst);
    for (const ev of t.events.slice(1)) {
      assert.ok(hasIncoming.has(ev.id), `event ${ev.id} missing temporal predecessor`);
    }
  });
});
