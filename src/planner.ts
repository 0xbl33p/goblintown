/**
 * Planner — turns a complex task into a DAG of sub-rites.
 *
 * The Planner is itself an LLM call (uses the troll model — terse, structured,
 * adversarial about scope). It outputs a Plan (DAG of PlanNodes). Each node
 * becomes a sub-rite. The DAG is topologically executed, with each node's
 * artifact fed forward to dependent nodes. On a node failure, the planner
 * may be re-invoked with the failure context (recursive replan, max depth 2).
 *
 * Pure-function exports (buildPlannerPrompt, parsePlanJson, validatePlan,
 * topologicalOrder) are testable without LLM calls.
 */
import { randomUUID } from "node:crypto";
import { makeTroll } from "./creatures.js";
import { extractFirstJsonObject } from "./json-extract.js";
import { callCreature } from "./openai-client.js";
import type {
  Artifact,
  Personality,
  Plan,
  PlanEdge,
  PlanNode,
} from "./types.js";

const ALLOWED_PERSONALITIES: Personality[] = ["nerdy", "cynical", "chipper", "stoic", "feral", "goblin_mode"];

export function buildPlannerPrompt(opts: {
  task: string;
  parentArtifacts?: Artifact[];
  failureContext?: { failedNodeId: string; reason: string; partialPlan: Plan };
  maxNodes?: number;
}): string {
  const lines: string[] = [];
  lines.push(`Root task:`);
  lines.push(opts.task);
  lines.push("");

  if (opts.parentArtifacts && opts.parentArtifacts.length > 0) {
    lines.push(`Prior artifacts you may build on:`);
    for (const a of opts.parentArtifacts) {
      lines.push(`- artifact ${a.id} (rite ${a.riteId}): ${a.task.slice(0, 120)}`);
      for (const c of a.claims.slice(0, 3)) {
        lines.push(`    · ${c.text}`);
      }
    }
    lines.push("");
  }

  if (opts.failureContext) {
    lines.push(`A previous plan failed at node ${opts.failureContext.failedNodeId}.`);
    lines.push(`Failure reason: ${opts.failureContext.reason}`);
    lines.push(`Partial plan (preserve completed nodes when possible):`);
    lines.push(JSON.stringify(opts.failureContext.partialPlan, null, 2).slice(0, 1500));
    lines.push("");
    lines.push(`Emit a revised plan that avoids the failure mode.`);
    lines.push("");
  }

  const cap = Math.max(2, Math.min(opts.maxNodes ?? 6, 10));
  lines.push(
    `Decompose this task into a directed acyclic graph of 1-${cap} sub-rites. ` +
      `Each node is a sub-rite with a clear, narrow task. Final node must be of kind "synthesize". ` +
      `If the task is genuinely simple, emit a single node with kind="sub_rite" and no synthesize node.`,
  );
  lines.push(`For each node, also suggest a packSize (1-5) and lead personality from: nerdy|cynical|chipper|stoic|feral|goblin_mode.`);
  lines.push("");
  lines.push(`Output strict JSON only (no fences, no prose):`);
  lines.push(`{`);
  lines.push(`  "nodes": [`);
  lines.push(`    {`);
  lines.push(`      "id": "n1",`);
  lines.push(`      "task": "concrete sub-task description",`);
  lines.push(`      "inputs": [],`);
  lines.push(`      "kind": "sub_rite",`);
  lines.push(`      "packSize": 3,`);
  lines.push(`      "personality": "stoic"`);
  lines.push(`    }`);
  lines.push(`  ],`);
  lines.push(`  "edges": [{ "from": "n1", "to": "n2" }]`);
  lines.push(`}`);
  return lines.join("\n");
}

