import { randomUUID } from "node:crypto";
import { renderArtifactContext, scribe } from "./artifact.js";
import { Budget, BudgetExceededError } from "./budget.js";
import { makeGoblin } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { callCreature, callCreatureStream } from "./openai-client.js";
import { shinies } from "./reward.js";
import { scavenge } from "./scavenge.js";
import { chaosPass } from "./chaos.js";
import { packVariant } from "./pack-prompt.js";
import { trollReview } from "./troll-review.js";
import { ogreFallback } from "./fallback.js";
import { clusterFailures, pickSeedLoot, runSpecialistRerite } from "./specialist.js";
import { runDebateRound } from "./debate.js";
import { makeThinkingRelay } from "./streaming.js";
import type {
  Artifact,
  Loot,
  OutputFormat,
  Personality,
  Rite,
  TrollVerdict,
} from "./types.js";
import type { Hoard } from "./hoard.js";
import type { RewardFn } from "./reward-plugin.js";

export interface RiteOptions {
  task: string;
  packSize: number;
  scanGlobs?: string[];
  cwd: string;
  hoard: Hoard;
  personality?: Personality;
  rewardFn?: RewardFn;
  noFallback?: boolean;
  budgetTokens?: number;
  maxOutputTokensPerCall?: number;
  onStep?: (step: RiteStep) => void;
  /** Prior artifacts to load as context (Phase 1 memory). */
  parentArtifacts?: Artifact[];
  /** Skip writing the post-rite Artifact (used by sub-rites under a planner). */
  skipScribe?: boolean;
  /** Skip the failure-driven specialist re-rite (Phase 2 recovery). Default false. */
  noSpecialist?: boolean;
  /** Max number of specialist clusters to spawn. Default 3. */
  specialistCap?: number;
  /** Phase 4: run an inter-agent debate round after the initial pack. Default false (opt-in). */
  debate?: boolean;
  /** Phase 5: enable verifier tool-use during troll review. */
  trollTools?: boolean;
  /** Optional formatting constraint for answer-producing calls. */
  outputFormat?: OutputFormat;
}

export type RiteStep =
  | { kind: "scavenge:start"; globs: string[] }
  | { kind: "scavenge:done"; lootId: string; fileCount: number }
  | { kind: "artifacts:loaded"; count: number; artifactIds: string[] }
  | { kind: "pack:start"; size: number }
  | { kind: "pack:goblin"; lootId: string; index: number; personality?: Personality }
  | { kind: "debate:start"; round: number; size: number }
  | { kind: "debate:goblin"; lootId: string; index: number; round: number }
  | { kind: "debate:done"; round: number }
  | { kind: "chaos:start" }
  | { kind: "chaos:done"; goblinId: string; gremlinId: string }
  | { kind: "review:start" }
  | { kind: "tool:calls"; calls: { name: string; args: Record<string, unknown> }[] }
  | { kind: "tool:results"; results: { name: string; ok: boolean; error?: string; durationMs?: number }[] }
  | { kind: "review:verdict"; verdict: TrollVerdict }
  | { kind: "specialist:cluster:start" }
  | { kind: "specialist:cluster:done"; clusters: { name: string; severity: "high"|"medium"|"low"; description: string }[] }
  | { kind: "specialist:spawn"; index: number; focus: string }
  | { kind: "specialist:done"; lootId: string; index: number }
  | { kind: "specialist:verdict"; verdict: TrollVerdict; index: number }
  | { kind: "fallback:start" }
  | { kind: "fallback:done"; lootId: string }
  | { kind: "scribe:start" }
  | { kind: "scribe:done"; artifactId: string }
  | { kind: "scribe:error"; message: string }
  /** Live partial output streamed from a creature. slot is "ogre", "goblin#N", "specialist#N", etc. */
  | { kind: "thinking"; slot: string; text: string }
  | { kind: "budget:exceeded"; used: number; cap: number; phase: string }
  | { kind: "rite:done"; outcome: Rite["outcome"] };

const PACK_PERSONALITIES: Personality[] = ["nerdy", "cynical", "chipper", "stoic", "feral"];

