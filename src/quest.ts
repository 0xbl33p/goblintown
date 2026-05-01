import { randomUUID } from "node:crypto";
import { makeGoblin } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { callCreature } from "./openai-client.js";
import { shinies } from "./reward.js";
import { trollReview } from "./troll-review.js";
import type { Loot, Personality, Quest } from "./types.js";
import type { Hoard } from "./hoard.js";
import type { RewardFn } from "./reward-plugin.js";

export interface DispatchOptions {
  task: string;
  packSize: number;
  hoard: Hoard;
  personality?: Personality;
  rewardFn?: RewardFn;
}

export interface DispatchResult {
  quest: Quest;
  loot: Loot[];
  winner: Loot;
}

export async function dispatchQuest(
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const personality: Personality = opts.personality ?? "nerdy";
  const questId = randomUUID().slice(0, 8);
  const quest: Quest = {
    id: questId,
    task: opts.task,
    packSize: opts.packSize,
    personality,
    lootIds: [],
    trollVerdicts: {},
    startedAt: Date.now(),
  };

  const baseGoblin = makeGoblin(personality);
  const goblinJobs = Array.from({ length: opts.packSize }, async (_, i) => {
    const tempStep = (i - (opts.packSize - 1) / 2) * 0.1;
    const goblin = {
      ...baseGoblin,
      temperature: clampTemp(baseGoblin.temperature + tempStep),
    };
    const { text: output, usage } = await callCreature(goblin, opts.task);
    const drift = measureDrift(output);
    const loot: Loot = {
      id: "",
      questId,
      creatureKind: "goblin",
      personality: goblin.personality,
      model: goblin.model,
      prompt: opts.task,
      output,
      timestamp: Date.now(),
      drift,
      usage,
    };
    await opts.hoard.stash(loot);
    return loot;
  });

  const loot = await Promise.all(goblinJobs);
  quest.lootIds = loot.map((l) => l.id);

  const rewardFn = opts.rewardFn ?? shinies;
  for (const item of loot) {
    const { verdict } = await trollReview({
      goblinLoot: item,
      originalTask: opts.task,
      hoard: opts.hoard,
    });
    quest.trollVerdicts[item.id] = verdict;
    item.reward = rewardFn(item, verdict);
    await opts.hoard.stash(item);
  }

  const winner = loot.reduce((best, cur) =>
    (cur.reward ?? 0) > (best.reward ?? 0) ? cur : best,
  );
  quest.winnerLootId = winner.id;
  quest.finishedAt = Date.now();
  await opts.hoard.stashQuest(quest);

  return { quest, loot, winner };
}

function clampTemp(n: number): number {
  return Math.max(0, Math.min(1.6, n));
}
