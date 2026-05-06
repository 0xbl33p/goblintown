import { makeSpecialistGoblin, makeTroll } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { callCreature, callCreatureStream } from "./openai-client.js";
import { makeThinkingRelay } from "./streaming.js";
import { trollReview } from "./troll-review.js";
import type { FailureCluster, Loot, OutputFormat, TrollVerdict } from "./types.js";
import type { Hoard } from "./hoard.js";

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/**
 * Build the user prompt for the failure-clustering call. Pure; safe to test.
 */
export function buildClusterPrompt(opts: {
  task: string;
  goblinLoot: Loot[];
  verdicts: Record<string, TrollVerdict>;
  gremlinLootByGoblinId: Record<string, Loot | undefined>;
  maxClusters: number;
}): string {
  const lines: string[] = [];
  lines.push(`Original task:`);
  lines.push(opts.task);
  lines.push("");
  lines.push(`The pack of ${opts.goblinLoot.length} goblins all failed troll review. Their attempts and critiques follow.`);
  lines.push("");
  opts.goblinLoot.forEach((g, i) => {
    const v = opts.verdicts[g.id];
    const gremlin = opts.gremlinLootByGoblinId[g.id];
    lines.push(`--- Goblin #${i} [${g.personality}] (loot ${g.id}) ---`);
    lines.push(`Output:`);
    lines.push(truncate(g.output, 800));
    if (v) {
      lines.push(`Troll verdict: passed=${v.passed} score=${v.score.toFixed(2)}`);
      lines.push(`Troll critique: ${v.critique}`);
    } else {
      lines.push(`(no troll verdict)`);
    }
    if (gremlin) {
      lines.push(`Gremlin attack:`);
      lines.push(truncate(gremlin.output, 600));
    }
    lines.push("");
  });
  lines.push(
    `Identify the 1-${opts.maxClusters} dominant failure modes across these attempts. ` +
      `A failure mode is a category of mistake (e.g. "null-handling", "off-by-one", "wrong-abstraction", "missing-edge-case"). ` +
      `Output ONLY a single JSON object, nothing else, matching this schema:`,
  );
  lines.push(`{`);
  lines.push(`  "clusters": [`);
  lines.push(`    {`);
  lines.push(`      "name": "kebab-case identifier",`);
  lines.push(`      "description": "1-2 sentences of what is wrong",`);
  lines.push(`      "affectedGoblinIndexes": [0, 1],`);
  lines.push(`      "specialistFocus": "concise instruction telling a specialist what to fix",`);
  lines.push(`      "severity": "high" | "medium" | "low"`);
  lines.push(`    }`);
  lines.push(`  ]`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`Sort clusters by severity descending. No code fences. JSON only.`);
  return lines.join("\n");
}

/**
 * Parse a clustering JSON blob. Forgiving (handles fences, bad enums, etc.).
 */
export function parseClustersJson(raw: string, packSize: number, maxClusters: number): FailureCluster[] {
  const json = extractFirstJsonObject(raw);
  let parsed: Record<string, unknown> = {};
  if (json) {
    try {
      parsed = JSON.parse(json) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  const arr = Array.isArray(parsed.clusters) ? parsed.clusters : [];
  const clusters: FailureCluster[] = [];
  for (const c of arr) {
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const description = typeof obj.description === "string" ? obj.description.trim() : "";
    const focus = typeof obj.specialistFocus === "string" ? obj.specialistFocus.trim() : "";
    if (!name || !focus) continue;
    const severityRaw = obj.severity;
    const severity: FailureCluster["severity"] =
      severityRaw === "high" || severityRaw === "medium" || severityRaw === "low"
        ? severityRaw
        : "medium";
    const idxs = Array.isArray(obj.affectedGoblinIndexes)
      ? (obj.affectedGoblinIndexes as unknown[])
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < packSize)
      : [];
    clusters.push({
      name,
      description: description || focus,
      affectedGoblinIndexes: idxs,
      specialistFocus: focus,
      severity,
    });
  }
  return clusters
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, maxClusters);
}

