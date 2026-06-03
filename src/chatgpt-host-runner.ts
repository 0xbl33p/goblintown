import { randomUUID } from "node:crypto";
import { renderArtifactContext } from "./artifact.js";
import {
  makeGoblin,
  makeGremlin,
  makeOgre,
  makePigeon,
  makeScribe,
  makeSpecialistGoblin,
  makeTroll,
} from "./creatures.js";
import { packVariant } from "./pack-prompt.js";
import { buildPlannerPrompt } from "./planner.js";
import { formatContextDump, gatherFiles } from "./scavenge.js";
import type { Artifact, Personality } from "./types.js";

type JsonObject = Record<string, unknown>;

const PACK_PERSONALITIES: Personality[] = ["nerdy", "cynical", "chipper", "stoic", "feral"];
const MAX_HOST_CONTEXT_CHARS = 28_000;

export interface ChatGptHostRiteOptions {
  task: string;
  packSize: number;
  cwd: string;
  scanGlobs?: string[];
  personality?: Personality;
  parentArtifacts?: Artifact[];
  noFallback?: boolean;
  noSpecialist?: boolean;
  specialistCap?: number;
  debate?: boolean;
  trollTools?: boolean;
  outputFormat?: unknown;
}

export interface ChatGptHostPlanOptions {
  task: string;
  cwd: string;
  parentArtifacts?: Artifact[];
  maxNodes: number;
  maxReplan: number;
  outputFormat?: unknown;
}

export interface ChatGptHostChatOptions {
  messages: { role: "user" | "assistant"; content: string }[];
  personality?: Personality;
  modelSlot?: string;
}

export async function buildChatGptHostRitePacket(
  opts: ChatGptHostRiteOptions,
): Promise<JsonObject> {
  const runId = `chatgpt-rite-${randomUUID().slice(0, 8)}`;
  const parentArtifactBlock = renderParentArtifacts(opts.parentArtifacts);
  const scan = await hostScanContext(opts.cwd, opts.scanGlobs);
  const taskWithContext = [
    opts.task,
    parentArtifactBlock ? `Prior artifacts:\n${parentArtifactBlock}` : "",
    scan.contextDump ? `Local context dump:\n${scan.contextDump}` : "",
  ].filter(Boolean).join("\n\n");
  const personalities = hostPackPersonalities(opts.packSize, opts.personality);
  const goblinPrompts = personalities.map((personality, index) => {
    const creature = makeGoblin(personality);
    return {
      index,
      role: "goblin",
      personality,
      systemPrompt: creature.systemPrompt,
      userPrompt: packVariant(taskWithContext, index, opts.packSize),
    };
  });
  const gremlin = makeGremlin();
  const troll = makeTroll();
  const ogre = makeOgre();
  const scribe = makeScribe();

  const instructions = [
    "Execute this Goblintown rite now using ChatGPT as the host model. Do not ask for an OpenAI API key.",
    "Keep the orchestration deterministic: run the phases in order and apply the gate rules exactly.",
    "Treat each goblin prompt as a separate candidate answer. If you cannot literally run parallel calls, emulate independent passes by not letting later candidates copy earlier ones.",
    "After the troll reviews, if any candidate passes, choose the passing candidate with the highest score.",
    opts.noSpecialist
      ? "Specialist recovery is disabled for this run."
      : `If all candidates fail, cluster the failures into 1-${Math.max(1, Math.min(opts.specialistCap ?? 3, 3))} focused recovery tasks, produce specialist repairs, and re-judge them.`,
    opts.noFallback
      ? "Ogre fallback is disabled; if nothing passes, choose the best failed candidate and mark all_failed."
      : "If the pack and specialists still fail, run the Ogre fallback and use it as the winner.",
    "Finish with a concise final answer for the user. Include a short verdict summary only if it helps the user trust the result.",
  ];

  const prompt = [
    "Goblintown ChatGPT-hosted rite packet",
    "",
    `Task:\n${opts.task}`,
    "",
    "Instructions:",
    ...instructions.map((line) => `- ${line}`),
    "",
    "Phase 1 - Raccoon context:",
    parentArtifactBlock || scan.contextDump
      ? "Use the prior artifacts and local context dump above as factual context. Separate facts from guesses."
      : "No extra context was provided; proceed from the task alone.",
    "",
    "Phase 2 - Goblin pack prompts:",
    ...goblinPrompts.flatMap((entry) => [
      `--- Goblin #${entry.index} (${entry.personality}) system ---`,
      entry.systemPrompt,
      `--- Goblin #${entry.index} user ---`,
      entry.userPrompt,
    ]),
    ...(opts.debate
      ? [
          "",
          "Phase 3 - Debate:",
          "Show the candidates to one another, revise each candidate once, and use the revised pack for review.",
        ]
      : []),
    "",
    "Phase 4 - Gremlin chaos prompt for each candidate:",
    gremlin.systemPrompt,
    "For each candidate, list distinct attacks, edge cases, hidden assumptions, or failure modes.",
    "",
    "Phase 5 - Troll review prompt for each candidate:",
    troll.systemPrompt,
    "For each candidate plus its chaos report, return JSON: { \"passed\": boolean, \"score\": number, \"critique\": string }.",
    "",
    "Phase 6 - Recovery gates:",
    opts.noSpecialist
      ? "(specialists disabled)"
      : makeSpecialistGoblin("the dominant failure mode").systemPrompt,
    opts.noFallback ? "(ogre disabled)" : ogre.systemPrompt,
    "",
    "Phase 7 - Scribe memory note:",
    scribe.systemPrompt,
    "Do not call a server to store memory in ChatGPT-hosted mode; include any useful distilled artifact as plain text if relevant.",
  ].join("\n");

  return {
    kind: "rite",
    runId,
    runner: "chatgpt_host",
    openAiApiKeyRequired: false,
    task: opts.task,
    scannedFiles: scan.files,
    parentArtifactIds: (opts.parentArtifacts ?? []).map((artifact) => artifact.id),
    phases: [
      "raccoon_context",
      "goblin_pack",
      ...(opts.debate ? ["debate"] : []),
      "gremlin_chaos",
      "troll_review",
      ...(opts.noSpecialist ? [] : ["specialist_recovery"]),
      ...(opts.noFallback ? [] : ["ogre_fallback"]),
      "scribe_note",
    ],
    prompts: {
      goblins: goblinPrompts,
      gremlinSystemPrompt: gremlin.systemPrompt,
      trollSystemPrompt: troll.systemPrompt,
      ogreSystemPrompt: ogre.systemPrompt,
      scribeSystemPrompt: scribe.systemPrompt,
    },
    instructions,
    prompt,
  };
}

