export type CreatureKind =
  | "goblin"
  | "gremlin"
  | "raccoon"
  | "troll"
  | "ogre"
  | "pigeon";

export const CREATURE_KINDS: CreatureKind[] = [
  "goblin",
  "gremlin",
  "raccoon",
  "troll",
  "ogre",
  "pigeon",
];

export type Personality =
  | "nerdy"
  | "cynical"
  | "chipper"
  | "stoic"
  | "feral";

export interface Creature {
  kind: CreatureKind;
  model: string;
  temperature: number;
  personality: Personality;
  systemPrompt: string;
}

export interface DriftReport {
  creatureMentions: Record<CreatureKind, number>;
  totalCreatureWords: number;
  outputWordCount: number;
  driftRate: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}

export interface Loot {
  id: string;
  questId?: string;
  riteId?: string;
  creatureKind: CreatureKind;
  personality: Personality;
  model: string;
  prompt: string;
  output: string;
  reward?: number;
  parentLootIds?: string[];
  timestamp: number;
  drift: DriftReport;
  usage?: TokenUsage;
}

export interface TrollVerdict {
  lootId: string;
  passed: boolean;
  score: number;
  critique: string;
}

export interface Quest {
  id: string;
  task: string;
  packSize: number;
  personality: Personality;
  lootIds: string[];
  trollVerdicts: Record<string, TrollVerdict>;
  winnerLootId?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface Rite {
  id: string;
  task: string;
  scanGlobs: string[];
  packSize: number;
  personality: Personality;
  contextLootId?: string;
  goblinLootIds: string[];
  chaosLootIds: Record<string, string>;
  trollVerdicts: Record<string, TrollVerdict>;
  ogreLootId?: string;
  winnerLootId?: string;
  outcome: "winner" | "ogre_fallback" | "all_failed";
  startedAt: number;
  finishedAt?: number;
}

export interface InboxMessage {
  id: string;
  fromWarren: string;
  audience: string;
  body: string;
  signature: string;
  sourceLootId: string;
  receivedAt: number;
}

export interface OutboxRecord {
  id: string;
  toWarren: string;
  audience: string;
  sourceLootId: string;
  pigeonLootId: string;
  signature: string;
  sentAt: number;
}

export interface WarrenManifest {
  name: string;
  version: number;
  createdAt: string;
  defaultModelGoblin: string;
  defaultModelOgre: string;
  defaultModelTroll: string;
  /** Optional shared secret for HMAC-authenticated federation. */
  peerSecret?: string;
  /** Storage backend. Defaults to "json". Override with GOBLINTOWN_STORAGE. */
  storage?: "json" | "sqlite";
}
