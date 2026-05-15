import {
  CREATURE_KINDS,
  type CountryJoinRequest,
  type CountryQueuedRite,
  type CountryConfig,
  type CreatureKind,
  type OutputFormat,
  type Personality,
  type WarrenPeer,
} from "./types.js";

export const MAX_TEAM_MEMBERS = 6;
export const MAX_PEERS = MAX_TEAM_MEMBERS - 1;
const MAX_PENDING_JOIN_REQUESTS = 64;
const MAX_QUEUED_RITES = 64;

export const COUNTRY_NAME_POOL = [
  "Amber Hollow",
  "Moss Lantern",
  "Iron Burrow",
  "Moon Warren",
  "Cinder Glen",
  "Thistle Reach",
  "Echo Fen",
  "Bramble Keep",
  "Rootforge",
  "Night Vale",
  "Soot Harbor",
  "Rune Hollow",
  "Frost Burrow",
  "Copper Fern",
  "Mistbridge",
  "Hearth Den",
];

const COUNTRY_ADJECTIVES = [
  "Amber",
  "Ashen",
  "Brass",
  "Cinder",
  "Copper",
  "Ember",
  "Frost",
  "Gloom",
  "Hollow",
  "Iron",
  "Ivory",
  "Lumen",
  "Mist",
  "Moss",
  "Night",
  "Obsidian",
  "Riven",
  "Root",
  "Rune",
  "Sable",
  "Shadow",
  "Smoke",
  "Thistle",
  "Umber",
  "Verdant",
  "Warden",
];

const COUNTRY_NOUNS = [
  "Basin",
  "Bastion",
  "Burrow",
  "Cairn",
  "Citadel",
  "Crossing",
  "Den",
  "Fen",
  "Forge",
  "Glen",
  "Harbor",
  "Hollow",
  "Keep",
  "March",
  "Moor",
  "Reach",
  "Refuge",
  "Sanctum",
  "Spire",
  "Vale",
  "Warren",
  "Watch",
  "Way",
  "Yard",
];

export interface CountryDispatchRequest {
  task: string;
  packSize: number;
  scanGlobs: string[];
  personality?: Personality;
  budgetTokens?: number;
  maxOutputTokens?: number;
  outputFormat?: OutputFormat;
}

export interface CountryDispatchResult {
  peer: WarrenPeer;
  runId: string;
  done: boolean;
  outcome?: string;
  finalRiteId?: string;
  error?: string;
}

interface RemoteRunRecord {
  done: boolean;
  outcome?: string;
  finalRiteId?: string;
  error?: string;
}

export function normalizeWarrenPeers(value: unknown): WarrenPeer[] {
  if (!Array.isArray(value)) return [];
  const out: WarrenPeer[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const peer = normalizeWarrenPeer(item);
    if (!peer) continue;
    const key = peer.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(peer);
  }
  return out.slice(0, MAX_PEERS);
}

export function normalizeWarrenPeer(value: unknown): WarrenPeer | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const name = normalizeName(input.name);
  const url = normalizeUrl(input.url);
  if (!name || !url) return null;
  const createdAt =
    typeof input.createdAt === "string" && input.createdAt.length > 0
      ? input.createdAt
      : new Date().toISOString();
  const note = typeof input.note === "string" ? input.note.trim() : undefined;
  return { name, url, createdAt, ...(note ? { note } : {}) };
}

export function normalizeCountryConfig(value: unknown): CountryConfig {
  const input =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const roleOwners = normalizeRoleOwners(input.roleOwners);
  const collabBackend = input.collabBackend === "firebase" ? "firebase" : "local";
  const countryId = normalizeCountryId(input.countryId);
  const countryName = normalizeCountryName(input.countryName);
  const countryCode = normalizeCountryCode(input.countryCode);
  const leaderPublicKey = normalizePemKey(input.leaderPublicKey);
  const pendingJoinRequests = normalizeJoinRequests(input.pendingJoinRequests);
  const riteQueue = normalizeRiteQueue(input.riteQueue);
  return {
    collabBackend,
    enabled: input.enabled === true,
    ...(countryId ? { countryId } : {}),
    ...(countryName ? { countryName } : {}),
    ...(countryCode ? { countryCode } : {}),
    ...(leaderPublicKey ? { leaderPublicKey } : {}),
    discoverable: input.discoverable !== false,
    roleOwners,
    autoAssignLeadExtras: input.autoAssignLeadExtras !== false,
    ...(pendingJoinRequests.length > 0 ? { pendingJoinRequests } : {}),
    ...(riteQueue.length > 0 ? { riteQueue } : {}),
  };
}

