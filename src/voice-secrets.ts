import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WARREN_DIRNAME = ".goblintown";
const VOICE_SECRETS_FILE = "voice-secrets.json";

interface VoiceSecretsPayload {
  apiKeys?: Record<string, string>;
}

export function readVoiceSecretsForRootSync(root: string): Record<string, string> {
  const path = voiceSecretsPathForRoot(root);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as VoiceSecretsPayload;
    return normalizeApiKeys(raw.apiKeys);
  } catch {
    return {};
  }
}

export async function setVoiceSecretForRoot(
  root: string,
  apiKeyEnv: string,
  apiKey: string,
): Promise<void> {
  if (!isEnvName(apiKeyEnv)) return;
  await mkdir(join(root, WARREN_DIRNAME), { recursive: true });
  const path = voiceSecretsPathForRoot(root);
  const current = await readVoiceSecretsForRoot(root);
  current[apiKeyEnv] = apiKey;
  await writeVoiceSecrets(path, current);
}

export async function clearVoiceSecretForRoot(
  root: string,
  apiKeyEnv: string,
): Promise<void> {
  if (!isEnvName(apiKeyEnv)) return;
  const path = voiceSecretsPathForRoot(root);
  const current = await readVoiceSecretsForRoot(root);
  if (!(apiKeyEnv in current)) return;
  delete current[apiKeyEnv];
  if (Object.keys(current).length === 0) {
    await rm(path, { force: true }).catch(() => {});
    return;
  }
  await writeVoiceSecrets(path, current);
}

export function voiceSecretsPathForRoot(root: string): string {
  return join(root, WARREN_DIRNAME, VOICE_SECRETS_FILE);
}

async function readVoiceSecretsForRoot(root: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(
      await readFile(voiceSecretsPathForRoot(root), "utf8"),
    ) as VoiceSecretsPayload;
    return normalizeApiKeys(raw.apiKeys);
  } catch {
    return {};
  }
}

async function writeVoiceSecrets(
  path: string,
  apiKeys: Record<string, string>,
): Promise<void> {
  await writeFile(path, JSON.stringify({ apiKeys }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600).catch(() => {});
}

function normalizeApiKeys(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isEnvName(key) || typeof raw !== "string") continue;
    const value = raw.trim();
    if (value) out[key] = value;
  }
  return out;
}

function isEnvName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value);
}
