import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const WARREN_DIRNAME = ".goblintown";
const MANIFEST_FILE = "warren.json";
const PROVIDER_SECRETS_FILE = "provider-secrets.json";

interface ProviderSecretsPayload {
  apiKeys?: Record<string, string>;
}

export function readProviderSecretsForRootSync(root: string): Record<string, string> {
  const path = providerSecretsPathForRoot(root);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ProviderSecretsPayload;
    return normalizeApiKeys(raw.apiKeys);
  } catch {
    return {};
  }
}

export function readProviderSecretsFromCwdSync(cwd = process.cwd()): Record<string, string> {
  const root = findWarrenRootSync(cwd);
  if (!root) return {};
  return readProviderSecretsForRootSync(root);
}

export async function setProviderSecretForRoot(
  root: string,
  apiKeyEnv: string,
  apiKey: string,
): Promise<void> {
  if (!isEnvName(apiKeyEnv)) return;
  const dir = join(root, WARREN_DIRNAME);
  await mkdir(dir, { recursive: true });
  const path = providerSecretsPathForRoot(root);
  const current = await readProviderSecretsForRoot(root);
  current[apiKeyEnv] = apiKey;
  await writeProviderSecrets(path, current);
}

export async function clearProviderSecretForRoot(
  root: string,
  apiKeyEnv: string,
): Promise<void> {
  if (!isEnvName(apiKeyEnv)) return;
  const path = providerSecretsPathForRoot(root);
  const current = await readProviderSecretsForRoot(root);
  if (!(apiKeyEnv in current)) return;
  delete current[apiKeyEnv];
  if (Object.keys(current).length === 0) {
    await rm(path, { force: true }).catch(() => {});
    return;
  }
  await writeProviderSecrets(path, current);
}

export function providerSecretsPathForRoot(root: string): string {
  return join(root, WARREN_DIRNAME, PROVIDER_SECRETS_FILE);
}

async function readProviderSecretsForRoot(root: string): Promise<Record<string, string>> {
  const path = providerSecretsPathForRoot(root);
  try {
    const raw = JSON.parse(
      await readFile(path, "utf8"),
    ) as ProviderSecretsPayload;
    return normalizeApiKeys(raw.apiKeys);
  } catch {
    return {};
  }
}

async function writeProviderSecrets(
  path: string,
  apiKeys: Record<string, string>,
): Promise<void> {
  const payload: ProviderSecretsPayload = { apiKeys };
  await writeFile(path, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600).catch(() => {});
}

function normalizeApiKeys(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!isEnvName(k) || typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    out[k] = trimmed;
  }
  return out;
}

function isEnvName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value);
}

function findWarrenRootSync(start: string): string | null {
  let cur = start;
  while (true) {
    const candidate = join(cur, WARREN_DIRNAME, MANIFEST_FILE);
    if (existsSync(candidate)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
