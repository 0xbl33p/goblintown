/**
 * Phase 6 — Embeddings-based retrieval for Artifacts.
 *
 * Replaces keyword overlap with cosine similarity over OpenAI embeddings.
 * Lazy-computed: embeddings are written to artifact.embedding the first time
 * an artifact is scored. Falls back to keyword retrieval if embeddings can't
 * be obtained (network error, no API key, etc.).
 *
 * Pure helpers (cosineSimilarity, scoreEmbedded, mergeRanks) are exported so
 * tests can validate ranking math without any network access.
 */
import OpenAI from "openai";
import { scoreArtifact, extractKeywords } from "./artifact.js";
import {
  loadProviderConfigFromCwd,
  providerRuntimeSignature,
  resolveModelForSlot,
  resolveProviderRuntime,
} from "./providers.js";
import type { Artifact } from "./types.js";
import type { Hoard } from "./hoard.js";

const EMBED_MODEL = process.env.GOBLINTOWN_EMBEDDING_MODEL ?? "text-embedding-3-small";

let _client: OpenAI | null = null;
let _clientSignature: string | null = null;
function getClient(): OpenAI {
  const config = loadProviderConfigFromCwd();
  const runtime = resolveProviderRuntime(config);
  if (runtime.missingApiKey) throw new Error(`${runtime.missingApiKey} is not set`);
  const signature = providerRuntimeSignature(runtime);
  if (_client && _clientSignature === signature) return _client;
  _client = new OpenAI({
    apiKey: runtime.apiKey,
    baseURL: runtime.baseURL,
    maxRetries: 3,
    defaultHeaders: runtime.defaultHeaders,
  });
  _clientSignature = signature;
  return _client;
}

export async function embed(text: string): Promise<number[]> {
  const client = getClient();
  const r = await client.embeddings.create({
    model: resolveModelForSlot("embedding", EMBED_MODEL),
    input: text,
  });
  const v = r.data[0]?.embedding;
  if (!v) throw new Error("empty embedding response");
  return v;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Score = cosine similarity * 0.85 + recency * 0.15.
 * Pure function on already-embedded inputs.
 */
export function scoreEmbedded(artifact: Artifact, queryEmbedding: number[], now: number): number {
  if (!artifact.embedding || artifact.embedding.length === 0) return 0;
  const sim = Math.max(0, cosineSimilarity(artifact.embedding, queryEmbedding));
  const ageDays = Math.max(0, (now - artifact.timestamp) / 86_400_000);
  const recency = 1 / (1 + ageDays / 7);
  return sim * 0.85 + recency * 0.15;
}

/**
 * Merge two ranked lists (e.g. embedding-ranked + keyword-ranked) using
 * reciprocal rank fusion. Pure, deterministic.
 */
export function mergeRanks(
  rankings: { id: string }[][],
  k = 60,
): string[] {
  const scores = new Map<string, number>();
  for (const list of rankings) {
    list.forEach((item, idx) => {
      const prev = scores.get(item.id) ?? 0;
      scores.set(item.id, prev + 1 / (k + idx + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Find relevant artifacts using embeddings (with keyword fallback).
 *
 * - Computes an embedding of `queryText` (one API call).
 * - For each artifact missing an embedding, computes one and persists it via
 *   `hoard.stashArtifact`. Uses `Promise.allSettled` so a single failure
 *   doesn't break the whole retrieval.
 * - Falls back to keyword retrieval if the query embed itself fails.
 */
export async function findRelevantArtifactsEmbedded(opts: {
  artifacts: Artifact[];
  queryText: string;
  limit: number;
  hoard: Hoard;
  now?: number;
  /** If true, blends embedding ranking with keyword ranking via RRF. Default true. */
  blendWithKeywords?: boolean;
}): Promise<Artifact[]> {
  const now = opts.now ?? Date.now();
  const blend = opts.blendWithKeywords ?? true;

  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embed(opts.queryText);
  } catch {
    queryEmbedding = null;
  }

  if (!queryEmbedding) {
    // pure keyword fallback
    const kw = extractKeywords(opts.queryText);
    return opts.artifacts
      .map((a) => ({ a, score: scoreArtifact(a, kw, now) }))
      .filter(({ score }) => score > 0.05)
      .sort((x, y) => y.score - x.score)
      .slice(0, opts.limit)
      .map(({ a }) => a);
  }

  // Lazily compute and persist any missing artifact embeddings.
  await Promise.allSettled(
    opts.artifacts
      .filter((a) => !a.embedding || a.embedding.length === 0)
      .map(async (a) => {
        try {
          const text = artifactRetrievalText(a);
          a.embedding = await embed(text);
          await opts.hoard.stashArtifact(a);
        } catch {
          // ignore — we'll just skip this one
        }
      }),
  );

  const scored = opts.artifacts
    .map((a) => ({ a, score: scoreEmbedded(a, queryEmbedding!, now) }))
    .filter(({ score }) => score > 0)
    .sort((x, y) => y.score - x.score);
  const embeddingRanked = scored.map(({ a }) => a);

  if (!blend) return embeddingRanked.slice(0, opts.limit);

  const kw = extractKeywords(opts.queryText);
  const keywordRanked = opts.artifacts
    .map((a) => ({ a, score: scoreArtifact(a, kw, now) }))
    .filter(({ score }) => score > 0.05)
    .sort((x, y) => y.score - x.score)
    .map(({ a }) => a);

  if (keywordRanked.length === 0) return embeddingRanked.slice(0, opts.limit);

  const fusedIds = mergeRanks([
    embeddingRanked.map((a) => ({ id: a.id })),
    keywordRanked.map((a) => ({ id: a.id })),
  ]);
  const byId = new Map(opts.artifacts.map((a) => [a.id, a] as const));
  const out: Artifact[] = [];
  for (const id of fusedIds) {
    const a = byId.get(id);
    if (a) out.push(a);
    if (out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Compose the text we embed for an artifact: task + claim texts + open
 * questions. Pure.
 */
export function artifactRetrievalText(a: Artifact): string {
  const parts: string[] = [a.task];
  for (const c of a.claims) parts.push(c.text);
  for (const q of a.openQuestions) parts.push(q);
  return parts.join("\n");
}
