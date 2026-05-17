export default function reward(loot, verdict) {
  const base = verdict.passed ? 0.82 : Math.max(0, verdict.score * 0.45);
  const driftBonus = 1 - Math.min(1, loot?.drift?.driftRate ?? 0);
  const passBonus = verdict.passed ? 0.08 : 0;

  return Math.max(0, Math.min(1, base + driftBonus * 0.1 + passBonus));
}
