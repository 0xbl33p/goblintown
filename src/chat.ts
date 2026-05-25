import { makeGoblin } from "./creatures.js";
import { GOBLINTOWN_CHAT_CONTEXT } from "./chat-persona.js";
import { measureDrift } from "./drift.js";
import { callCreature } from "./openai-client.js";
import {
  createWebFetchTool,
  runToolCalls,
  type ToolResult,
} from "./tools.js";
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
  fetchImpl?: typeof fetch;
}

export interface SingleGoblinChatResult {
  message: ChatMessage;
  lootId: string;
  usage?: TokenUsage;
  goblintownOffer?: GoblintownOffer;
  toolResults?: ToolResult[];
}

const MAX_CHAT_MESSAGES = 24;
const MAX_CHAT_CONTENT_CHARS = 6000;
const MAX_CHAT_WEB_URLS = 3;

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

export function buildSingleGoblinChatPrompt(
  messages: ChatMessage[],
  toolResults: ToolResult[] = [],
): string {
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
    "When web tool results are provided, treat them as fresh page context and cite the relevant URL in your answer.",
    "Keep the response practical, concise, and complete. Ask a follow-up only if required.",
    "If the task is complex enough to benefit from the full Goblintown pack, briefly offer to run Goblintown as an optional next step, but still answer as the single Goblin now.",
    "If the user explicitly asks for Goblintown, acknowledge that the full pack can be started through the chat surface.",
    "",
    GOBLINTOWN_CHAT_CONTEXT,
    "",
    toolResults.length > 0 ? `Web tool results:\n${renderChatWebToolResults(toolResults)}` : "",
    toolResults.length > 0 ? "" : "",
    transcript,
  ].join("\n");
}

function renderChatWebToolResults(results: ToolResult[]): string {
  return results
    .map((result, index) => {
      if (!result.ok) {
        return `[${index + 1}] ${result.name}: ERROR ${result.error ?? "unknown error"}`;
      }
      const payload = result.result as Record<string, unknown> | undefined;
      const url = typeof payload?.url === "string" ? payload.url : "";
      const title = typeof payload?.title === "string" && payload.title ? `\nTitle: ${payload.title}` : "";
      const status = typeof payload?.status === "number" ? `Status: ${payload.status}` : "Status: unknown";
      const text = typeof payload?.text === "string" ? payload.text : JSON.stringify(payload);
      return [
        `[${index + 1}] ${url}`,
        status + title,
        "Text:",
        text,
      ].join("\n");
    })
    .join("\n\n");
}

export function extractChatWebUrls(messages: ChatMessage[]): string[] {
  const normalized = normalizeChatMessages(messages);
  const latest = [...normalized].reverse().find((m) => m.role === "user");
  if (!latest) return [];
  const matches = normalizeLikelyChatUrls(latest.content).match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  const urls: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[),.;:!?]+$/g, "");
    try {
      const url = new URL(cleaned);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      const normalizedUrl = url.toString();
      if (!urls.includes(normalizedUrl)) urls.push(normalizedUrl);
      if (urls.length >= MAX_CHAT_WEB_URLS) break;
    } catch {
      // Ignore malformed URL-shaped text.
    }
  }
  return urls;
}

export function normalizeLikelyChatUrls(value: string): string {
  return value.replace(
    /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)[A-Za-z]+(?=$|[\s),.;:!?])/gi,
    (raw, owner, repo, issue) => {
      try {
        const url = new URL(raw);
        url.pathname = `/${owner}/${repo}/issues/${issue}`;
        return url.toString().replace(/\/$/, "");
      } catch {
        return raw;
      }
    },
  );
}

export async function collectChatWebToolResults(
  messages: ChatMessage[],
  fetchImpl?: typeof fetch,
): Promise<ToolResult[]> {
  const urls = extractChatWebUrls(messages);
  if (urls.length === 0) return [];
  return runToolCalls(
    urls.map((url) => ({
      name: "web.fetch",
      args: { url, maxChars: 9000 },
    })),
    [createWebFetchTool(fetchImpl)],
  );
}

export function detectGoblintownOffer(messages: ChatMessage[]): GoblintownOffer | undefined {
  const normalized = normalizeChatMessages(messages);
  const userMessages = normalized.filter((m) => m.role === "user");
  const latest = userMessages[userMessages.length - 1];
  if (!latest) return undefined;
  let task = normalizeLikelyChatUrls(latest.content);
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
  if (!isBareRunRequest(latest)) return normalizeLikelyChatUrls(latest);
  const previous = [...userMessages]
    .slice(0, -1)
    .reverse()
    .find((message) => !isBareRunRequest(message.content));
  return normalizeLikelyChatUrls(previous?.content ?? latest);
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
  const toolResults = await collectChatWebToolResults(opts.messages, opts.fetchImpl);
  const prompt = buildSingleGoblinChatPrompt(opts.messages, toolResults);
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
    ...(toolResults.length > 0 ? { toolResults } : {}),
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
