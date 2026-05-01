import { crossCreatureDrift } from "./drift.js";
import type { Loot, TrollVerdict } from "./types.js";

export function shinies(loot: Loot, verdict: TrollVerdict): number {
  const cross = crossCreatureDrift(loot.output, loot.creatureKind);
  const driftPenalty = Math.min(0.5, cross * 4);
  const trollScore = clamp01(verdict.score);
  const passBonus = verdict.passed ? 0.1 : 0;
  return clamp01(trollScore - driftPenalty + passBonus);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
