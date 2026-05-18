import {
  readSentimentSecretsForRootSync,
  resolveSentimentSecret,
  sentimentSecretEnvForSource,
  sentimentSecretsPathForRoot,
  type SentimentSecretSource,
} from "./sentiment-secrets.js";

export type FetchLike = typeof fetch;

export interface SentimentSourceDefinition {
  id: string;
  label: string;
  kind: "baseline" | "attention" | "news" | "social" | "onchain" | "pro";
  free: "free" | "free-tier" | "optional-paid";
  secretEnv?: string;
  description: string;
}

export interface SentimentSourceStatus extends SentimentSourceDefinition {
  configured: boolean;
  enabledByDefault: boolean;
}

export interface SentimentSignal {
  source: string;
  kind: string;
  label: string;
  summary: string;
  value?: number;
  classification?: string;
  updatedAt?: string;
  url?: string;
}

export interface SentimentSummary {
  generatedAt: string;
  query?: string;
  signals: SentimentSignal[];
  sources: Array<{ id: string; ok: boolean; error?: string }>;
}

export interface SentimentFetchOptions {
  root?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}

export const SENTIMENT_SOURCES: SentimentSourceDefinition[] = [
  {
    id: "alternative-me",
    label: "Alternative.me Fear & Greed",
    kind: "baseline",
    free: "free",
    description: "No-key Bitcoin/large-crypto market sentiment baseline.",
  },
  {
    id: "gdelt",
    label: "GDELT DOC",
    kind: "news",
    free: "free",
    description: "No-key global news coverage and tone for project/team/entity queries.",
  },
  {
    id: "coingecko",
    label: "CoinGecko",
    kind: "attention",
    free: "free-tier",
    secretEnv: "COINGECKO_API_KEY",
    description: "Trending search attention and market context. Demo API key recommended.",
  },
  {
    id: "dune",
    label: "Dune",
    kind: "onchain",
    free: "free-tier",
    secretEnv: "DUNE_API_KEY",
    description: "Optional on-chain behavior and dashboard/query evidence.",
  },
  {
    id: "neynar",
    label: "Neynar / Farcaster",
    kind: "social",
    free: "free-tier",
    secretEnv: "NEYNAR_API_KEY",
    description: "Optional crypto-native Farcaster casts, profiles, and social graph context.",
  },
  {
    id: "santiment",
    label: "Santiment",
    kind: "social",
    free: "free-tier",
    secretEnv: "SANTIMENT_API_KEY",
    description: "Optional social, dev, on-chain, and sentiment metrics.",
  },
  {
    id: "cryptopanic",
    label: "CryptoPanic",
    kind: "news",
    free: "free-tier",
    secretEnv: "CRYPTOPANIC_AUTH_TOKEN",
    description: "Optional news aggregation and community vote sentiment.",
  },
  {
    id: "lunarcrush",
    label: "LunarCrush",
    kind: "pro",
    free: "optional-paid",
    secretEnv: "LUNARCRUSH_API_KEY",
    description: "Optional social intelligence if the user brings an API key.",
  },
];

export function sentimentSourcesPayload(
  root?: string,
  env: Record<string, string | undefined> = process.env,
): { localSecretsPath?: string; sources: SentimentSourceStatus[] } {
  const local = root ? readSentimentSecretsForRootSync(root) : {};
  return {
    ...(root ? { localSecretsPath: sentimentSecretsPathForRoot(root) } : {}),
    sources: SENTIMENT_SOURCES.map((source) => {
      const sourceKey = source.id as SentimentSecretSource;
      const envValue = source.secretEnv ? env[source.secretEnv]?.trim() : "";
      const localValue = sourceKey === "cryptopanic"
        ? local.cryptopanic?.authToken
        : local[sourceKey]?.apiKey;
      const configured = !source.secretEnv || !!envValue || !!localValue;
      return {
        ...source,
        configured,
        enabledByDefault: !source.secretEnv || configured,
      };
    }),
  };
}

export async function summarizeMarketSentiment(
  opts: SentimentFetchOptions = {},
): Promise<SentimentSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sources: SentimentSummary["sources"] = [];
  const signals: SentimentSignal[] = [];
  await collectSource(sources, signals, "alternative-me", () => fetchFearGreed(fetchImpl));
  await collectSource(sources, signals, "coingecko", () => fetchCoinGeckoTrending(fetchImpl, sourceSecret(opts, "coingecko")));
  return {
    generatedAt: new Date().toISOString(),
    signals,
    sources,
  };
}

