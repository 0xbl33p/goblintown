import { createSolanaTools } from "./solana-tools.js";
import { builtinTools, type ToolDefinition } from "./tools.js";
import type { AddonConfig, WarrenManifest } from "./types.js";

export interface AddonDefinition {
  id: string;
  label: string;
  description: string;
  aliases: string[];
  toolNames: string[];
}

export const availableAddons: AddonDefinition[] = [
  {
    id: "onchain-solana",
    label: "Onchain: Solana",
    description: "Read-only Solana investigator tools for address profiles, activity, transactions, tokens, balances, accounts, signatures, and RPC health.",
    aliases: ["solana"],
    toolNames: [
      "solana.profile",
      "solana.activity",
      "solana.transaction",
      "solana.token",
      "solana.balance",
      "solana.account",
      "solana.tokens",
      "solana.signatures",
      "solana.rpcHealth",
    ],
  },
];

export function normalizeAddonId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  for (const addon of availableAddons) {
    if (addon.id === value || addon.aliases.includes(value)) return addon.id;
  }
  return null;
}

export function normalizeAddonSettings(raw: unknown): Record<string, AddonConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, AddonConfig> = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = normalizeAddonId(key);
    if (!id || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const config = sanitizeAddonConfig(row.config);
    out[id] = {
      enabled: row.enabled === true,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
  }
  return out;
}

export function setAddonEnabled(
  manifest: WarrenManifest,
  idOrAlias: string,
  enabled: boolean,
): boolean {
  const id = normalizeAddonId(idOrAlias);
  if (!id) return false;
  const current = normalizeAddonSettings(manifest.addons);
  current[id] = {
    ...(current[id] ?? {}),
    enabled,
  };
  manifest.addons = current;
  return true;
}

export function isAddonEnabled(
  manifest: WarrenManifest,
  idOrAlias: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const id = normalizeAddonId(idOrAlias);
  if (!id) return false;
  if (id === "onchain-solana" && (env.GOBLINTOWN_ADDON_SOLANA === "1" || env.GOBLINTOWN_TOOLS_SOLANA === "1")) {
    return true;
  }
  return normalizeAddonSettings(manifest.addons)[id]?.enabled === true;
}

export function buildToolRegistry(
  manifest: WarrenManifest,
  env: NodeJS.ProcessEnv = process.env,
): ToolDefinition[] {
  const tools = [...builtinTools];
  if (isAddonEnabled(manifest, "onchain-solana", env)) {
    tools.push(...createSolanaTools({
      enabled: true,
      rpcUrl: env.GOBLINTOWN_SOLANA_RPC_URL,
    }));
  }
  return tools;
}

export function addonStatusPayload(
  manifest: WarrenManifest,
  env: NodeJS.ProcessEnv = process.env,
): {
  addons: Array<AddonDefinition & { enabled: boolean }>;
} {
  return {
    addons: availableAddons.map((addon) => ({
      ...addon,
      enabled: isAddonEnabled(manifest, addon.id, env),
    })),
  };
}

function sanitizeAddonConfig(raw: unknown): Record<string, string | number | boolean> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}