export function resolveRoleOwners(
  cfg: CountryConfig | undefined,
  memberNames: string[],
  leadName: string,
): Record<CreatureKind, string> {
  const config = normalizeCountryConfig(cfg);
  const allowed = new Set(memberNames.map((m) => m.toLowerCase()));
  const lead = allowed.has(leadName.toLowerCase()) ? leadName : memberNames[0] || leadName;
  const out = {} as Record<CreatureKind, string>;
  for (const role of CREATURE_KINDS) {
    const raw = config.roleOwners?.[role];
    if (raw && allowed.has(raw.toLowerCase())) {
      out[role] = memberNames.find((m) => m.toLowerCase() === raw.toLowerCase()) || lead;
      continue;
    }
    out[role] = config.autoAssignLeadExtras === false ? "" : lead;
  }
  return out;
}

export function selectPeers(
  peers: WarrenPeer[],
  refs: string[] = [],
): { selected: WarrenPeer[]; missing: string[] } {
  if (refs.length === 0) return { selected: peers, missing: [] };
  const byName = new Map(peers.map((p) => [p.name.toLowerCase(), p] as const));
  const byUrl = new Map(peers.map((p) => [p.url, p] as const));
  const selected: WarrenPeer[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const normalizedUrl = normalizeUrl(ref);
    const found =
      byName.get(ref.toLowerCase()) ||
      (normalizedUrl ? byUrl.get(normalizedUrl) : undefined);
    if (!found) {
      missing.push(raw);
      continue;
    }
    if (seen.has(found.name.toLowerCase())) continue;
    seen.add(found.name.toLowerCase());
    selected.push(found);
  }
  return { selected, missing };
}

