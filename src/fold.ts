/**
 * Phase 6 — Context-folding for old artifacts.
 *
 * As the warren accumulates artifacts, retrieval gets noisy. Folding picks
 * topically similar groups (via keyword overlap, or embeddings if available)
 * and asks the Pigeon-Scribe to merge each group into a single higher-level
 * summary artifact. The folded inputs are then marked as parents of the new
 * artifact (so the lineage is preserved).
 *
 * Pure functions exported:
 *   - clusterByKeywords: simple greedy clustering for testability
 *   - buildFoldPrompt: the prompt the pigeon receives
 */
import { makeScribe } from "./creatures.js";
import { callCreature } from "./openai-client.js";
import { parseArtifactJson } from "./artifact.js";
import type { Artifact } from "./types.js";
import type { Hoard } from "./hoard.js";

/**
 * Greedy clustering: walk artifacts in age order; for each, attach to the
 * earliest existing cluster sharing >= `minOverlap` keywords; otherwise start
 * a new cluster. Returns clusters in original order.
 */
export function clusterByKeywords(
  artifacts: Artifact[],
  minOverlap: number,
  maxClusterSize: number,
): Artifact[][] {
  const clusters: Artifact[][] = [];
  outer: for (const a of artifacts) {
    for (const cluster of clusters) {
      if (cluster.length >= maxClusterSize) continue;
      const seedKeywords = new Set(cluster[0].keywords);
      let overlap = 0;
      for (const k of a.keywords) if (seedKeywords.has(k)) overlap++;
      if (overlap >= minOverlap) {
        cluster.push(a);
        continue outer;
      }
    }
    clusters.push([a]);
  }
  return clusters;
}

export function buildFoldPrompt(group: Artifact[]): string {
  const lines: string[] = [];
  lines.push(`Fold ${group.length} related artifacts into ONE higher-level summary artifact.`);
  lines.push(``);
  for (let i = 0; i < group.length; i++) {
    const a = group[i];
    lines.push(`--- Artifact ${i + 1} (id=${a.id}, rite=${a.riteId}, outcome=${a.outcome}) ---`);
    lines.push(`Task: ${a.task}`);
    if (a.claims.length > 0) {
      lines.push(`Claims:`);
      for (const c of a.claims.slice(0, 6)) {
        lines.push(`- (${c.confidence}) ${c.text}`);
      }
    }
    if (a.openQuestions.length > 0) {
      lines.push(`Open questions: ${a.openQuestions.slice(0, 5).join(" | ")}`);
    }
    if (a.nextSteps.length > 0) {
      lines.push(`Next steps: ${a.nextSteps.slice(0, 5).join(" | ")}`);
    }
    lines.push(``);
  }
  lines.push(
    `Produce a single Artifact JSON merging the above. Preserve only the most-load-bearing claims (max 8). ` +
      `Open questions and next steps should be deduplicated. Output JSON only.`,
  );
  lines.push(`{`);
  lines.push(`  "claims": [{ "text": string, "confidence": "established"|"likely"|"speculative", "evidenceIds": number[] }],`);
  lines.push(`  "evidence": [{ "kind": "loot"|"file"|"url"|"external", "ref": string, "snippet": string }],`);
  lines.push(`  "openQuestions": string[],`);
  lines.push(`  "nextSteps": string[],`);
  lines.push(`  "keywords": string[]`);
  lines.push(`}`);
  return lines.join("\n");
}

export async function foldArtifacts(opts: {
  hoard: Hoard;
  threshold?: number;
  minOverlap?: number;
  maxClusterSize?: number;
  /** Only fold artifacts older than this many days. Default 7. */
  minAgeDays?: number;
  onProgress?: (msg: string) => void;
}): Promise<{ created: Artifact[]; foldedInputCount: number }> {
  const threshold = opts.threshold ?? 30;
  const minOverlap = opts.minOverlap ?? 2;
  const maxClusterSize = opts.maxClusterSize ?? 6;
  const minAgeDays = opts.minAgeDays ?? 7;
  const cutoff = Date.now() - minAgeDays * 86_400_000;

  const all = await opts.hoard.allArtifacts();
  if (all.length < threshold) {
    opts.onProgress?.(`only ${all.length} artifacts; below threshold ${threshold}; nothing to fold`);
    return { created: [], foldedInputCount: 0 };
  }

  // Don't fold artifacts already produced by an earlier fold (they tend to be
  // root-ish summaries already).
  const eligible = all
    .filter((a) => a.timestamp <= cutoff)
    .filter((a) => a.parentArtifactIds.length === 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (eligible.length < minOverlap) {
    opts.onProgress?.(`not enough eligible artifacts to fold`);
    return { created: [], foldedInputCount: 0 };
  }

  const clusters = clusterByKeywords(eligible, minOverlap, maxClusterSize)
    .filter((c) => c.length >= 2);

  if (clusters.length === 0) {
    opts.onProgress?.(`no cluster reached size 2`);
    return { created: [], foldedInputCount: 0 };
  }

  const scribe = makeScribe();
  const created: Artifact[] = [];
  let foldedInputCount = 0;

  for (const group of clusters) {
    opts.onProgress?.(`folding ${group.length} artifacts`);
    try {
      const prompt = buildFoldPrompt(group);
      const { text } = await callCreature(scribe, prompt, { maxOutputTokens: 1500 });
      const groupKeywords = Array.from(new Set(group.flatMap((g) => g.keywords)));
      const folded = parseArtifactJson(text, {
        riteId: "fold-" + group[0].riteId.slice(0, 6),
        task: `Folded summary of ${group.length} prior rites: ${group.map((g) => g.task).slice(0, 3).join(" / ")}`,
        outcome: "winner",
        parentArtifactIds: group.map((g) => g.id),
      });
      // Inherit union of keywords if scribe didn't provide any usable ones.
      if (folded.keywords.length === 0) folded.keywords = groupKeywords.slice(0, 12);
      await opts.hoard.stashArtifact(folded);
      created.push(folded);
      foldedInputCount += group.length;
    } catch {
      // best-effort; one failed group doesn't block others
    }
  }

  return { created, foldedInputCount };
}
