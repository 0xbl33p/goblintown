/**
 * Export a Goblintown rite as an LLM-MAS Orchestration Trace
 * (https://github.com/xxzcc/awesome-llm-mas-rl/blob/main/trace-schema/trace_schema.json).
 *
 * Maps Goblintown SSE step events onto the academic schema's 10 event types:
 *   orchestrator_decision, spawn, despawn, message, tool_call, tool_result,
 *   return, aggregate, human_intervention, safety_event
 *
 * And the 8 edge types:
 *   temporal, causal, spawn, message, tool_dependency, return, aggregate,
 *   safety_flow
 */
import type { RunRecord } from "./run-store.js";
import type { RiteStep } from "./rite.js";

export type MasEventType =
  | "orchestrator_decision"
  | "spawn"
  | "despawn"
  | "message"
  | "tool_call"
  | "tool_result"
  | "return"
  | "aggregate"
  | "human_intervention"
  | "safety_event";

export type MasEdgeType =
  | "temporal"
  | "causal"
  | "spawn"
  | "message"
  | "tool_dependency"
  | "return"
  | "aggregate"
  | "safety_flow";

export interface MasEvent {
  id: string;
  t: number;
  type: MasEventType;
  agent: string;
  role?: string;
  from?: string;
  to?: string;
  tool?: string;
  content_ref?: string;
  trusted?: boolean;
  [extra: string]: unknown;
}

export interface MasEdge {
  src: string;
  dst: string;
  type: MasEdgeType;
}

export interface MasTrace {
  trace_id: string;
  task_id: string;
  system?: string;
  topology:
    | "centralized"
    | "planner_executor_critic"
    | "debate"
    | "swarm"
    | "hierarchical"
    | "harness"
    | "mixed"
    | "unknown";
  events: MasEvent[];
  edges: MasEdge[];
  rewards: Record<string, number>;
  costs: { tokens: number; wall_clock_s: number; tool_calls?: number; messages?: number };
  metrics?: Record<string, number>;
}

/**
 * Convert a goblintown RunRecord into the academic LLM-MAS trace schema.
 * Pure function: deterministic given the same input.
 */