export function parsePlanJson(raw: string, rootTask: string): Plan {
  const json = extractFirstJsonObject(raw);
  let parsed: Record<string, unknown> = {};
  if (json) {
    try { parsed = JSON.parse(json) as Record<string, unknown>; } catch { parsed = {}; }
  }

  const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const nodes: PlanNode[] = [];
  const seenIds = new Set<string>();
  for (const n of rawNodes) {
    if (!n || typeof n !== "object") continue;
    const obj = n as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    const task = typeof obj.task === "string" ? obj.task.trim() : "";
    if (!id || !task || seenIds.has(id)) continue;
    seenIds.add(id);
    const inputs = Array.isArray(obj.inputs)
      ? (obj.inputs as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
      : [];
    const kindRaw = obj.kind;
    const kind: PlanNode["kind"] = kindRaw === "synthesize" ? "synthesize" : "sub_rite";
    const packSizeRaw = Number(obj.packSize);
    const packSize = Number.isFinite(packSizeRaw) && packSizeRaw >= 1 && packSizeRaw <= 5
      ? Math.floor(packSizeRaw)
      : undefined;
    const personality = ALLOWED_PERSONALITIES.includes(obj.personality as Personality)
      ? (obj.personality as Personality)
      : undefined;
    nodes.push({
      id, task, inputs, kind, packSize, personality,
      status: "pending",
    });
  }

  const rawEdges = Array.isArray(parsed.edges) ? parsed.edges : [];
  const edges: PlanEdge[] = [];
  for (const e of rawEdges) {
    if (!e || typeof e !== "object") continue;
    const obj = e as Record<string, unknown>;
    const from = typeof obj.from === "string" ? obj.from : "";
    const to = typeof obj.to === "string" ? obj.to : "";
    if (!from || !to || from === to) continue;
    if (!seenIds.has(from) || !seenIds.has(to)) continue;
    edges.push({ from, to });
  }

  // Reconcile node.inputs with edges: any node.input should also be an edge.
  // (some planners only emit inputs and forget edges; or vice versa.)
  for (const node of nodes) {
    for (const inp of node.inputs) {
      if (!edges.some((e) => e.from === inp && e.to === node.id)) {
        if (seenIds.has(inp)) edges.push({ from: inp, to: node.id });
      }
    }
  }
  // And ensure inputs reflect edges.
  for (const node of nodes) {
    const incoming = edges.filter((e) => e.to === node.id).map((e) => e.from);
    const merged = Array.from(new Set([...node.inputs, ...incoming]));
    node.inputs = merged.filter((id) => seenIds.has(id));
  }

  return {
    id: "plan-" + randomUUID().slice(0, 8),
    rootTask,
    nodes,
    edges,
    replanDepth: 0,
    createdAt: Date.now(),
  };
}

/**
 * Validate the plan: detect cycles, ensure edges point at existing nodes,
 * ensure at most one synthesize node and (if present) that it's a sink.
 * Returns { ok, errors }.
 */
export function validatePlan(plan: Plan): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set(plan.nodes.map((n) => n.id));

  if (plan.nodes.length === 0) errors.push("plan has no nodes");
  for (const e of plan.edges) {
    if (!ids.has(e.from)) errors.push(`edge references unknown node: ${e.from}`);
    if (!ids.has(e.to)) errors.push(`edge references unknown node: ${e.to}`);
  }
  const synthesize = plan.nodes.filter((n) => n.kind === "synthesize");
  if (synthesize.length > 1) errors.push("more than one synthesize node");
  for (const s of synthesize) {
    const outgoing = plan.edges.filter((e) => e.from === s.id);
    if (outgoing.length > 0) errors.push(`synthesize node ${s.id} has outgoing edges`);
  }
  if (hasCycle(plan)) errors.push("plan contains a cycle");

  return { ok: errors.length === 0, errors };
}

export function hasCycle(plan: Plan): boolean {
  const adj = new Map<string, string[]>();
  for (const n of plan.nodes) adj.set(n.id, []);
  for (const e of plan.edges) adj.get(e.from)?.push(e.to);

  const VISITING = 1, VISITED = 2;
  const state = new Map<string, number>();

  function dfs(u: string): boolean {
    if (state.get(u) === VISITED) return false;
    if (state.get(u) === VISITING) return true;
    state.set(u, VISITING);
    for (const v of adj.get(u) ?? []) if (dfs(v)) return true;
    state.set(u, VISITED);
    return false;
  }
  for (const n of plan.nodes) if (dfs(n.id)) return true;
  return false;
}

/**
 * Kahn's algorithm. Returns nodes in a valid topological order.
 * Throws if the plan contains a cycle.
 */
export function topologicalOrder(plan: Plan): PlanNode[] {
  if (hasCycle(plan)) throw new Error("cannot topo-sort a cyclic plan");

  const indeg = new Map<string, number>();
  for (const n of plan.nodes) indeg.set(n.id, 0);
  for (const e of plan.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);

  const ready: string[] = [];
  for (const n of plan.nodes) if ((indeg.get(n.id) ?? 0) === 0) ready.push(n.id);

  const out: PlanNode[] = [];
  const byId = new Map(plan.nodes.map((n) => [n.id, n] as const));
  while (ready.length > 0) {
    const id = ready.shift()!;
    const node = byId.get(id);
    if (node) out.push(node);
    for (const e of plan.edges.filter((x) => x.from === id)) {
      const next = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, next);
      if (next === 0) ready.push(e.to);
    }
  }
  return out;
}

/** Run the Planner LLM call. */
export async function planTask(opts: {
  task: string;
  parentArtifacts?: Artifact[];
  failureContext?: Parameters<typeof buildPlannerPrompt>[0]["failureContext"];
  maxNodes?: number;
  maxOutputTokens?: number;
}): Promise<{ plan: Plan; usage: { totalTokens: number } | undefined }> {
  const planner = makeTroll();
  const userPrompt = buildPlannerPrompt(opts);
  const { text, usage } = await callCreature(
    {
      ...planner,
      systemPrompt:
        `You are a Planner inside the Goblintown protocol. ` +
        `You decompose a complex task into a DAG of small, narrow sub-rites. ` +
        `Be conservative — fewer nodes is better. ` +
        `Output strict JSON only, no fences, no prose.`,
    },
    userPrompt,
    { maxOutputTokens: opts.maxOutputTokens ?? 1500 },
  );
  const plan = parsePlanJson(text, opts.task);
  return { plan, usage: usage ? { totalTokens: usage.totalTokens } : undefined };
}
