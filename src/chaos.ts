import { makeGremlin } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { callCreature } from "./openai-client.js";
import type { Loot, Personality } from "./types.js";
import type { Hoard } from "./hoard.js";

export interface ChaosPassOptions {
  goblinLoot: Loot;
  originalTask: string;
  hoard: Hoard;
  personality?: Personality;
  riteId?: string;
}

export async function chaosPass(opts: ChaosPassOptions): Promise<Loot> {
  const gremlin = makeGremlin(opts.personality);
  const userPrompt =
    `Original task:\n${opts.originalTask}\n\n` +
    `Artifact under attack (a Goblin's answer):\n${opts.goblinLoot.output}\n\n` +
    `Produce a numbered list of distinct attacks, edge cases, or failure modes ` +
    `that would defeat or invalidate this artifact. Be ruthless and specific. ` +
    `If the artifact appears actually correct, say "NO DEFECTS FOUND" on its own line ` +
    `and explain in one sentence why your attempts failed.`;

  const { text: output, usage } = await callCreature(gremlin, userPrompt);
  const drift = measureDrift(output);
  const loot: Loot = {
    id: "",
    riteId: opts.riteId,
    creatureKind: "gremlin",
    personality: gremlin.personality,
    model: gremlin.model,
    prompt: userPrompt,
    output,
    parentLootIds: [opts.goblinLoot.id],
    timestamp: Date.now(),
    drift,
    usage,
  };
  await opts.hoard.stash(loot);
  return loot;
}