export function buildChatGptHostPlanPacket(
  opts: ChatGptHostPlanOptions,
): JsonObject {
  const runId = `chatgpt-plan-${randomUUID().slice(0, 8)}`;
  const plannerPrompt = buildPlannerPrompt({
    task: opts.task,
    parentArtifacts: opts.parentArtifacts,
    maxNodes: opts.maxNodes,
  });
  const instructions = [
    "Execute this Goblintown planner run using ChatGPT as the host model. Do not ask for an OpenAI API key.",
    `First produce a valid DAG with at most ${opts.maxNodes} nodes from the planner prompt.`,
    `Execute each node as a ChatGPT-hosted Goblintown rite. If a node fails, replan up to ${opts.maxReplan} times.`,
    "Feed completed node artifacts into dependent nodes, then synthesize the final answer.",
  ];
  const prompt = [
    "Goblintown ChatGPT-hosted planner packet",
    "",
    "Instructions:",
    ...instructions.map((line) => `- ${line}`),
    "",
    "Planner prompt:",
    plannerPrompt,
    "",
    "After planning, run each sub-rite with the same gates: goblin pack, gremlin chaos, troll review, specialist recovery, ogre fallback, scribe note.",
  ].join("\n");
  return {
    kind: "plan",
    runId,
    runner: "chatgpt_host",
    openAiApiKeyRequired: false,
    task: opts.task,
    parentArtifactIds: (opts.parentArtifacts ?? []).map((artifact) => artifact.id),
    maxNodes: opts.maxNodes,
    maxReplan: opts.maxReplan,
    instructions,
    plannerPrompt,
    prompt,
  };
}

export function buildChatGptHostChatPacket(
  opts: ChatGptHostChatOptions,
): JsonObject {
  const runId = `chatgpt-chat-${randomUUID().slice(0, 8)}`;
  const creature = makeGoblin(opts.personality);
  const transcript = opts.messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
  const prompt = [
    "Goblintown ChatGPT-hosted Single Goblin packet",
    "",
    "Execute this Single Goblin reply now using ChatGPT as the host model. Do not ask for an OpenAI API key.",
    "",
    "System prompt:",
    creature.systemPrompt,
    "",
    "Conversation:",
    transcript,
    "",
    "Return the Single Goblin answer directly to the user.",
  ].join("\n");
  return {
    kind: "single_goblin",
    runId,
    runner: "chatgpt_host",
    openAiApiKeyRequired: false,
    modelSlot: opts.modelSlot ?? "goblin",
    personality: creature.personality,
    systemPrompt: creature.systemPrompt,
    prompt,
  };
}

function hostPackPersonalities(packSize: number, base?: Personality): Personality[] {
  const out: Personality[] = [];
  const pool = [...PACK_PERSONALITIES];
  if (base) {
    out.push(base);
    const index = pool.indexOf(base);
    if (index >= 0) pool.splice(index, 1);
  }
  while (out.length < packSize) {
    out.push(pool[out.length % pool.length]);
  }
  return out.slice(0, packSize);
}

function renderParentArtifacts(artifacts: Artifact[] | undefined): string {
  if (!artifacts || artifacts.length === 0) return "";
  return artifacts.map((artifact) => renderArtifactContext(artifact)).join("\n\n");
}

async function hostScanContext(
  cwd: string,
  scanGlobs: string[] | undefined,
): Promise<{ files: string[]; contextDump: string }> {
  if (!scanGlobs || scanGlobs.length === 0) return { files: [], contextDump: "" };
  const files = await gatherFiles(cwd, scanGlobs);
  return {
    files: files.map((file) => file.path),
    contextDump: truncate(formatContextDump(files), MAX_HOST_CONTEXT_CHARS),
  };
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated for ChatGPT-hosted run packet]`;
}
