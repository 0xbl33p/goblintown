import { makeOgre } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { callCreature } from "./openai-client.js";
import type { Loot, Personality, TrollVerdict } from "./types.js";
import type { Hoard } from "./hoard.js";

export interface OgreFallbackOptions {
  task: string;
  goblinLoot: Loot[];
  trollVerdicts: Record<string, TrollVerdict>;
  chaosByGoblinId?: Record<string, Loot>;
  hoard: Hoard;
  personality?: Personality;
  riteId?: string;
}

export async function ogreFallback(opts: OgreFallbackOptions): Promise<Loot> {
  const ogre = makeOgre(opts.personality);

  const sections = opts.goblinLoot.map((g, i) => {
    const v = opts.trollVerdicts[g.id];
    const chaos = opts.chaosByGoblinId?.[g.id];
    return (
      `--- Attempt ${i + 1} (loot ${g.id}, troll score ${v?.score?.toFixed(2) ?? "?"}, ${v?.passed ? "PASS" : "FAIL"}) ---\n` +
      `Goblin output:\n${g.output}\n\n` +
      `Troll critique:\n${v?.critique ?? "(none)"}\n\n` +
      (chaos
        ? `Gremlin chaos report:\n${chaos.output}\n`
        : `Gremlin chaos report: (none)\n`)
    );
  });

  const userPrompt =
    `The Goblin pack failed Troll review on this task:\n\n${opts.task}\n\n` +
    `Below are all attempts, their critiques, and chaos reports. ` +
    `Synthesize a single correct, complete answer. ` +
    `You may borrow from any attempt, but you must address every Troll critique and survive every Gremlin attack. ` +
    `Do not narrate your synthesis — just deliver the corrected answer.\n\n` +
    sections.join("\n");

  const { text: output, usage } = await callCreature(ogre, userPrompt);
  const drift = measureDrift(output);

  const loot: Loot = {
    id: "",
    riteId: opts.riteId,
    creatureKind: "ogre",
    personality: ogre.personality,
    model: ogre.model,
    prompt: userPrompt,
    output,
    parentLootIds: opts.goblinLoot.map((g) => g.id),
    timestamp: Date.now(),
    drift,
    usage,
  };
  await opts.hoard.stash(loot);
  return loot;
}
