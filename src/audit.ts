import { CREATURE_KINDS, type CreatureKind, type Loot, type Rite } from "./types.js";
import type { Hoard } from "./hoard.js";

export interface AuditReport {
  rite: Rite;
  totalLoot: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  byKind: Record<CreatureKind, KindStats>;
  highestDrift: { lootId: string; rate: number; kind: CreatureKind } | null;
  longestChain: { length: number; lootIds: string[] };
  warnings: string[];
}

export interface KindStats {
  count: number;
  totalTokens: number;
  avgDriftRate: number;
  avgRewardOrZero: number;
}

export async function auditRite(
  hoard: Hoard,
  riteId: string,
): Promise<AuditReport | null> {
  const rite = await hoard.getRite(riteId);
  if (!rite) return null;

  const ids = collectRiteLootIds(rite);
  const loot: Loot[] = [];
  for (const id of ids) {
    const l = await hoard.getLoot(id);
    if (l) loot.push(l);
  }

  const byKind = emptyKindStats();
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let highestDrift: AuditReport["highestDrift"] = null;
  for (const l of loot) {
    const stats = byKind[l.creatureKind];
    stats.count += 1;
    if (l.usage) {
      stats.totalTokens += l.usage.totalTokens;
      totalTokens += l.usage.totalTokens;
      promptTokens += l.usage.promptTokens;
      completionTokens += l.usage.completionTokens;
    }
    stats.avgDriftRate += l.drift.driftRate;
    stats.avgRewardOrZero += l.reward ?? 0;
    if (!highestDrift || l.drift.driftRate > highestDrift.rate) {
      highestDrift = {
        lootId: l.id,
        rate: l.drift.driftRate,
        kind: l.creatureKind,
      };
    }
  }
  for (const k of CREATURE_KINDS) {
    const stats = byKind[k];
    if (stats.count > 0) {
      stats.avgDriftRate /= stats.count;
      stats.avgRewardOrZero /= stats.count;
    }
  }

  const lootById = new Map(loot.map((l) => [l.id, l]));
  const longestChain = findLongestChain(lootById);

  const warnings: string[] = [];
  if (rite.outcome === "ogre_fallback" && !rite.ogreLootId) {
    warnings.push("rite declared ogre_fallback but no ogre loot was stashed");
  }
  if (rite.winnerLootId && !lootById.has(rite.winnerLootId)) {
    warnings.push(`winner loot ${rite.winnerLootId} is not in the Hoard`);
  }
  for (const l of loot) {
    for (const pid of l.parentLootIds ?? []) {
      if (!lootById.has(pid)) {
        const orphan = await hoard.getLoot(pid);
        if (!orphan) {
          warnings.push(`loot ${l.id} references missing parent ${pid}`);
        }
      }
    }
  }

  return {
    rite,
    totalLoot: loot.length,
    totalTokens,
    promptTokens,
    completionTokens,
    byKind,
    highestDrift,
    longestChain,
    warnings,
  };
}

export function collectRiteLootIds(rite: Rite): string[] {
  const ids = new Set<string>();
  if (rite.contextLootId) ids.add(rite.contextLootId);
  for (const id of rite.goblinLootIds) ids.add(id);
  for (const id of Object.values(rite.chaosLootIds)) ids.add(id);
  if (rite.ogreLootId) ids.add(rite.ogreLootId);
  return [...ids];
}

function emptyKindStats(): Record<CreatureKind, KindStats> {
  const out = {} as Record<CreatureKind, KindStats>;
  for (const k of CREATURE_KINDS) {
    out[k] = {
      count: 0,
      totalTokens: 0,
      avgDriftRate: 0,
      avgRewardOrZero: 0,
    };
  }
  return out;
}

function findLongestChain(
  lootById: Map<string, Loot>,
): { length: number; lootIds: string[] } {
  const depth = new Map<string, number>();
  const choice = new Map<string, string | null>();
  const visiting = new Set<string>();

  function compute(id: string): number {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) {
      // cycle: treat as leaf
      return 1;
    }
    visiting.add(id);
    const l = lootById.get(id);
    let best = 0;
    let bestParent: string | null = null;
    for (const pid of l?.parentLootIds ?? []) {
      if (!lootById.has(pid)) continue;
      const d = compute(pid);
      if (d > best) {
        best = d;
        bestParent = pid;
      }
    }
    visiting.delete(id);
    depth.set(id, best + 1);
    choice.set(id, bestParent);
    return best + 1;
  }

  let bestId: string | null = null;
  let bestDepth = 0;
  for (const id of lootById.keys()) {
    const d = compute(id);
    if (d > bestDepth) {
      bestDepth = d;
      bestId = id;
    }
  }
  if (!bestId) return { length: 0, lootIds: [] };

  const chain: string[] = [];
  let cur: string | null = bestId;
  while (cur) {
    chain.push(cur);
    cur = choice.get(cur) ?? null;
  }
  chain.reverse();
  return { length: bestDepth, lootIds: chain };
}
