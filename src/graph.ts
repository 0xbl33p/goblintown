import type { Hoard } from "./hoard.js";
import type { Loot, Rite, TrollVerdict } from "./types.js";

export async function renderRiteGraph(
  hoard: Hoard,
  riteId: string,
): Promise<string | null> {
  const rite = await hoard.getRite(riteId);
  if (!rite) return null;

  const ids = new Set<string>();
  if (rite.contextLootId) ids.add(rite.contextLootId);
  for (const id of rite.goblinLootIds) ids.add(id);
  for (const id of Object.values(rite.chaosLootIds)) ids.add(id);
  if (rite.ogreLootId) ids.add(rite.ogreLootId);
  // trolls aren't in the rite manifest by id — find them via parent links
  const allLoot = await hoard.allLoot();
  const trollByGoblin = new Map<string, Loot>();
  for (const l of allLoot) {
    if (l.creatureKind !== "troll" || l.riteId !== riteId) continue;
    const goblinId = l.parentLootIds?.[0];
    if (goblinId) trollByGoblin.set(goblinId, l);
  }

  const lootById = new Map<string, Loot>();
  for (const id of ids) {
    const l = await hoard.getLoot(id);
    if (l) lootById.set(id, l);
  }
  for (const t of trollByGoblin.values()) lootById.set(t.id, t);

  const lines: string[] = [];
  lines.push(`rite ${rite.id}  outcome=${rite.outcome}  pack=${rite.packSize}  personality=${rite.personality}`);
  lines.push(`task: ${truncate(rite.task, 100)}`);
  lines.push("");

  if (rite.contextLootId) {
    const r = lootById.get(rite.contextLootId);
    lines.push(`├─ raccoon  ${rite.contextLootId}${formatTokens(r)}`);
  }

  for (let i = 0; i < rite.goblinLootIds.length; i++) {
    const gid = rite.goblinLootIds[i];
    const goblin = lootById.get(gid);
    const chaosId = rite.chaosLootIds[gid];
    const troll = trollByGoblin.get(gid);
    const verdict = rite.trollVerdicts[gid];
    const isWinner = gid === rite.winnerLootId;

    const head = `${i === rite.goblinLootIds.length - 1 && !rite.ogreLootId ? "└─" : "├─"} goblin   ${gid}${formatRewardOrTokens(goblin)}${isWinner ? "  ★ winner" : ""}`;
    lines.push(head);
    if (chaosId) {
      lines.push(`│   ├─ gremlin ${chaosId}${formatTokens(lootById.get(chaosId))}`);
    }
    if (troll) {
      lines.push(
        `│   └─ troll   ${troll.id}${formatVerdict(verdict)}${formatTokens(troll)}`,
      );
    } else {
      lines.push(`│   └─ troll   (no verdict)`);
    }
  }

  if (rite.ogreLootId) {
    const ogre = lootById.get(rite.ogreLootId);
    lines.push(
      `└─ ogre     ${rite.ogreLootId}${formatTokens(ogre)}  ★ winner (fallback)`,
    );
  }

  return lines.join("\n");
}

export async function renderLootAncestry(
  hoard: Hoard,
  rootId: string,
  maxDepth = 12,
): Promise<string | null> {
  const root = await hoard.getLoot(rootId);
  if (!root) return null;
  const seen = new Set<string>();
  const lines: string[] = [];

  async function walk(id: string, prefix: string, depth: number) {
    if (depth > maxDepth) {
      lines.push(prefix + "... (depth cap)");
      return;
    }
    if (seen.has(id)) {
      lines.push(prefix + `(cycle: ${id})`);
      return;
    }
    seen.add(id);
    const l = await hoard.getLoot(id);
    if (!l) {
      lines.push(prefix + `(missing ${id})`);
      return;
    }
    lines.push(`${prefix}${l.creatureKind.padEnd(8)} ${l.id}${formatRewardOrTokens(l)}`);
    const parents = l.parentLootIds ?? [];
    for (let i = 0; i < parents.length; i++) {
      const isLast = i === parents.length - 1;
      const newPrefix = prefix + (isLast ? "└─ " : "├─ ");
      const childPrefix = prefix + (isLast ? "   " : "│  ");
      lines.push(newPrefix.trimEnd());
      // Replace the trailing branch with a real call:
      lines.pop();
      await walk(parents[i], newPrefix, depth + 1);
      // After recursion, future siblings use childPrefix as their indent
      // (handled by passing newPrefix above; this is just a placeholder).
      void childPrefix;
    }
  }

  await walk(rootId, "", 0);
  return lines.join("\n");
}

function formatVerdict(v?: TrollVerdict): string {
  if (!v) return "";
  return `  [${v.passed ? "PASS" : "FAIL"} score=${v.score.toFixed(2)}]`;
}

function formatTokens(l: Loot | undefined): string {
  if (!l?.usage) return "";
  return `  (${l.usage.totalTokens} tok)`;
}

function formatRewardOrTokens(l: Loot | undefined): string {
  if (!l) return "";
  const r = l.reward !== undefined ? `  shinies=${l.reward.toFixed(3)}` : "";
  return r + formatTokens(l);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
