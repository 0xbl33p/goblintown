import { makeTroll } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { callCreature } from "./openai-client.js";
import {
  builtinTools,
  parseToolCallsJson,
  renderToolCatalog,
  renderToolResults,
  runToolCalls,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "./tools.js";
import type { Loot, Personality, TrollVerdict } from "./types.js";
import type { Hoard } from "./hoard.js";

export interface TrollReviewOptions {
  goblinLoot: Loot;
  originalTask: string;
  chaosLoot?: Loot;
  hoard: Hoard;
  personality?: Personality;
  riteId?: string;
  /** Phase 5: enable tool-use round before verdict. */
  withTools?: boolean;
  /** Custom tool registry (defaults to builtinTools). */
  tools?: ToolDefinition[];
  /** Optional callback so the orchestrator/UI can show tool calls. */
  onToolCalls?: (calls: ToolCall[]) => void;
  onToolResults?: (results: ToolResult[]) => void;
}

export interface TrollReviewResult {
  verdict: TrollVerdict;
  trollLoot: Loot;
}

export async function trollReview(opts: TrollReviewOptions): Promise<TrollReviewResult> {
  const troll = makeTroll(opts.personality);
  const chaosBlock = opts.chaosLoot
    ? `\n\nGremlin chaos report (treat findings as evidence against passing):\n${opts.chaosLoot.output}`
    : "";

  // Phase 5: optional tool-use round. Troll first decides which (if any) tools
  // to call, we run them, results are appended to the verdict prompt.
  let toolBlock = "";
  if (opts.withTools) {
    const tools = opts.tools ?? builtinTools;
    const catalogPrompt =
      `Original task:\n${opts.originalTask}\n\n` +
      `Goblin output:\n${opts.goblinLoot.output}` +
      chaosBlock +
      `\n\nYou may invoke tools to verify the output before scoring it. Available tools:\n` +
      renderToolCatalog(tools) +
      `\n\nIf tools would help, output a JSON array of calls: ` +
      `[{"name":"<tool>","args":{...}}, ...] (max 4). ` +
      `If no tools are needed, output []. JSON only.`;
    try {
      const { text: catalogRaw } = await callCreature(
        { ...troll, systemPrompt: troll.systemPrompt + " You are now planning tool calls." },
        catalogPrompt,
        { maxOutputTokens: 400 },
      );
      const calls = parseToolCallsJson(catalogRaw, 4);
      if (calls.length > 0) {
        opts.onToolCalls?.(calls);
        const results = await runToolCalls(calls, tools);
        opts.onToolResults?.(results);
        toolBlock = `\n\nVerifier-tool results:\n${renderToolResults(results)}`;
      }
    } catch {
      // tool-use is best-effort; fall through to plain verdict
    }
  }

  const userPrompt =
    `Original task:\n${opts.originalTask}\n\n` +
    `Goblin output:\n${opts.goblinLoot.output}` +
    chaosBlock +
    toolBlock +
    `\n\nReply with a single JSON object: { "passed": boolean, "score": number 0-1, "critique": string }.`;

  const { text: raw, usage } = await callCreature(troll, userPrompt);
  const parsed = parseLooseJson(raw);
  const verdict: TrollVerdict = {
    lootId: opts.goblinLoot.id,
    passed: typeof parsed?.passed === "boolean" ? parsed.passed : false,
    score: clamp01(typeof parsed?.score === "number" ? parsed.score : 0),
    critique:
      typeof parsed?.critique === "string"
        ? parsed.critique
        : "(troll critique unparseable)",
  };

  const drift = measureDrift(raw);
  const parents = [opts.goblinLoot.id];
  if (opts.chaosLoot) parents.push(opts.chaosLoot.id);

  const trollLoot: Loot = {
    id: "",
    riteId: opts.riteId,
    creatureKind: "troll",
    personality: troll.personality,
    model: troll.model,
    prompt: userPrompt,
    output: raw,
    parentLootIds: parents,
    timestamp: Date.now(),
    drift,
    usage,
  };
  await opts.hoard.stash(trollLoot);

  return { verdict, trollLoot };
}

function parseLooseJson(s: string): {
  passed?: unknown;
  score?: unknown;
  critique?: unknown;
} | null {
  try {
    return JSON.parse(s);
  } catch {
    // not pure JSON; try extracting an object
  }
  const match = s.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  return null;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