export async function summarizeProjectSentiment(
  query: string,
  opts: SentimentFetchOptions = {},
): Promise<SentimentSummary> {
  const cleanQuery = query.trim();
  if (!cleanQuery) throw new Error("query is required");
  const market = await summarizeMarketSentiment(opts);
  const signals = [...market.signals];
  const sources = [...market.sources];
  await collectSource(sources, signals, "gdelt", () => fetchGdeltNewsTone(cleanQuery, opts.fetchImpl ?? fetch));
  return {
    generatedAt: new Date().toISOString(),
    query: cleanQuery,
    signals,
    sources,
  };
}

async function collectSource(
  sources: SentimentSummary["sources"],
  signals: SentimentSignal[],
  id: string,
  fn: () => Promise<SentimentSignal | undefined>,
): Promise<void> {
  try {
    const signal = await fn();
    if (signal) signals.push(signal);
    sources.push({ id, ok: true });
  } catch (err) {
    sources.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function fetchFearGreed(fetchImpl: FetchLike): Promise<SentimentSignal | undefined> {
  const json = await fetchJson(fetchImpl, "https://api.alternative.me/fng/?limit=1&format=json");
  const first = Array.isArray(json.data) ? json.data[0] as Record<string, unknown> : undefined;
  if (!first) return undefined;
  const value = Number(first.value);
  const classification = typeof first.value_classification === "string"
    ? first.value_classification
    : undefined;
  const timestamp = typeof first.timestamp === "string" ? Number(first.timestamp) : undefined;
  return {
    source: "alternative-me",
    kind: "market-baseline",
    label: "Crypto Fear & Greed",
    value: Number.isFinite(value) ? value : undefined,
    classification,
    updatedAt: timestamp ? new Date(timestamp * 1000).toISOString() : undefined,
    url: "https://alternative.me/crypto/fear-and-greed-index/",
    summary: `Market baseline is ${classification ?? "unknown"}${Number.isFinite(value) ? ` (${value}/100)` : ""}.`,
  };
}

async function fetchCoinGeckoTrending(
  fetchImpl: FetchLike,
  apiKey?: string,
): Promise<SentimentSignal | undefined> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;
  const json = await fetchJson(fetchImpl, "https://api.coingecko.com/api/v3/search/trending", headers);
  const coins = Array.isArray(json.coins) ? json.coins : [];
  const names = coins
    .map((row) => {
      const item = row && typeof row === "object" ? (row as Record<string, unknown>).item : undefined;
      if (!item || typeof item !== "object") return "";
      const rec = item as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name : "";
      const symbol = typeof rec.symbol === "string" ? rec.symbol : "";
      return symbol ? `${name} (${symbol})` : name;
    })
    .filter(Boolean)
    .slice(0, 5);
  return {
    source: "coingecko",
    kind: "search-attention",
    label: "CoinGecko trending searches",
    value: names.length,
    url: "https://www.coingecko.com/en/discover",
    summary: names.length
      ? `Trending attention: ${names.join(", ")}.`
      : "No CoinGecko trending coins returned.",
  };
}

async function fetchGdeltNewsTone(query: string, fetchImpl: FetchLike): Promise<SentimentSignal | undefined> {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("timespan", "7d");
  url.searchParams.set("maxrecords", "25");
  url.searchParams.set("sort", "datedesc");
  const json = await fetchJson(fetchImpl, url.toString());
  const articles = Array.isArray(json.articles) ? json.articles : [];
  const tones = articles
    .map((row) => (row && typeof row === "object" ? Number((row as Record<string, unknown>).tone) : NaN))
    .filter((value) => Number.isFinite(value));
  const averageTone = tones.length
    ? Number((tones.reduce((sum, value) => sum + value, 0) / tones.length).toFixed(3))
    : undefined;
  return {
    source: "gdelt",
    kind: "news-tone",
    label: "GDELT news tone",
    value: averageTone,
    url: "https://www.gdeltproject.org/",
    summary: `${articles.length} articles in the last 7d${averageTone !== undefined ? `; average tone ${averageTone}` : ""}.`,
  };
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as Record<string, unknown>;
}

function sourceSecret(
  opts: SentimentFetchOptions,
  source: SentimentSecretSource,
): string | undefined {
  if (!opts.root) return opts.env?.[sentimentSecretEnvForSource(source)]?.trim();
  return resolveSentimentSecret(opts.root, source, opts.env);
}