/**
 * Build the user prompt a Specialist Goblin receives. Pure.
 */
export function buildSpecialistPrompt(opts: {
  task: string;
  cluster: FailureCluster;
  seedLoot: Loot;
  seedGremlinCritique?: string;
}): string {
  const parts: string[] = [];
  parts.push(`Original task:`);
  parts.push(opts.task);
  parts.push("");
  parts.push(`Your focus (the issue you must fix): ${opts.cluster.specialistFocus}`);
  parts.push(`Severity: ${opts.cluster.severity}`);
  parts.push(`Cluster description: ${opts.cluster.description}`);
  parts.push("");
  parts.push(`Best previous attempt (seed — fix this, don't restart unless unsalvageable):`);
  parts.push(opts.seedLoot.output);
  if (opts.seedGremlinCritique) {
    parts.push("");
    parts.push(`Gremlin's specific complaint about this attempt:`);
    parts.push(truncate(opts.seedGremlinCritique, 600));
  }
  parts.push("");
  parts.push(`Output the corrected answer only. No preamble. No commentary on the changes.`);
  return parts.join("\n");
}

/** Run the failure-clustering LLM call. */
export async function clusterFailures(opts: {
  task: string;
  goblinLoot: Loot[];
  verdicts: Record<string, TrollVerdict>;
  gremlinLootByGoblinId: Record<string, Loot | undefined>;
  maxClusters: number;
  maxOutputTokens?: number;
}): Promise<{ clusters: FailureCluster[]; usage: Loot["usage"] }> {
  // Use the troll model for clustering — it's the same adversarial sensibility,
  // and it's typically a cheap mini-tier model.
  const judge = makeTroll();
  const prompt = buildClusterPrompt({
    task: opts.task,
    goblinLoot: opts.goblinLoot,
    verdicts: opts.verdicts,
    gremlinLootByGoblinId: opts.gremlinLootByGoblinId,
    maxClusters: opts.maxClusters,
  });
  const { text, usage } = await callCreature(
    {
      ...judge,
      systemPrompt:
        `You are a failure analyst inside the Goblintown protocol. ` +
        `Cluster the failures of a pack of goblin agents into 1-${opts.maxClusters} dominant failure modes. ` +
        `Output strict JSON only, no prose, no fences.`,
    },
    prompt,
    { maxOutputTokens: opts.maxOutputTokens ?? 800 },
  );
  const clusters = parseClustersJson(text, opts.goblinLoot.length, opts.maxClusters);
  return { clusters, usage };
}

/**
 * Pick the seed loot from a failed pack: highest-reward goblin, falling back
 * to the highest troll score, then the first.
 */
export function pickSeedLoot(
  goblinLoot: Loot[],
  verdicts: Record<string, TrollVerdict>,
): Loot | undefined {
  if (goblinLoot.length === 0) return undefined;
  return goblinLoot.reduce((best, cur) => {
    const bScore = best.reward ?? verdicts[best.id]?.score ?? 0;
    const cScore = cur.reward ?? verdicts[cur.id]?.score ?? 0;
    return cScore > bScore ? cur : best;
  });
}

/**
 * Run the specialist recovery layer. Returns the winner if any specialist
 * passes review OR meaningfully improves over the seed; null otherwise.
 */
