import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSentimentSecretForRoot,
  readSentimentSecretsForRootSync,
  resolveSentimentSecret,
  sentimentSecretsPathForRoot,
  setSentimentSecretForRoot,
} from "../sentiment-secrets.js";
import {
  SENTIMENT_SOURCES,
  sentimentSourcesPayload,
  summarizeMarketSentiment,
  summarizeProjectSentiment,
} from "../sentiment.js";

describe("sentiment sources", () => {
  it("ships no-key baseline sources and optional keyed sources", () => {
    assert.ok(SENTIMENT_SOURCES.some((s) => s.id === "alternative-me" && !s.secretEnv));
    assert.ok(SENTIMENT_SOURCES.some((s) => s.id === "gdelt" && !s.secretEnv));
    assert.ok(SENTIMENT_SOURCES.some((s) => s.id === "coingecko" && s.secretEnv === "COINGECKO_API_KEY"));
    assert.ok(SENTIMENT_SOURCES.some((s) => s.id === "neynar" && s.secretEnv === "NEYNAR_API_KEY"));
    assert.ok(SENTIMENT_SOURCES.some((s) => s.id === "dune" && s.secretEnv === "DUNE_API_KEY"));
  });

  it("stores sentiment secrets locally with 0600 permissions and never exposes raw values", async () => {
    const root = mkdtempSync(join(tmpdir(), "goblin-sentiment-"));
    await setSentimentSecretForRoot(root, "neynar", "ny_test");
    const path = sentimentSecretsPathForRoot(root);
    assert.equal(readSentimentSecretsForRootSync(root).neynar?.apiKey, "ny_test");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.match(readFileSync(path, "utf8"), /"sentiment"/);

    const payload = sentimentSourcesPayload(root, {});
    assert.ok(payload.sources.find((s) => s.id === "neynar")?.configured);
    assert.doesNotMatch(JSON.stringify(payload), /ny_test/);
  });

  it("prefers environment keys over local sentiment secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "goblin-sentiment-"));
    await setSentimentSecretForRoot(root, "coingecko", "local_key");
    assert.equal(
      resolveSentimentSecret(root, "coingecko", { COINGECKO_API_KEY: "env_key" }),
      "env_key",
    );
    await clearSentimentSecretForRoot(root, "coingecko");
    assert.equal(readSentimentSecretsForRootSync(root).coingecko, undefined);
  });

  it("summarizes no-key market sentiment and CoinGecko attention", async () => {
    const result = await summarizeMarketSentiment({
      fetchImpl: fakeFetch({
        "api.alternative.me/fng": {
          name: "Fear and Greed Index",
          data: [{ value: "27", value_classification: "Fear", timestamp: "1710000000" }],
        },
        "api.coingecko.com/api/v3/search/trending": {
          coins: [
            { item: { id: "solana", name: "Solana", symbol: "SOL", score: 0 } },
            { item: { id: "jito", name: "Jito", symbol: "JTO", score: 1 } },
          ],
        },
      }),
    });

    assert.equal(result.signals.find((s) => s.source === "alternative-me")?.value, 27);
    assert.match(result.signals.find((s) => s.source === "coingecko")?.summary ?? "", /Solana/);
  });

  it("summarizes project news tone with GDELT", async () => {
    const result = await summarizeProjectSentiment("Goblintown", {
      fetchImpl: fakeFetch({
        "api.alternative.me/fng": {
          data: [{ value: "50", value_classification: "Neutral", timestamp: "1710000000" }],
        },
        "api.coingecko.com/api/v3/search/trending": { coins: [] },
        "api.gdeltproject.org/api/v2/doc/doc": {
          articles: [
            { title: "Goblintown ships collaboration backend", url: "https://example.test/a", tone: 1.5, domain: "example.test" },
            { title: "Goblintown thesis engine criticized", url: "https://example.test/b", tone: -0.5, domain: "example.test" },
          ],
        },
      }),
    });

    const gdelt = result.signals.find((s) => s.source === "gdelt");
    assert.equal(gdelt?.kind, "news-tone");
    assert.equal(gdelt?.value, 0.5);
    assert.match(gdelt?.summary ?? "", /2 articles/);
  });
});

function fakeFetch(payloads: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const text = String(url);
    const key = Object.keys(payloads).find((needle) => text.includes(needle));
    if (!key) throw new Error(`unexpected fetch ${text}`);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      async json() {
        return payloads[key];
      },
      async text() {
        return JSON.stringify(payloads[key]);
      },
    } as Response;
  }) as typeof fetch;
}
