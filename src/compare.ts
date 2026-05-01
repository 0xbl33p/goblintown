import type { Hoard } from "./hoard.js";
import type { Loot, Rite } from "./types.js";

export interface RiteSnapshot {
  rite: Rite;
  totalTokens: number;
  totalLoot: number;
  avgDriftRate: number;
  passRate: number;
  winner?: Loot;
}

export interface ComparisonReport {
  a: RiteSnapshot;
  b: RiteSnapshot;
  taskMatches: boolean;
}

export async function compareRites(
  hoard: Hoard,
  riteIdA: string,
  riteIdB: string,
): Promise<ComparisonReport | null> {
  const [snapA, snapB] = await Promise.all([
    snapshot(hoard, riteIdA),
    snapshot(hoard, riteIdB),
  ]);
  if (!snapA || !snapB) return null;
  return {
    a: snapA,
    b: snapB,
    taskMatches: snapA.rite.task === snapB.rite.task,
  };
}

async function snapshot(hoard: Hoard, riteId: string): Promise<RiteSnapshot | null> {
  const rite = await hoard.getRite(riteId);
  if (!rite) return null;
  const all = await hoard.allLoot();
  const inRite = all.filter((l) => l.riteId === riteId);

  const totalTokens = inRite.reduce(
    (s, l) => s + (l.usage?.totalTokens ?? 0),
    0,
  );
  const driftSum = inRite.reduce((s, l) => s + l.drift.driftRate, 0);
  const avgDriftRate = inRite.length > 0 ? driftSum / inRite.length : 0;

  const verdicts = Object.values(rite.trollVerdicts);
  const passes = verdicts.filter((v) => v.passed).length;
  const passRate = verdicts.length > 0 ? passes / verdicts.length : 0;

  const winner = rite.winnerLootId
    ? inRite.find((l) => l.id === rite.winnerLootId) ??
      (await hoard.getLoot(rite.winnerLootId)) ??
      undefined
    : undefined;

  return {
    rite,
    totalTokens,
    totalLoot: inRite.length,
    avgDriftRate,
    passRate,
    winner: winner ?? undefined,
  };
}
