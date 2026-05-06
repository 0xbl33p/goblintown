/**
 * Topological executor for a Plan. Each node becomes a sub-rite (skipScribe
 * defaults to false so each sub-rite produces its own artifact, which is then
 * fed forward to dependent nodes). On a node failure we may invoke the planner
 * again with the failure context (recursive replan, max depth 2 by default).
 */
import { planTask, topologicalOrder, validatePlan } from "./planner.js";
import { performRite, type RiteOptions, type RiteStep } from "./rite.js";
import type {
  Artifact,
  OutputFormat,
  Plan,
  PlanNode,
  Rite,
  WarrenManifest,
} from "./types.js";
import type { Hoard } from "./hoard.js";

export interface PlanExecOptions {
  plan: Plan;
  cwd: string;
  hoard: Hoard;
  rewardFn?: RiteOptions["rewardFn"];
  budgetTokens?: number;
  maxOutputTokensPerCall?: number;
  outputFormat?: OutputFormat;
  parentArtifacts?: Artifact[];
  /** Max times to recursively replan on node failure. Default 2. */
  maxReplanDepth?: number;
  /** Forwarded to each sub-rite; lets the UI/console see progress. */
  onStep?: (nodeId: string, step: RiteStep) => void;
  /** Lifecycle hooks for the plan itself. */
  onPlanEvent?: (ev: PlanExecutionEvent) => void;
}

export type PlanExecutionEvent =
  | { kind: "plan:start"; plan: Plan }
  | { kind: "plan:node:start"; nodeId: string }
  | { kind: "plan:node:done"; nodeId: string; riteId: string; artifactId?: string; outcome: Rite["outcome"] }
  | { kind: "plan:node:failed"; nodeId: string; reason: string }
  | { kind: "plan:replan"; depth: number; reason: string }
  | { kind: "plan:done"; outcome: "success" | "failed"; finalRiteId?: string; finalArtifactId?: string; finalLootId?: string };

export interface PlanExecResult {
  plan: Plan;
  finalArtifact?: Artifact;
  finalRiteId?: string;
  /** Loot id of the last node's winning loot — survives even when scribe failed. */
  finalLootId?: string;
  outcome: "success" | "failed";
}

export async function executePlan(opts: PlanExecOptions): Promise<PlanExecResult> {
  const maxDepth = opts.maxReplanDepth ?? 2;
  let plan = opts.plan;
  opts.onPlanEvent?.({ kind: "plan:start", plan });

  // Map nodeId -> Artifact produced.
  const produced = new Map<string, Artifact>();
  // Map nodeId -> winnerLootId (independent of whether scribe succeeded).
  const lootByNode = new Map<string, string>();
  const parentArtifacts = opts.parentArtifacts ?? [];

  for (let attempt = 0; attempt <= maxDepth; attempt++) {
    const v = validatePlan(plan);
    if (!v.ok) {
      opts.onPlanEvent?.({ kind: "plan:done", outcome: "failed" });
      throw new Error(`invalid plan: ${v.errors.join("; ")}`);
    }

    const order = topologicalOrder(plan);
    let failedNode: PlanNode | null = null;
    let failureReason = "";

    for (const node of order) {
      // Skip already-completed nodes if replan preserved them.
      if (node.status === "done" && node.artifactId) continue;

      // Gather parent artifacts: external priors + outputs of node.inputs.
      const inputArtifacts: Artifact[] = [...parentArtifacts];
      for (const inp of node.inputs) {
        const a = produced.get(inp);
        if (a) inputArtifacts.push(a);
      }

      node.status = "running";
      opts.onPlanEvent?.({ kind: "plan:node:start", nodeId: node.id });

      try {
        const result = await performRite({
          task: node.task,
          packSize: node.packSize ?? 3,
          scanGlobs: [],
          cwd: opts.cwd,
          hoard: opts.hoard,
          personality: node.personality,
          rewardFn: opts.rewardFn,
          budgetTokens: opts.budgetTokens,
          maxOutputTokensPerCall: opts.maxOutputTokensPerCall,
          outputFormat: opts.outputFormat,
          parentArtifacts: inputArtifacts,
          // sub-rites still produce their own artifacts (cheap scribe call)
          skipScribe: false,
          onStep: (step) => opts.onStep?.(node.id, step),
        });
        node.riteId = result.rite.id;
        node.status = "done";
        if (result.rite.winnerLootId) lootByNode.set(node.id, result.rite.winnerLootId);

        // Pull the just-written artifact back from the hoard if scribe succeeded.
        const artifact = await opts.hoard.getArtifactByRiteId(result.rite.id);
        if (artifact) {
          node.artifactId = artifact.id;
          produced.set(node.id, artifact);
        }

        opts.onPlanEvent?.({
          kind: "plan:node:done",
          nodeId: node.id,
          riteId: result.rite.id,
          artifactId: artifact?.id,
          outcome: result.rite.outcome,
        });

        // A node "fails" for the planner's purposes only if it ended in
        // all_failed. winner / specialist_recovery / ogre_fallback are all
        // acceptable resolutions.
        if (result.rite.outcome === "all_failed") {
          failedNode = node;
          failureReason = `node ${node.id} ended all_failed (no usable output)`;
          break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        node.status = "failed";
        node.failureReason = message;
        opts.onPlanEvent?.({ kind: "plan:node:failed", nodeId: node.id, reason: message });
        failedNode = node;
        failureReason = message;
        break;
      }
    }

    if (!failedNode) {
      // success
      const lastNode = order[order.length - 1];
      const finalArtifact = lastNode ? produced.get(lastNode.id) : undefined;
      const finalLootId = lastNode ? lootByNode.get(lastNode.id) : undefined;
      opts.onPlanEvent?.({
        kind: "plan:done",
        outcome: "success",
        finalRiteId: lastNode?.riteId,
        finalArtifactId: finalArtifact?.id,
        finalLootId,
      });
      return {
        plan,
        finalArtifact,
        finalRiteId: lastNode?.riteId,
        finalLootId,
        outcome: "success",
      };
    }

    // Failure path: try replan if budget allows.
    if (attempt >= maxDepth) {
      opts.onPlanEvent?.({ kind: "plan:done", outcome: "failed" });
      return { plan, outcome: "failed" };
    }

    opts.onPlanEvent?.({ kind: "plan:replan", depth: attempt + 1, reason: failureReason });

    const replanned = await planTask({
      task: plan.rootTask,
      parentArtifacts: [...parentArtifacts, ...produced.values()],
      failureContext: { failedNodeId: failedNode.id, reason: failureReason, partialPlan: plan },
      maxOutputTokens: opts.maxOutputTokensPerCall,
    });
    plan = { ...replanned.plan, replanDepth: attempt + 1 };
    // Carry forward artifacts produced so far so subsequent nodes can reuse them
    // when the new plan re-uses input ids by coincidence (best-effort).
  }

  opts.onPlanEvent?.({ kind: "plan:done", outcome: "failed" });
  return { plan, outcome: "failed" };
}

// Re-export for convenient imports.
export type { WarrenManifest };