function pickPackPersonalities(packSize: number, base?: Personality): Personality[] {
  const pool = [...PACK_PERSONALITIES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out: Personality[] = [];
  if (base) {
    out.push(base);
    const idx = pool.indexOf(base);
    if (idx >= 0) pool.splice(idx, 1);
  }
  for (let i = out.length; i < packSize; i++) {
    out.push(pool[(i - out.length) % pool.length]);
  }
  return out;
}

export interface RiteResult {
  rite: Rite;
  winnerLoot: Loot;
  allLoot: Loot[];
}

export async function performRite(opts: RiteOptions): Promise<RiteResult> {
  const personality: Personality = opts.personality ?? "nerdy";
  const riteId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const onStep = opts.onStep ?? (() => {});

  const rite: Rite = {
    id: riteId,
    task: opts.task,
    scanGlobs: opts.scanGlobs ?? [],
    packSize: opts.packSize,
    personality,
    goblinLootIds: [],
    chaosLootIds: {},
    trollVerdicts: {},
    outcome: "all_failed",
    startedAt,
  };
  const allLoot: Loot[] = [];
  const budget = new Budget(opts.budgetTokens);

  const checkBudget = (phase: string): boolean => {
    try {
      budget.enforceOrThrow();
      return true;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        onStep({
          kind: "budget:exceeded",
          used: err.used,
          cap: err.cap,
          phase,
        });
        return false;
      }
      throw err;
    }
  };

  // Memory: prepend prior artifact context if any were passed in.
  let artifactBlock = "";
  if (opts.parentArtifacts && opts.parentArtifacts.length > 0) {
    artifactBlock = opts.parentArtifacts
      .map((a) => renderArtifactContext(a))
      .join("\n\n");
    onStep({
      kind: "artifacts:loaded",
      count: opts.parentArtifacts.length,
      artifactIds: opts.parentArtifacts.map((a) => a.id),
    });
  }

  let factsBlock = "";
  if (opts.scanGlobs && opts.scanGlobs.length > 0 && checkBudget("scavenge")) {
    onStep({ kind: "scavenge:start", globs: opts.scanGlobs });
    const result = await scavenge({
      task: opts.task,
      scanGlobs: opts.scanGlobs,
      cwd: opts.cwd,
      hoard: opts.hoard,
      personality,
      riteId,
    });
    budget.charge(result.loot.usage);
    rite.contextLootId = result.loot.id;
    factsBlock = result.facts;
    allLoot.push(result.loot);
    onStep({
      kind: "scavenge:done",
      lootId: result.loot.id,
      fileCount: result.files.length,
    });
  }

  onStep({ kind: "pack:start", size: opts.packSize });
  if (!checkBudget("pack")) {
    rite.finishedAt = Date.now();
    await opts.hoard.stashRite(rite);
    onStep({ kind: "rite:done", outcome: rite.outcome });
    throw new BudgetExceededError(budget.used, opts.budgetTokens ?? 0);
  }
  const goblinPersonalities = pickPackPersonalities(opts.packSize, opts.personality);
  const sections = [opts.task];
  if (artifactBlock) sections.push(`Prior context (artifacts you may build on):\n${artifactBlock}`);
  if (factsBlock) sections.push(`Facts gathered by the Raccoon:\n${factsBlock}`);
  const taskWithFacts = sections.join("\n\n");

  const goblinJobs = goblinPersonalities.map((p, i) => async () => {
    const goblin = makeGoblin(p);
    const variantPrompt = packVariant(taskWithFacts, i, opts.packSize);
    const slot = `goblin#${i}`;
    const relay = makeThinkingRelay((text) => onStep({ kind: "thinking", slot, text }));
    const { text: output, usage } = await callCreatureStream(
      goblin,
      variantPrompt,
      relay.onChunk,
      {
        maxOutputTokens: opts.maxOutputTokensPerCall,
        outputFormat: opts.outputFormat,
      },
    );
    relay.done();
    const drift = measureDrift(output);
    const loot: Loot = {
      id: "",
      riteId,
      creatureKind: "goblin",
      personality: goblin.personality,
      model: goblin.model,
      prompt: variantPrompt,
      output,
      parentLootIds: rite.contextLootId ? [rite.contextLootId] : undefined,
      timestamp: Date.now(),
      drift,
      usage,
    };
    await opts.hoard.stash(loot);
    onStep({ kind: "pack:goblin", lootId: loot.id, index: i, personality: p });
    return loot;
  }).map((fn) => fn());

  let goblinLoot = await Promise.all(goblinJobs);
  for (const g of goblinLoot) budget.charge(g.usage);
  allLoot.push(...goblinLoot);

  // Phase 4: inter-agent debate round (opt-in). Each goblin sees peers and revises.
  if (opts.debate && goblinLoot.length >= 2 && checkBudget("debate")) {
    onStep({ kind: "debate:start", round: 1, size: goblinLoot.length });
    try {
      const { revisedLoots } = await runDebateRound({
        riteId,
        task: opts.task,
        packLoots: goblinLoot,
        hoard: opts.hoard,
        maxOutputTokensPerCall: opts.maxOutputTokensPerCall,
        outputFormat: opts.outputFormat,
        onSpawn: (i) => { /* the slot is already a goblin#i */ },
        onDone: (i, l) =>
          onStep({ kind: "debate:goblin", lootId: l.id, index: i, round: 1 }),
        onThink: (i, text) =>
          onStep({ kind: "thinking", slot: `goblin#${i}`, text }),
      });
      for (const l of revisedLoots) {
        budget.charge(l.usage);
        allLoot.push(l);
      }
      // Replace the pack with the revised loots so downstream stages judge the
      // post-debate version (more honest evaluation of the debate's effect).
      goblinLoot = revisedLoots;
      onStep({ kind: "debate:done", round: 1 });
    } catch {
      onStep({ kind: "debate:done", round: 1 });
      // fall through; debate failures are non-fatal
    }
  }

  rite.goblinLootIds = goblinLoot.map((g) => g.id);

  onStep({ kind: "chaos:start" });
  if (!checkBudget("chaos")) {
    rite.finishedAt = Date.now();
    await opts.hoard.stashRite(rite);
    onStep({ kind: "rite:done", outcome: rite.outcome });
    throw new BudgetExceededError(budget.used, opts.budgetTokens ?? 0);
  }
  const chaosJobs = goblinLoot.map(async (g) => {
    const c = await chaosPass({
      goblinLoot: g,
      originalTask: opts.task,
      hoard: opts.hoard,
      riteId,
    });
    onStep({ kind: "chaos:done", goblinId: g.id, gremlinId: c.id });
    return [g.id, c] as const;
  });
  const chaosResults = await Promise.all(chaosJobs);
  const chaosByGoblinId = new Map<string, Loot>();
  for (const [gid, cl] of chaosResults) {
    rite.chaosLootIds[gid] = cl.id;
    chaosByGoblinId.set(gid, cl);
    allLoot.push(cl);
    budget.charge(cl.usage);
  }

  // sequential so console output stays in pack order
  onStep({ kind: "review:start" });
  const rewardFn = opts.rewardFn ?? shinies;
  for (const g of goblinLoot) {
    if (!checkBudget("review")) break;
    const { verdict, trollLoot } = await trollReview({
      goblinLoot: g,
      originalTask: opts.task,
      chaosLoot: chaosByGoblinId.get(g.id),
      hoard: opts.hoard,
      riteId,
      withTools: opts.trollTools,
      onToolCalls: (calls) =>
        onStep({ kind: "tool:calls", calls: calls.map((c) => ({ name: c.name, args: c.args })) }),
      onToolResults: (results) =>
        onStep({
          kind: "tool:results",
          results: results.map((r) => ({
            name: r.name, ok: r.ok, error: r.error, durationMs: r.durationMs,
          })),
        }),
    });
    budget.charge(trollLoot.usage);
    rite.trollVerdicts[g.id] = verdict;
    g.reward = rewardFn(g, verdict);
    await opts.hoard.stash(g);
    allLoot.push(trollLoot);
    onStep({ kind: "review:verdict", verdict });
  }

  const passed = goblinLoot.filter((g) => rite.trollVerdicts[g.id]?.passed);
  let winnerLoot: Loot;

  if (passed.length > 0) {
    winnerLoot = passed.reduce((best, cur) =>
      (cur.reward ?? 0) > (best.reward ?? 0) ? cur : best,
    );
    rite.winnerLootId = winnerLoot.id;
    rite.outcome = "winner";
  } else if (opts.noFallback) {
    winnerLoot = goblinLoot.reduce((best, cur) =>
      (cur.reward ?? 0) > (best.reward ?? 0) ? cur : best,
    );
    rite.winnerLootId = winnerLoot.id;
    rite.outcome = "all_failed";
  } else {
    // Phase 2 recovery: try specialist re-rite before paying for the ogre.
    let specialistWinner: Loot | null = null;
    const specialistsAllowed =
      !opts.noSpecialist && goblinLoot.length > 0 && checkBudget("specialist");
    if (specialistsAllowed) {
      onStep({ kind: "specialist:cluster:start" });
      try {
        const seed = pickSeedLoot(goblinLoot, rite.trollVerdicts);
        const gremlinByGoblinId: Record<string, Loot | undefined> = {};
        for (const [gid, gl] of chaosByGoblinId) gremlinByGoblinId[gid] = gl;
        const cap = Math.max(1, Math.min(opts.specialistCap ?? 3, 3));
        const { clusters, usage: clusterUsage } = await clusterFailures({
          task: opts.task,
          goblinLoot,
          verdicts: rite.trollVerdicts,
          gremlinLootByGoblinId: gremlinByGoblinId,
          maxClusters: cap,
        });
        if (clusterUsage) budget.charge(clusterUsage);
        onStep({
          kind: "specialist:cluster:done",
          clusters: clusters.map((c) => ({
            name: c.name,
            severity: c.severity,
            description: c.description,
          })),
        });

        if (seed && clusters.length > 0 && checkBudget("specialist")) {
          const seedScore = rite.trollVerdicts[seed.id]?.score ?? 0;
          const result = await runSpecialistRerite({
            riteId,
            task: opts.task,
            clusters,
            seedLoot: seed,
            seedScore,
            seedGremlinByGoblinId: gremlinByGoblinId,
            hoard: opts.hoard,
            maxOutputTokensPerCall: opts.maxOutputTokensPerCall,
            outputFormat: opts.outputFormat,
            onSpawn: (i, c) =>
              onStep({ kind: "specialist:spawn", index: i, focus: c.specialistFocus }),
            onDone: (i, l) =>
              onStep({ kind: "specialist:done", lootId: l.id, index: i }),
            onVerdict: (i, l, v) => {
              onStep({ kind: "specialist:verdict", verdict: v, index: i });
            },
            onThink: (i, text) =>
              onStep({ kind: "thinking", slot: `specialist#${i}`, text }),
          });
          for (const l of result.loots) {
            if (l.usage) budget.charge(l.usage);
            allLoot.push(l);
          }
          rite.specialistLootIds = result.loots.map((l) => l.id);
          rite.specialistVerdicts = result.verdicts;
          if (result.winner) {
            const r = result.verdicts[result.winner.id];
            result.winner.reward = r ? rewardFn(result.winner, r) : 0;
            await opts.hoard.stash(result.winner);
            specialistWinner = result.winner;
          }
        }
      } catch {
        // recovery is best-effort; fall through to ogre
      }
    }

    if (specialistWinner) {
      rite.winnerLootId = specialistWinner.id;
      rite.outcome = "specialist_recovery";
      winnerLoot = specialistWinner;
    } else if (!checkBudget("fallback")) {
      winnerLoot = goblinLoot.reduce((best, cur) =>
        (cur.reward ?? 0) > (best.reward ?? 0) ? cur : best,
      );
      rite.winnerLootId = winnerLoot.id;
      rite.outcome = "all_failed";
    } else {
      onStep({ kind: "fallback:start" });
      const ogreLoot = await ogreFallback({
        task: opts.task,
        goblinLoot,
        trollVerdicts: rite.trollVerdicts,
        chaosByGoblinId: Object.fromEntries(chaosByGoblinId),
        hoard: opts.hoard,
        riteId,
        outputFormat: opts.outputFormat,
        onThink: (text) => onStep({ kind: "thinking", slot: "ogre", text }),
      });
      budget.charge(ogreLoot.usage);
      rite.ogreLootId = ogreLoot.id;
      rite.winnerLootId = ogreLoot.id;
      rite.outcome = "ogre_fallback";
      allLoot.push(ogreLoot);
      winnerLoot = ogreLoot;
      onStep({ kind: "fallback:done", lootId: ogreLoot.id });
    }
  }

  rite.finishedAt = Date.now();
  await opts.hoard.stashRite(rite);

  // Phase 1 memory: Pigeon-as-Scribe distills this rite into a typed Artifact.
  // Failure here is non-fatal: the rite itself succeeded, the artifact is a bonus.
  if (!opts.skipScribe && checkBudget("scribe")) {
    onStep({ kind: "scribe:start" });
    try {
      const verdicts = Object.values(rite.trollVerdicts);
      const ogreLootForScribe =
        rite.ogreLootId && rite.ogreLootId !== rite.winnerLootId
          ? allLoot.find((l) => l.id === rite.ogreLootId) ?? null
          : (rite.outcome === "ogre_fallback" ? winnerLoot : null);
      const gremlinLoot = allLoot.filter((l) => l.creatureKind === "gremlin");
      const { artifact, usage } = await scribe({
        rite,
        winnerLoot,
        goblinLoot,
        gremlinLoot,
        ogreLoot: ogreLootForScribe,
        verdicts,
        parentArtifacts: opts.parentArtifacts ?? [],
      });
      if (usage && typeof usage === "object" && "totalTokens" in usage) {
        try { budget.charge(usage as Loot["usage"]); } catch { /* budget cap is informational here */ }
      }
      await opts.hoard.stashArtifact(artifact);
      onStep({ kind: "scribe:done", artifactId: artifact.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onStep({ kind: "scribe:error", message });
      // non-fatal — artifact is a bonus, not a requirement
    }
  }

  onStep({ kind: "rite:done", outcome: rite.outcome });

  return { rite, winnerLoot, allLoot };
}