export function exportRunAsMasTrace(run: RunRecord, system = "goblintown"): MasTrace {
  const events: MasEvent[] = [];
  const edges: MasEdge[] = [];
  const goblinIdByIndex = new Map<number, string>();
  const goblinAgentByLootId = new Map<string, string>();
  const specialistAgentByIndex = new Map<number, string>();
  let totalTokens = 0;
  let prevEventId: string | null = null;
  let raccoonEventId: string | null = null;
  let trollEventId: string | null = null;
  let lastClusterEventId: string | null = null;

  // Initial orchestrator_decision: starting the rite.
  pushEvent({
    id: "ev-0000",
    t: 0,
    type: "orchestrator_decision",
    agent: "orchestrator",
    role: "rite-controller",
    decision: "start_rite",
    task: run.task,
    pack_size: run.packSize,
  });

  let n = 1;
  const startedAt = run.startedAt;
  const evId = (): string => `ev-${String(n++).padStart(4, "0")}`;
  const tOf = (): number => {
    // events are stored in order but without timestamps; approximate with sequence offset.
    return Math.max(0, n - 1);
  };

  function pushEvent(ev: MasEvent): void {
    events.push(ev);
    if (prevEventId) edges.push({ src: prevEventId, dst: ev.id, type: "temporal" });
    prevEventId = ev.id;
  }

  function pushCausal(srcId: string, dstId: string, type: MasEdgeType = "causal"): void {
    edges.push({ src: srcId, dst: dstId, type });
  }

  for (const wrap of run.events ?? []) {
    // Plan-level events come through as their own kind, not as "step".
    if (wrap.kind === "plan:planning") {
      const id = evId();
      pushEvent({
        id, t: tOf(), type: "orchestrator_decision", agent: "planner",
        decision: "begin_planning",
      });
      continue;
    }
    if (wrap.kind === "plan:built") {
      const id = evId();
      const data = wrap.data as { plan?: { nodes?: unknown[] } };
      pushEvent({
        id, t: tOf(), type: "orchestrator_decision", agent: "planner",
        decision: "plan_built",
        node_count: data.plan?.nodes?.length ?? 0,
      });
      continue;
    }
    if (wrap.kind === "plan:node:start") {
      const id = evId();
      const data = wrap.data as { nodeId?: string };
      pushEvent({
        id, t: tOf(), type: "spawn", agent: `node:${data.nodeId ?? "?"}`,
        role: "sub-rite",
      });
      continue;
    }
    if (wrap.kind === "plan:node:done") {
      const id = evId();
      const data = wrap.data as { nodeId?: string; outcome?: string; riteId?: string; artifactId?: string };
      pushEvent({
        id, t: tOf(), type: "return", agent: `node:${data.nodeId ?? "?"}`,
        outcome: data.outcome,
        rite_id: data.riteId,
        content_ref: data.artifactId,
      });
      continue;
    }
    if (wrap.kind === "plan:node:failed") {
      const id = evId();
      const data = wrap.data as { nodeId?: string; reason?: string };
      pushEvent({
        id, t: tOf(), type: "safety_event", agent: `node:${data.nodeId ?? "?"}`,
        severity: "warning", message: data.reason,
      });
      continue;
    }
    if (wrap.kind === "plan:replan") {
      const id = evId();
      const data = wrap.data as { depth?: number; reason?: string };
      pushEvent({
        id, t: tOf(), type: "orchestrator_decision", agent: "planner",
        decision: "replan", depth: data.depth, reason: data.reason,
      });
      continue;
    }
    if (wrap.kind === "plan:done") {
      const id = evId();
      const data = wrap.data as { outcome?: string };
      pushEvent({
        id, t: tOf(), type: "orchestrator_decision", agent: "planner",
        decision: "stop_plan", outcome: data.outcome,
      });
      continue;
    }
    if (wrap.kind !== "step") continue;
    // Plan-mode runs wrap each sub-rite step as { nodeId, step }; unwrap.
    const raw = wrap.data as RiteStep | { nodeId: string; step: RiteStep };
    const step = (raw as { step?: RiteStep }).step
      ? (raw as { nodeId: string; step: RiteStep }).step
      : (raw as RiteStep);
    switch (step.kind) {
      case "scavenge:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "spawn", agent: "raccoon", role: "scavenger",
          globs: step.globs,
        });
        raccoonEventId = id;
        edges.push({ src: "ev-0000", dst: id, type: "spawn" });
        break;
      }
      case "scavenge:done": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "return", agent: "raccoon",
          content_ref: step.lootId, file_count: step.fileCount,
        });
        if (raccoonEventId) pushCausal(raccoonEventId, id, "return");
        break;
      }
      case "artifacts:loaded": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "message", agent: "orchestrator", to: "raccoon",
          message_kind: "memory_load",
          artifact_ids: step.artifactIds,
        });
        break;
      }
      case "pack:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "orchestrator_decision", agent: "orchestrator",
          decision: "dispatch_pack", pack_size: step.size,
        });
        for (let i = 0; i < step.size; i++) {
          const sid = evId();
          const agent = `goblin#${i}`;
          goblinIdByIndex.set(i, sid);
          pushEvent({
            id: sid, t: tOf(), type: "spawn", agent, role: "worker",
            parent_decision: id,
          });
          edges.push({ src: id, dst: sid, type: "spawn" });
        }
        break;
      }
      case "pack:goblin": {
        const id = evId();
        const agent = `goblin#${step.index}`;
        goblinAgentByLootId.set(step.lootId, agent);
        pushEvent({
          id, t: tOf(), type: "return", agent,
          content_ref: step.lootId, personality: step.personality,
        });
        const spawnId = goblinIdByIndex.get(step.index);
        if (spawnId) pushCausal(spawnId, id, "return");
        break;
      }
      case "chaos:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "spawn", agent: "gremlin", role: "adversary",
        });
        break;
      }
      case "chaos:done": {
        const id = evId();
        const targetAgent = goblinAgentByLootId.get(step.goblinId) ?? "goblin#?";
        pushEvent({
          id, t: tOf(), type: "message", agent: "gremlin",
          to: targetAgent, message_kind: "attack",
          content_ref: step.gremlinId,
        });
        break;
      }
      case "review:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "spawn", agent: "troll", role: "critic",
        });
        trollEventId = id;
        break;
      }
      case "review:verdict": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "aggregate", agent: "troll",
          content_ref: step.verdict.lootId,
          passed: step.verdict.passed,
          score: step.verdict.score,
        });
        if (trollEventId) pushCausal(trollEventId, id, "aggregate");
        const goblinAgent = goblinAgentByLootId.get(step.verdict.lootId);
        if (goblinAgent) {
          edges.push({ src: goblinAgent, dst: id, type: "aggregate" });
        }
        break;
      }
      case "specialist:cluster:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "orchestrator_decision", agent: "orchestrator",
          decision: "cluster_failures",
        });
        lastClusterEventId = id;
        break;
      }
      case "specialist:cluster:done": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "tool_result", agent: "orchestrator",
          tool: "failure_clustering", clusters: step.clusters,
        });
        if (lastClusterEventId) pushCausal(lastClusterEventId, id, "tool_dependency");
        break;
      }
      case "specialist:spawn": {
        const id = evId();
        const agent = `specialist#${step.index}`;
        specialistAgentByIndex.set(step.index, agent);
        pushEvent({
          id, t: tOf(), type: "spawn", agent, role: "specialist-worker",
          focus: step.focus,
        });
        break;
      }
      case "specialist:done": {
        const id = evId();
        const agent = specialistAgentByIndex.get(step.index) ?? `specialist#${step.index}`;
        pushEvent({
          id, t: tOf(), type: "return", agent,
          content_ref: step.lootId,
        });
        break;
      }
      case "specialist:verdict": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "aggregate", agent: "troll",
          content_ref: step.verdict.lootId,
          passed: step.verdict.passed,
          score: step.verdict.score,
          phase: "specialist_review",
        });
        break;
      }
      case "fallback:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "spawn", agent: "ogre", role: "heavyweight-fallback",
        });
        break;
      }
      case "fallback:done": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "return", agent: "ogre",
          content_ref: step.lootId,
        });
        break;
      }
      case "scribe:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "spawn", agent: "pigeon-scribe", role: "memory-distiller",
        });
        break;
      }
      case "scribe:done": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "return", agent: "pigeon-scribe",
          content_ref: step.artifactId,
        });
        break;
      }
      case "scribe:error": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "safety_event", agent: "pigeon-scribe",
          severity: "warning", message: step.message,
        });
        break;
      }
      case "thinking": {
        // Streaming intermediate output — ignored for trace export to keep it compact.
        // (The schema treats per-token deltas as below the trace abstraction.)
        break;
      }
      case "budget:exceeded": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "safety_event", agent: "orchestrator",
          severity: "warning", phase: step.phase, used: step.used, cap: step.cap,
        });
        break;
      }
      case "rite:done": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "orchestrator_decision", agent: "orchestrator",
          decision: "stop_rite", outcome: step.outcome,
        });
        break;
      }
    }
  }

  const wallClockS = run.finishedAt
    ? Math.max(0, (run.finishedAt - startedAt) / 1000)
    : 0;

  // Map outcome to a topology classification: rites with a planner subtree
  // count as planner_executor_critic; specialist recovery alone = mixed;
  // baseline = centralized.
  const hasPlanner = events.some(
    (e) => e.agent === "planner" || (typeof e.agent === "string" && e.agent.startsWith("node:")),
  );
  const hasSpecialist = events.some(
    (e) => typeof e.agent === "string" && e.agent.startsWith("specialist#"),
  );
  const topology: MasTrace["topology"] = hasPlanner
    ? "planner_executor_critic"
    : hasSpecialist
      ? "mixed"
      : "centralized";

  return {
    trace_id: run.runId,
    task_id: run.finalRiteId ?? run.runId,
    system,
    topology,
    events,
    edges,
    rewards: {},
    costs: {
      tokens: totalTokens,
      wall_clock_s: wallClockS,
      messages: events.filter((e) => e.type === "message").length,
    },
    metrics: {
      pack_size: run.packSize,
    },
  };
}
