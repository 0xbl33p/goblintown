import { randomUUID } from "node:crypto";
import { Budget, BudgetExceededError } from "./budget.js";
import { makeGoblin } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { callCreature } from "./openai-client.js";
import { shinies } from "./reward.js";
import { scavenge } from "./scavenge.js";
import { chaosPass } from "./chaos.js";
import { trollReview } from "./troll-review.js";
import { ogreFallback } from "./fallback.js";
import type {
  Loot,
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
}

export type RiteStep =
  | { kind: "scavenge:start"; globs: string[] }
  | { kind: "scavenge:done"; lootId: string; fileCount: number }
  | { kind: "pack:start"; size: number }
  | { kind: "pack:goblin"; lootId: string; index: number }
  | { kind: "chaos:start" }
  | { kind: "chaos:done"; goblinId: string; gremlinId: string }
  | { kind: "review:start" }
  | { kind: "review:verdict"; verdict: TrollVerdict }
  | { kind: "fallback:start" }
  | { kind: "fallback:done"; lootId: string }
  | { kind: "budget:exceeded"; used: number; cap: number; phase: string }
  | { kind: "rite:done"; outcome: Rite["outcome"] };

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
  const baseGoblin = makeGoblin(personality);
  const taskWithFacts = factsBlock
    ? `${opts.task}\n\nFacts gathered by the Raccoon:\n${factsBlock}`
    : opts.task;

  const goblinJobs = Array.from({ length: opts.packSize }, async (_, i) => {
    const tempStep = (i - (opts.packSize - 1) / 2) * 0.1;
    const goblin = {
      ...baseGoblin,
      temperature: clampTemp(baseGoblin.temperature + tempStep),
    };
    const { text: output, usage } = await callCreature(goblin, taskWithFacts, {
      maxOutputTokens: opts.maxOutputTokensPerCall,
    });
    const drift = measureDrift(output);
    const loot: Loot = {
      id: "",
      riteId,
      creatureKind: "goblin",
      personality: goblin.personality,
      model: goblin.model,
      prompt: taskWithFacts,
      output,
      parentLootIds: rite.contextLootId ? [rite.contextLootId] : undefined,
      timestamp: Date.now(),
      drift,
      usage,
    };
    await opts.hoard.stash(loot);
    onStep({ kind: "pack:goblin", lootId: loot.id, index: i });
    return loot;
  });

  const goblinLoot = await Promise.all(goblinJobs);
  for (const g of goblinLoot) budget.charge(g.usage);
  rite.goblinLootIds = goblinLoot.map((g) => g.id);
  allLoot.push(...goblinLoot);

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
  } else if (opts.noFallback || !checkBudget("fallback")) {
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
    });
    budget.charge(ogreLoot.usage);
    rite.ogreLootId = ogreLoot.id;
    rite.winnerLootId = ogreLoot.id;
    rite.outcome = "ogre_fallback";
    allLoot.push(ogreLoot);
    winnerLoot = ogreLoot;
    onStep({ kind: "fallback:done", lootId: ogreLoot.id });
  }

  rite.finishedAt = Date.now();
  await opts.hoard.stashRite(rite);
  onStep({ kind: "rite:done", outcome: rite.outcome });

  return { rite, winnerLoot, allLoot };
}

function clampTemp(n: number): number {
  return Math.max(0, Math.min(1.6, n));
}
