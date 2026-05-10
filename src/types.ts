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
  modelSlot?: ModelSlot;
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
  /** Specialist-recovery loot ids (Phase 2). */
  specialistLootIds?: string[];
  /** Verdicts for specialist outputs (keyed by specialist loot id). */
  specialistVerdicts?: Record<string, TrollVerdict>;
  outcome: "winner" | "specialist_recovery" | "ogre_fallback" | "all_failed";
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

export interface FriendRecord {
  id: string;
  name: string;
  url: string;
  publicKey: string;
  createdAt: string;
  note?: string;
}

export interface FriendRequest {
  id: string;
  fromName: string;
  fromUrl: string;
  fromPublicKey: string;
  toName: string;
  toUrl: string;
  createdAt: string;
  signature: string;
}

export interface DirectMessage {
  id: string;
  threadId: string;
  fromName: string;
  fromUrl: string;
  fromPublicKey: string;
  toName: string;
  toUrl: string;
  body: string;
  createdAt: string;
  signature: string;
  readAt?: string;
}

export interface DirectMessageThread {
  id: string;
  participantA: string;
  participantB: string;
  updatedAt: string;
  lastMessagePreview: string;
}

/**
 * An Artifact is a typed, structured summary of what a Rite established.
 * Stored separately from raw Loot so that future rites can load just the
 * distilled findings without re-reading every prompt/output.
 */
export interface Artifact {
  /** Stable id derived from rite id + content hash. */
  id: string;
  riteId: string;
  task: string;
  outcome: Rite["outcome"];
  /** Pointer to the winning loot (whose output the artifact distills). */
  winnerLootId?: string;

  /** Things this rite established. */
  claims: ArtifactClaim[];
  /** Pointers to evidence backing the claims. */
  evidence: ArtifactEvidence[];
  /** Things the rite identified but didn't resolve. */
  openQuestions: string[];
  /** Suggested follow-up rites. */
  nextSteps: string[];

  /** Other artifacts this rite built on (parent → child memory chain). */
  parentArtifactIds: string[];

  /** Keywords for v1 retrieval. */
  keywords: string[];
  /** Optional embedding for v2 retrieval. */
  embedding?: number[];

  timestamp: number;
}

export interface ArtifactClaim {
  text: string;
  confidence: "established" | "likely" | "speculative";
  /** Indexes into Artifact.evidence. */
  evidenceIds?: number[];
}

export interface ArtifactEvidence {
  kind: "loot" | "file" | "url" | "external";
  ref: string;
  snippet?: string;
}

/**
 * A Plan is a DAG of sub-rites the Planner emits for complex tasks.
 * Topologically executed; failed nodes can trigger recursive replan.
 */
export interface Plan {
  id: string;
  rootTask: string;
  nodes: PlanNode[];
  edges: PlanEdge[];
  /** How many times the planner has been re-invoked on this plan (max 2). */
  replanDepth: number;
  createdAt: number;
}

export interface PlanNode {
  id: string;
  task: string;
  /** ids of nodes whose artifacts must be available before this node runs. */
  inputs: string[];
  kind: "sub_rite" | "synthesize";
  /** Suggested pack size from dynamic spawning; defaults to 1 if absent. */
  packSize?: number;
  /** Suggested lead personality for the goblin pack on this node. */
  personality?: Personality;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  riteId?: string;
  artifactId?: string;
  failureReason?: string;
}

export interface PlanEdge {
  from: string;
  to: string;
}

/**
 * Identified failure mode across a pack of failed goblin attempts.
 * Used to spawn focused Specialist goblins in the recovery layer.
 */
export interface FailureCluster {
  /** Short identifier, e.g. "null-handling". */
  name: string;
  /** 1-2 sentence description of what's wrong. */
  description: string;
  /** Indexes into the goblin pack that exhibit this failure. */
  affectedGoblinIndexes: number[];
  /** Concise instruction for the specialist goblin telling it what to fix. */
  specialistFocus: string;
  severity: "high" | "medium" | "low";
}

export type ModelSlot = CreatureKind | "scribe" | "embedding";

export type ProviderPresetId =
  | "openai"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "groq"
  | "together"
  | "mistral"
  | "deepseek"
  | "anthropic"
  | "gemini"
  | "custom";

export type OutputFormat = "freeform" | "markdown" | "json";

export interface ProviderRouteConfig {
  preset: ProviderPresetId;
  baseURL?: string;
  apiKeyEnv?: string;
  model?: string;
  outputFormat?: OutputFormat;
}

export interface ProviderConfig {
  preset: ProviderPresetId;
  baseURL?: string;
  apiKeyEnv?: string;
  models?: Partial<Record<ModelSlot, string>>;
  routes?: Partial<Record<ModelSlot, ProviderRouteConfig>>;
  outputFormat?: OutputFormat;
}

export interface WarrenPeer {
  name: string;
  url: string;
  createdAt: string;
  note?: string;
}

export interface CountryConfig {
  /** Collaboration backend mode. local=peer URLs, firebase=cloud code-based flow. */
  collabBackend?: "local" | "firebase";
  /** Enable collaborative country mode for rite/plan execution preflights. */
  enabled?: boolean;
  /** Stable country id (shared by all members). */
  countryId?: string;
  /** Human-readable country name. */
  countryName?: string;
  /** Short join/search code (for example: A7K2Q). */
  countryCode?: string;
  /** Public key of country lead used to verify membership operations. */
  leaderPublicKey?: string;
  /** If true, this country is discoverable for join requests. */
  discoverable?: boolean;
  /** Manual role owners by creature kind. Missing roles can auto-fall back to lead. */
  roleOwners?: Partial<Record<CreatureKind, string>>;
  /** When true, any unassigned role defaults to the lead for the run. */
  autoAssignLeadExtras?: boolean;
  /** Pending join requests awaiting lead approval. */
  pendingJoinRequests?: CountryJoinRequest[];
  /** Rites/plans queued while team-members are offline. */
  riteQueue?: CountryQueuedRite[];
}

export interface CountryJoinRequest {
  id: string;
  countryId: string;
  countryCode: string;
  fromName: string;
  fromUrl: string;
  fromPublicKey: string;
  createdAt: string;
  signature: string;
}

export interface CountryQueuedRite {
  id: string;
  mode: "rite" | "plan";
  task: string;
  createdAt: number;
}

export interface WarrenManifest {
  name: string;
  version: number;
  createdAt: string;
  defaultModelGoblin: string;
  defaultModelOgre: string;
  defaultModelTroll: string;
  provider?: ProviderConfig;
  /** Optional shared secret for HMAC-authenticated federation. */
  peerSecret?: string;
  /** Known peer Warrens in the same goblin-country. */
  peers?: WarrenPeer[];
  /** Team execution policy for distributed rites. */
  country?: CountryConfig;
}