export async function dispatchRiteToPeer(
  peer: WarrenPeer,
  req: CountryDispatchRequest,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<CountryDispatchResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const pollMs = opts.pollMs ?? 1_000;
  const start = await fetch(`${peer.url}/api/rite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: req.task,
      packSize: req.packSize,
      scanGlobs: req.scanGlobs,
      personality: req.personality,
      budgetTokens: req.budgetTokens,
      maxOutputTokens: req.maxOutputTokens,
      outputFormat: req.outputFormat,
    }),
  });
  if (!start.ok) {
    const body = await start.text().catch(() => "");
    throw new Error(
      `${peer.name}: start failed (${start.status} ${start.statusText}) ${truncate(body, 140)}`,
    );
  }
  const startBody = (await start.json()) as { runId?: string };
  if (!startBody.runId) {
    throw new Error(`${peer.name}: start response missing runId`);
  }
  const runId = startBody.runId;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${peer.url}/api/runs/${runId}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `${peer.name}: polling failed (${res.status} ${res.statusText}) ${truncate(body, 140)}`,
      );
    }
    const run = (await res.json()) as RemoteRunRecord;
    if (run.done) {
      return {
        peer,
        runId,
        done: true,
        outcome: run.outcome,
        finalRiteId: run.finalRiteId,
        error: run.error,
      };
    }
    await sleep(pollMs);
  }
  throw new Error(`${peer.name}: timeout waiting for run ${runId}`);
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) return null;
  return name;
}

export function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) return null;
  return code;
}

export function normalizeCountryName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name.length < 3 || name.length > 64) return null;
  return name;
}

export function normalizeCountryId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{6,64}$/.test(id)) return null;
  return id;
}

export function makeCountryCode(seed = Date.now()): string {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let x = Math.abs(Math.floor(seed)) || 1;
  let out = "";
  for (let i = 0; i < 5; i++) {
    x = (x * 48271) % 0x7fffffff;
    out += alpha[x % alpha.length];
  }
  return out;
}

function makeCountryNameSigil(seed = Date.now()): string {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let x = Math.abs(Math.floor(seed)) || 1;
  let out = "";
  for (let i = 0; i < 3; i++) {
    x = (x * 69621 + 1013904223) % 0x7fffffff;
    out += alpha[x % alpha.length];
  }
  return out;
}

export function makeCountryName(
  existingNames: Iterable<string> = [],
  seed = Date.now() + Math.floor(Math.random() * 1_000_000),
): string {
  const taken = new Set(
    [...existingNames]
      .map((n) => String(n || "").trim().toLowerCase())
      .filter(Boolean),
  );
  for (let i = 0; i < 512; i++) {
    const x = seed + i * 7919;
    const adj = COUNTRY_ADJECTIVES[Math.abs((x * 48271) % COUNTRY_ADJECTIVES.length)];
    const noun = COUNTRY_NOUNS[Math.abs((x * 40699 + 17) % COUNTRY_NOUNS.length)];
    const base = `${adj} ${noun}`;
    const name = `${base} ${makeCountryNameSigil(x + 911)}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return `${COUNTRY_NAME_POOL[Math.floor(Math.random() * COUNTRY_NAME_POOL.length)]} ${makeCountryNameSigil(seed)}`;
}

export function sampleOpenCountries<T extends { memberCount: number }>(
  list: T[],
  limit = 10,
): T[] {
  const open = list.filter((c) => c.memberCount <= 3);
  for (let i = open.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [open[i], open[j]] = [open[j], open[i]];
  }
  return open.slice(0, limit);
}

function normalizeRoleOwners(value: unknown): Partial<Record<CreatureKind, string>> {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const out: Partial<Record<CreatureKind, string>> = {};
  for (const role of CREATURE_KINDS) {
    const owner = typeof input[role] === "string" ? input[role].trim() : "";
    if (owner) out[role] = owner;
  }
  return out;
}

function normalizeJoinRequests(value: unknown): CountryJoinRequest[] {
  if (!Array.isArray(value)) return [];
  const out: CountryJoinRequest[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const countryId = normalizeCountryId(r.countryId);
    const countryCode = normalizeCountryCode(r.countryCode);
    const fromName = normalizeName(r.fromName);
    const fromUrl = normalizeUrl(r.fromUrl);
    const fromPublicKey = normalizePemKey(r.fromPublicKey);
    const createdAt = typeof r.createdAt === "string" ? r.createdAt : "";
    const signature = typeof r.signature === "string" ? r.signature.trim() : "";
    if (
      !id || seen.has(id) || !countryId || !countryCode || !fromName || !fromUrl ||
      !fromPublicKey || !createdAt || !signature
    ) continue;
    seen.add(id);
    out.push({
      id,
      countryId,
      countryCode,
      fromName,
      fromUrl,
      fromPublicKey,
      createdAt,
      signature,
    });
    if (out.length >= MAX_PENDING_JOIN_REQUESTS) break;
  }
  return out;
}

function normalizeRiteQueue(value: unknown): CountryQueuedRite[] {
  if (!Array.isArray(value)) return [];
  const out: CountryQueuedRite[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const mode = r.mode === "plan" ? "plan" : r.mode === "rite" ? "rite" : null;
    const task = typeof r.task === "string" ? r.task.trim() : "";
    const createdAt = typeof r.createdAt === "number" ? r.createdAt : 0;
    if (!id || seen.has(id) || !mode || !task || !Number.isFinite(createdAt)) continue;
    seen.add(id);
    out.push({ id, mode, task, createdAt });
    if (out.length >= MAX_QUEUED_RITES) break;
  }
  return out;
}

function normalizePemKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key.includes("BEGIN PUBLIC KEY")) return null;
  if (key.length > 8192) return null;
  return key;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