export async function runSpecialistRerite(opts: {
  riteId: string;
  task: string;
  clusters: FailureCluster[];
  seedLoot: Loot;
  seedScore: number;
  seedGremlinByGoblinId: Record<string, Loot | undefined>;
  hoard: Hoard;
  maxOutputTokensPerCall?: number;
  outputFormat?: OutputFormat;
  /** Min absolute score-over-seed to count as a recovery win when no specialist passes outright. Default 0.05. */
  improvementMargin?: number;
  onSpawn?: (index: number, cluster: FailureCluster) => void;
  onDone?: (index: number, loot: Loot) => void;
  onVerdict?: (index: number, loot: Loot, verdict: TrollVerdict) => void;
  /** Live partial output from each specialist as it streams. */
  onThink?: (index: number, cumulativeText: string) => void;
}): Promise<{
  loots: Loot[];
  verdicts: Record<string, TrollVerdict>;
  winner: Loot | null;
  /** Why this specialist won: "passed" if it cleared the troll, "improved" if it just beat the seed score. */
  winReason: "passed" | "improved" | null;
}> {
  const seedGremlin = opts.seedGremlinByGoblinId[opts.seedLoot.id]?.output;

  const jobs = opts.clusters.map((cluster, i) => async () => {
    opts.onSpawn?.(i, cluster);
    const specialist = makeSpecialistGoblin(cluster.specialistFocus);
    const userPrompt = buildSpecialistPrompt({
      task: opts.task,
      cluster,
      seedLoot: opts.seedLoot,
      seedGremlinCritique: seedGremlin,
    });
    const onThink = opts.onThink;
    let output: string;
    let usage;
    if (onThink) {
      const relay = makeThinkingRelay((text) => onThink(i, text));
      const r = await callCreatureStream(specialist, userPrompt, relay.onChunk, {
        maxOutputTokens: opts.maxOutputTokensPerCall,
        outputFormat: opts.outputFormat,
      });
      relay.done();
      output = r.text;
      usage = r.usage;
    } else {
      const r = await callCreature(specialist, userPrompt, {
        maxOutputTokens: opts.maxOutputTokensPerCall,
        outputFormat: opts.outputFormat,
      });
      output = r.text;
      usage = r.usage;
    }
    const drift = measureDrift(output);
    const loot: Loot = {
      id: "",
      riteId: opts.riteId,
      creatureKind: "goblin",
      personality: specialist.personality,
      model: specialist.model,
      prompt: userPrompt,
      output,
      parentLootIds: [opts.seedLoot.id],
      timestamp: Date.now(),
      drift,
      usage,
    };
    await opts.hoard.stash(loot);
    opts.onDone?.(i, loot);
    return { loot, index: i };
  });

  const results = await Promise.all(jobs.map((fn) => fn()));

  // Re-judge each specialist output sequentially (cheap, ordered logs).
  const verdicts: Record<string, TrollVerdict> = {};
  for (const { loot, index } of results) {
    const { verdict, trollLoot } = await trollReview({
      goblinLoot: loot,
      originalTask: opts.task,
      chaosLoot: undefined,
      hoard: opts.hoard,
      riteId: opts.riteId,
    });
    verdicts[loot.id] = verdict;
    // stash troll's verdict loot
    void trollLoot;
    opts.onVerdict?.(index, loot, verdict);
  }

  const allLoots = results.map((r) => r.loot);
  const passing = allLoots.filter((l) => verdicts[l.id]?.passed);

  let winner: Loot | null = null;
  let winReason: "passed" | "improved" | null = null;

  if (passing.length > 0) {
    winner = passing.reduce((best, cur) => {
      const bs = verdicts[best.id]?.score ?? 0;
      const cs = verdicts[cur.id]?.score ?? 0;
      return cs > bs ? cur : best;
    });
    winReason = "passed";
  } else {
    const margin = opts.improvementMargin ?? 0.05;
    const best = allLoots.reduce((b, c) => {
      const bs = verdicts[b.id]?.score ?? 0;
      const cs = verdicts[c.id]?.score ?? 0;
      return cs > bs ? c : b;
    }, allLoots[0]);
    if (best && (verdicts[best.id]?.score ?? 0) >= opts.seedScore + margin) {
      winner = best;
      winReason = "improved";
    }
  }

  return { loots: allLoots, verdicts, winner, winReason };
}

/* --------- internal helpers --------- */

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function extractFirstJsonObject(s: string): string | null {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return candidate.slice(start, i + 1);
      }
    }
  }
  return null;
}
