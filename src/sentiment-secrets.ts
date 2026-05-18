import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WARREN_DIRNAME = ".goblintown";
const SECRETS_FILE = "secrets.json";

export type SentimentSecretSource =
  | "coingecko"
  | "dune"
  | "neynar"
  | "santiment"
  | "cryptopanic"
  | "lunarcrush";

export interface SentimentSecretValue {
  apiKey?: string;
  authToken?: string;
}

export type SentimentSecrets = Partial<Record<SentimentSecretSource, SentimentSecretValue>>;

interface GoblintownSecretsPayload {
  sentiment?: SentimentSecrets;
}

const SOURCE_ENV: Record<SentimentSecretSource, string> = {
  coingecko: "COINGECKO_API_KEY",
  dune: "DUNE_API_KEY",
  neynar: "NEYNAR_API_KEY",
  santiment: "SANTIMENT_API_KEY",
  cryptopanic: "CRYPTOPANIC_AUTH_TOKEN",
  lunarcrush: "LUNARCRUSH_API_KEY",
};

export function sentimentSecretsPathForRoot(root: string): string {
  return join(root, WARREN_DIRNAME, SECRETS_FILE);
}

export function readSentimentSecretsForRootSync(root: string): SentimentSecrets {
  const path = sentimentSecretsPathForRoot(root);
  if (!existsSync(path)) return {};
  try {
    return normalizeSecrets(
      (JSON.parse(readFileSync(path, "utf8")) as GoblintownSecretsPayload).sentiment,
    );
  } catch {
    return {};
  }
}

export async function setSentimentSecretForRoot(
  root: string,
  source: string,
  secret: string,
): Promise<void> {
  const sourceId = normalizeSentimentSecretSource(source);
  const value = secret.trim();
  if (!sourceId || !value) return;
  const dir = join(root, WARREN_DIRNAME);
  await mkdir(dir, { recursive: true });
  const path = sentimentSecretsPathForRoot(root);
  const current = await readSecretsPayload(path);
  const field = sourceId === "cryptopanic" ? "authToken" : "apiKey";
  current.sentiment = {
    ...normalizeSecrets(current.sentiment),
    [sourceId]: { [field]: value },
  };
  await writeSecretsPayload(path, current);
}

export async function clearSentimentSecretForRoot(
  root: string,
  source: string,
): Promise<void> {
  const sourceId = normalizeSentimentSecretSource(source);
  if (!sourceId) return;
  const path = sentimentSecretsPathForRoot(root);
  const current = await readSecretsPayload(path);
  const sentiment = normalizeSecrets(current.sentiment);
  delete sentiment[sourceId];
  current.sentiment = sentiment;
  if (Object.keys(sentiment).length === 0) {
    delete current.sentiment;
  }
  if (Object.keys(current).length === 0) {
    await rm(path, { force: true }).catch(() => {});
    return;
  }
  await writeSecretsPayload(path, current);
}

export function resolveSentimentSecret(
  root: string,
  source: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const sourceId = normalizeSentimentSecretSource(source);
  if (!sourceId) return undefined;
  const envName = SOURCE_ENV[sourceId];
  const envValue = env[envName]?.trim();
  if (envValue) return envValue;
  const local = readSentimentSecretsForRootSync(root)[sourceId];
  return sourceId === "cryptopanic" ? local?.authToken : local?.apiKey;
}

export function normalizeSentimentSecretSource(value: unknown): SentimentSecretSource | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/_/g, "-");
  if (key === "alternative-me" || key === "alternative" || key === "gdelt") return null;
  if (key === "coin-gecko") return "coingecko";
  if (key === "crypto-panic") return "cryptopanic";
  if (isSentimentSecretSource(key)) return key;
  return null;
}

export function sentimentSecretEnvForSource(source: SentimentSecretSource): string {
  return SOURCE_ENV[source];
}

async function readSecretsPayload(path: string): Promise<GoblintownSecretsPayload> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as GoblintownSecretsPayload;
  } catch {
    return {};
  }
}

async function writeSecretsPayload(path: string, payload: GoblintownSecretsPayload): Promise<void> {
  await writeFile(path, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600).catch(() => {});
}

function normalizeSecrets(value: unknown): SentimentSecrets {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: SentimentSecrets = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const source = normalizeSentimentSecretSource(rawKey);
    if (!source || !rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) continue;
    const row = rawValue as Record<string, unknown>;
    const apiKey = typeof row.apiKey === "string" ? row.apiKey.trim() : "";
    const authToken = typeof row.authToken === "string" ? row.authToken.trim() : "";
    if (apiKey || authToken) {
      out[source] = {
        ...(apiKey ? { apiKey } : {}),
        ...(authToken ? { authToken } : {}),
      };
    }
  }
  return out;
}

function isSentimentSecretSource(value: string): value is SentimentSecretSource {
  return Object.prototype.hasOwnProperty.call(SOURCE_ENV, value);
}
