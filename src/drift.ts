import { CREATURE_KINDS, type CreatureKind, type DriftReport } from "./types.js";

export function measureDrift(output: string): DriftReport {
  const lower = output.toLowerCase();
  const mentions: Record<CreatureKind, number> = {
    goblin: 0,
    gremlin: 0,
    raccoon: 0,
    troll: 0,
    ogre: 0,
    pigeon: 0,
  };

  for (const kind of CREATURE_KINDS) {
    const re = new RegExp(`\\b${kind}s?\\b`, "g");
    const matches = lower.match(re);
    mentions[kind] = matches ? matches.length : 0;
  }

  const totalCreatureWords = CREATURE_KINDS.reduce(
    (sum, k) => sum + mentions[k],
    0,
  );
  const outputWordCount = output
    .split(/\s+/)
    .filter((w) => w.length > 0).length;

  return {
    creatureMentions: mentions,
    totalCreatureWords,
    outputWordCount,
    driftRate: outputWordCount > 0 ? totalCreatureWords / outputWordCount : 0,
  };
}

export function crossCreatureDrift(
  output: string,
  selfKind: CreatureKind,
): number {
  const r = measureDrift(output);
  const cross = r.totalCreatureWords - r.creatureMentions[selfKind];
  return r.outputWordCount > 0 ? cross / r.outputWordCount : 0;
}
