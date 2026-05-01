import type { Hoard } from "./hoard.js";
import type { Loot, Rite } from "./types.js";

export async function exportRiteMarkdown(
  hoard: Hoard,
  riteId: string,
): Promise<string | null> {
  const rite = await hoard.getRite(riteId);
  if (!rite) return null;

  const all = await hoard.allLoot();
  const inRite = all.filter((l) => l.riteId === riteId);
  const lootById = new Map(inRite.map((l) => [l.id, l]));

  const parts: string[] = [];
  parts.push(`# Rite \`${rite.id}\``);
  parts.push("");
  parts.push(
    `- **Outcome:** ${rite.outcome}\n` +
      `- **Personality:** ${rite.personality}\n` +
      `- **Pack size:** ${rite.packSize}\n` +
      `- **Started:** ${new Date(rite.startedAt).toISOString()}\n` +
      `- **Finished:** ${rite.finishedAt ? new Date(rite.finishedAt).toISOString() : "(unfinished)"}\n` +
      `- **Scan globs:** ${rite.scanGlobs.length === 0 ? "(none)" : rite.scanGlobs.map((g) => `\`${g}\``).join(", ")}\n` +
      `- **Total loot:** ${inRite.length}\n` +
      `- **Total tokens:** ${inRite.reduce((s, l) => s + (l.usage?.totalTokens ?? 0), 0)}`,
  );
  parts.push("");
  parts.push(`## Task`);
  parts.push("");
  parts.push("```");
  parts.push(rite.task);
  parts.push("```");
  parts.push("");

  if (rite.contextLootId) {
    const r = lootById.get(rite.contextLootId);
    parts.push(`## Raccoon scavenge (\`${rite.contextLootId}\`)`);
    parts.push("");
    parts.push(formatLootMeta(r));
    parts.push("");
    parts.push(r ? r.output : "(missing)");
    parts.push("");
  }

  parts.push(`## Goblin pack`);
  parts.push("");
  for (const gid of rite.goblinLootIds) {
    const goblin = lootById.get(gid);
    const verdict = rite.trollVerdicts[gid];
    const chaosId = rite.chaosLootIds[gid];
    const chaos = chaosId ? lootById.get(chaosId) : null;
    const isWinner = gid === rite.winnerLootId;
    parts.push(
      `### Goblin \`${gid}\`${isWinner ? "  ★ winner" : ""}`,
    );
    parts.push("");
    parts.push(formatLootMeta(goblin));
    if (verdict) {
      parts.push(
        `- **Troll:** ${verdict.passed ? "PASS" : "FAIL"} (score ${verdict.score.toFixed(2)})\n` +
          `- **Critique:** ${verdict.critique}`,
      );
    }
    parts.push("");
    parts.push(goblin ? goblin.output : "(missing)");
    parts.push("");
    if (chaos) {
      parts.push(`#### Gremlin chaos (\`${chaos.id}\`)`);
      parts.push("");
      parts.push(formatLootMeta(chaos));
      parts.push("");
      parts.push(chaos.output);
      parts.push("");
    }
  }

  if (rite.ogreLootId) {
    const ogre = lootById.get(rite.ogreLootId);
    parts.push(`## Ogre fallback (\`${rite.ogreLootId}\`)`);
    parts.push("");
    parts.push(formatLootMeta(ogre));
    parts.push("");
    parts.push(ogre ? ogre.output : "(missing)");
    parts.push("");
  }

  if (rite.winnerLootId) {
    const winner = lootById.get(rite.winnerLootId);
    parts.push(`## Winner`);
    parts.push("");
    parts.push(`**Loot id:** \`${rite.winnerLootId}\``);
    parts.push("");
    parts.push(winner ? winner.output : "(missing)");
    parts.push("");
  }

  return parts.join("\n");
}

function formatLootMeta(loot: Loot | undefined): string {
  if (!loot) return "_(missing from Hoard)_";
  const u = loot.usage;
  return (
    `- **Model:** \`${loot.model}\`\n` +
    `- **Personality:** ${loot.personality}\n` +
    (u
      ? `- **Tokens:** ${u.totalTokens} (prompt ${u.promptTokens} / completion ${u.completionTokens})\n`
      : "") +
    `- **Drift rate:** ${loot.drift.driftRate.toFixed(4)}` +
    (loot.reward !== undefined ? `\n- **Shinies:** ${loot.reward.toFixed(3)}` : "")
  );
}
