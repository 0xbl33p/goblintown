import { makeGoblin } from "./creatures.js";
import { GOBLINTOWN_CHAT_CONTEXT } from "./chat-persona.js";
import { measureDrift } from "./drift.js";
import { callCreature } from "./openai-client.js";
import type { Hoard } from "./hoard.js";
import type { Loot, ModelSlot, Personality, TokenUsage } from "./types.js";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface SingleGoblinChatOptions {
  messages: ChatMessage[];
  hoard: Hoard;
  personality?: Personality;
  modelSlot?: ModelSlot;
  maxOutputTokens?: number;
}

export interface SingleGoblinChatResult {
  message: ChatMessage;
  lootId: string;
  usage?: TokenUsage;
  goblintownOffer?: GoblintownOffer;
}

const MAX_CHAT_MESSAGES = 24;
const MAX_CHAT_CONTENT_CHARS = 6000;

export interface GoblintownOffer {
  task: string;
  requested: boolean;
  reason: "explicit" | "complex";
}

export function normalizeChatMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  const out: ChatMessage[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const role = obj.role === "assistant" ? "assistant" : obj.role === "user" ? "user" : null;
    const content = typeof obj.content === "string" ? obj.content.trim() : "";
    if (!role || !content) continue;
    out.push({
      role,
      content: truncateContent(content),
    });
  }
  return out.slice(-MAX_CHAT_MESSAGES);
}

export function buildSingleGoblinChatPrompt(messages: ChatMessage[]): string {
  const normalized = normalizeChatMessages(messages);
  if (normalized.length === 0 || normalized[normalized.length - 1].role !== "user") {
    throw new Error("chat requires a latest user message");
  }
  const transcript = normalized
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return [
    "You are the AI-first single Goblin chat mode: a regular single LLM model call.",
    "Do not run multi-agent Goblintown orchestration inside this chat response.",
    "Answer the latest user message directly. Use the prior transcript only for context.",
    "Keep the response practical, concise, and complete. Ask a follow-up only if required.",
    "If the task is complex enough to benefit from the full Goblintown pack, briefly offer to run Goblintown as an optional next step, but still answer as the single Goblin now.",
    "If the user explicitly asks for Goblintown, acknowledge that the full pack can be started through the chat surface.",
    "",
    GOBLINTOWN_CHAT_CONTEXT,
    "",
    transcript,
  ].join("\n");
}

export function detectGoblintownOffer(messages: ChatMessage[]): GoblintownOffer | undefined {
  const normalized = normalizeChatMessages(messages);
  const userMessages = normalized.filter((m) => m.role === "user");
  const latest = userMessages[userMessages.length - 1];
  if (!latest) return undefined;
  let task = latest.content;
  if (
    /\bgoblin\s*town\b|\bgoblintown\b|\bfull\s+pack\b|\bpack\s+of\s+goblins\b|\brite\b|\brites\b/i.test(
      task,
    )
  ) {
    task = resolveExplicitRunTask(userMessages);
    return { task, requested: true, reason: "explicit" };
  }
  if (looksComplexForGoblintown(task)) {
    return { task, requested: false, reason: "complex" };
  }
  return undefined;
}

function resolveExplicitRunTask(userMessages: ChatMessage[]): string {
  const latest = userMessages[userMessages.length - 1]?.content ?? "";
  if (!isBareRunRequest(latest)) return latest;
  const previous = [...userMessages]
    .slice(0, -1)
    .reverse()
    .find((message) => !isBareRunRequest(message.content));
  return previous?.content ?? latest;
}

function isBareRunRequest(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(please )?(do|run|start|make|launch|kick off) (a |the )?(rite|goblintown|goblin town|full pack)$/.test(
    normalized,
  );
}

export async function runSingleGoblinChat(
  opts: SingleGoblinChatOptions,
): Promise<SingleGoblinChatResult> {
  const personality = opts.personality ?? "chipper";
  const prompt = buildSingleGoblinChatPrompt(opts.messages);
  const goblin = makeGoblin(personality);
  if (opts.modelSlot) {
    goblin.modelSlot = opts.modelSlot;
  }
  const { text, usage } = await callCreature(goblin, prompt, {
    maxOutputTokens: opts.maxOutputTokens,
  });
  const loot: Loot = {
    id: "",
    creatureKind: "goblin",
    personality: goblin.personality,
    model: goblin.model,
    prompt,
    output: text,
    timestamp: Date.now(),
    drift: measureDrift(text),
    usage,
  };
  const lootId = await opts.hoard.stash(loot);
  const goblintownOffer = detectGoblintownOffer(opts.messages);
  return {
    message: { role: "assistant", content: text },
    lootId,
    usage,
    ...(goblintownOffer ? { goblintownOffer } : {}),
  };
}

function truncateContent(value: string): string {
  if (value.length <= MAX_CHAT_CONTENT_CHARS) return value;
  return `${value.slice(0, MAX_CHAT_CONTENT_CHARS - 15)}\n[truncated]`;
}

function looksComplexForGoblintown(task: string): boolean {
  const words = task.split(/\s+/).filter(Boolean).length;
  const hasStructure = /\n\s*[-*0-9]/.test(task) || (task.match(/[?.!]/g)?.length ?? 0) >= 4;
  const complexTerms =
    task.match(
      /\b(audit|architect|debug|diagnose|investigate|compare|refactor|implement|migrate|migration|review|design|plan|strategy|security|production|rollback|edge cases|multi[- ]?step|end[- ]?to[- ]?end)\b/gi,
    ) ?? [];
  const hasComplexVerb = complexTerms.length > 0;
  const hasMultipleComplexSignals = new Set(complexTerms.map((term) => term.toLowerCase())).size >= 2;
  return (
    words >= 80 ||
    (words >= 35 && (hasStructure || hasComplexVerb)) ||
    (words >= 16 && hasMultipleComplexSignals)
  );
}
