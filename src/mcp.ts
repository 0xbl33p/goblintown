#!/usr/bin/env node
/**
 * Goblintown MCP server.
 *
 * Exposes the Goblintown protocol as MCP tools over stdio so MCP clients
 * (Claude Desktop, Cursor, Continue, etc.) can summon individual creatures or
 * dispatch a full quest / rite without going through the CLI.
 *
 * Tools:
 *   - summon_creature   one-shot single creature, no Warren required
 *   - dispatch_quest    Goblin pack + Troll arbitration (requires a Warren)
 *   - perform_rite      Raccoon → pack → Gremlin → Troll → Ogre fallback
 *   - read_loot         fetch a stashed Loot by id
 *   - list_recent_loot  recent N drops, optionally filtered by kind / rite
 *   - drift_report      aggregate cross-creature drift by kind
 *
 * The MCP server respects the same env vars as the CLI:
 *   OPENAI_API_KEY, GOBLINTOWN_MODEL_*, GOBLINTOWN_MAX_CONCURRENCY,
 *   GOBLINTOWN_STORAGE
 *
 * The Warren root is auto-discovered from the working directory and may be
 * overridden per-tool with the `cwd` argument.
 */
try {
  process.loadEnvFile?.();
} catch {
  // no .env — fine
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { makeCreature } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { callCreature } from "./openai-client.js";
import { dispatchQuest } from "./quest.js";
import { performRite } from "./rite.js";
import {
  CREATURE_KINDS,
  type CreatureKind,
  type Loot,
  type Personality,
} from "./types.js";
import { loadWarren } from "./warren.js";

const PERSONALITIES = ["nerdy", "cynical", "chipper", "stoic", "feral"] as const;

const TOOLS = [
  {
    name: "summon_creature",
    description:
      "Run a single Goblintown creature once and return its output. Does not require a Warren; if one is found at cwd the loot is stashed.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: CREATURE_KINDS, description: "Creature kind." },
        task: { type: "string", description: "Task / prompt for the creature." },
        personality: { type: "string", enum: [...PERSONALITIES] },
        cwd: { type: "string", description: "Optional working directory for Warren discovery." },
      },
      required: ["kind", "task"],
    },
  },
  {
    name: "dispatch_quest",
    description:
      "Dispatch a Goblin pack on a task. Each goblin produces a candidate; a Troll arbitrates and the winning loot is returned. Requires a Warren.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        pack_size: { type: "integer", minimum: 1, maximum: 9, default: 3 },
        personality: { type: "string", enum: [...PERSONALITIES] },
        cwd: { type: "string" },
      },
      required: ["task"],
    },
  },
  {
    name: "perform_rite",
    description:
      "Full Goblintown rite: optional Raccoon scavenge → Goblin pack → Gremlin chaos → Troll review → Ogre fallback. Requires a Warren.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        pack_size: { type: "integer", minimum: 1, maximum: 9, default: 3 },
        scan_globs: { type: "array", items: { type: "string" } },
        personality: { type: "string", enum: [...PERSONALITIES] },
        no_fallback: { type: "boolean", default: false },
        budget_tokens: { type: "integer", minimum: 1 },
        max_output_tokens: { type: "integer", minimum: 1 },
        cwd: { type: "string" },
      },
      required: ["task"],
    },
  },
  {
    name: "read_loot",
    description: "Fetch a single stashed Loot by id from the Warren's Hoard.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_recent_loot",
    description: "List the most recent loot in the Hoard, optionally filtered by creature kind or rite id.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: CREATURE_KINDS },
        rite_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "drift_report",
    description: "Aggregate cross-creature drift report across all stashed loot in the Warren.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
    },
  },
];

const server = new Server(
  { name: "goblintown", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "summon_creature":
        return await summonCreature(args);
      case "dispatch_quest":
        return await dispatchQuestTool(args);
      case "perform_rite":
        return await performRiteTool(args);
      case "read_loot":
        return await readLoot(args);
      case "list_recent_loot":
        return await listRecentLoot(args);
      case "drift_report":
        return await driftReport(args);
      default:
        return errText(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errText(err instanceof Error ? err.message : String(err));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// --- tool implementations ---

async function summonCreature(args: Record<string, unknown>) {
  const kind = requireEnum(args.kind, CREATURE_KINDS, "kind");
  const task = requireString(args.task, "task");
  const personality = optionalEnum(args.personality, PERSONALITIES);
  const creature = makeCreature(kind, personality);
  const { text, usage } = await callCreature(creature, task);

  const drift = measureDrift(text);
  let lootId: string | undefined;
  try {
    const w = await loadWarren(stringOr(args.cwd, process.cwd()));
    const loot: Loot = {
      id: "",
      creatureKind: kind,
      personality: creature.personality,
      model: creature.model,
      prompt: task,
      output: text,
      timestamp: Date.now(),
      drift,
      usage,
    };
    lootId = await w.hoard.stash(loot);
  } catch {
    // No warren — skip stash.
  }

  return okText(
    text +
      `\n\n— meta —\nkind=${kind} model=${creature.model} ` +
      `tokens=${usage.totalTokens} drift=${drift.driftRate.toFixed(4)}` +
      (lootId ? ` loot=${lootId}` : " (no warren)"),
  );
}

async function dispatchQuestTool(args: Record<string, unknown>) {
  const task = requireString(args.task, "task");
  const packSize = optionalInt(args.pack_size, 3);
  const personality = optionalEnum(args.personality, PERSONALITIES);
  const w = await loadWarren(stringOr(args.cwd, process.cwd()));
  const result = await dispatchQuest({
    task,
    packSize,
    hoard: w.hoard,
    personality,
  });
  const summary =
    `quest=${result.quest.id} pack=${packSize} winner=${result.winner.id}\n` +
    result.loot
      .map((l) => {
        const v = result.quest.trollVerdicts[l.id];
        const tag = l.id === result.winner.id ? "  ← winner" : "";
        return `  ${l.id} shinies=${(l.reward ?? 0).toFixed(3)} troll=${v.score.toFixed(2)} ${v.passed ? "PASS" : "FAIL"}${tag}`;
      })
      .join("\n");
  return okText(`${summary}\n\n--- winning loot ---\n${result.winner.output}`);
}

async function performRiteTool(args: Record<string, unknown>) {
  const task = requireString(args.task, "task");
  const packSize = optionalInt(args.pack_size, 3);
  const personality = optionalEnum(args.personality, PERSONALITIES);
  const scanGlobs = optionalStringArray(args.scan_globs);
  const noFallback = !!args.no_fallback;
  const budgetTokens = optionalInt(args.budget_tokens, undefined);
  const maxOutputTokens = optionalInt(args.max_output_tokens, undefined);
  const w = await loadWarren(stringOr(args.cwd, process.cwd()));
  const result = await performRite({
    task,
    packSize,
    scanGlobs,
    cwd: w.root,
    hoard: w.hoard,
    personality,
    noFallback,
    budgetTokens,
    maxOutputTokensPerCall: maxOutputTokens,
  });
  const winnerLoot =
    result.rite.winnerLootId
      ? await w.hoard.getLoot(result.rite.winnerLootId)
      : null;
  const winnerText = winnerLoot
    ? `\n\n--- winning loot (${winnerLoot.creatureKind} ${winnerLoot.id}) ---\n${winnerLoot.output}`
    : "";
  return okText(
    `rite=${result.rite.id} outcome=${result.rite.outcome} pack=${packSize} ` +
      `goblins=${result.rite.goblinLootIds.length}` +
      winnerText,
  );
}

async function readLoot(args: Record<string, unknown>) {
  const id = requireString(args.id, "id");
  const w = await loadWarren(stringOr(args.cwd, process.cwd()));
  const loot = await w.hoard.getLoot(id);
  if (!loot) return errText(`Loot ${id} not found.`);
  return okText(JSON.stringify(loot, null, 2));
}

async function listRecentLoot(args: Record<string, unknown>) {
  const limit = optionalInt(args.limit, 20);
  const kind = optionalEnum(args.kind, CREATURE_KINDS);
  const riteId = typeof args.rite_id === "string" ? args.rite_id : undefined;
  const w = await loadWarren(stringOr(args.cwd, process.cwd()));
  let loot = await w.hoard.allLoot();
  if (kind) loot = loot.filter((l) => l.creatureKind === kind);
  if (riteId) loot = loot.filter((l) => l.riteId === riteId);
  loot.sort((a, b) => b.timestamp - a.timestamp);
  const rows = loot.slice(0, limit).map((l) => ({
    id: l.id,
    kind: l.creatureKind,
    personality: l.personality,
    model: l.model,
    tokens: l.usage?.totalTokens ?? 0,
    drift: Number(l.drift.driftRate.toFixed(4)),
    rite: l.riteId,
    quest: l.questId,
    timestamp: new Date(l.timestamp).toISOString(),
  }));
  return okText(JSON.stringify(rows, null, 2));
}

async function driftReport(args: Record<string, unknown>) {
  const w = await loadWarren(stringOr(args.cwd, process.cwd()));
  const all = await w.hoard.allLoot();
  const byKind = new Map<CreatureKind, number[]>();
  for (const k of CREATURE_KINDS) byKind.set(k, []);
  for (const l of all) byKind.get(l.creatureKind)?.push(l.drift.driftRate);
  const report = CREATURE_KINDS.map((k) => {
    const rates = byKind.get(k) ?? [];
    const avg =
      rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
    return { kind: k, n: rates.length, avg_drift_rate: Number(avg.toFixed(4)) };
  });
  return okText(JSON.stringify({ total_loot: all.length, by_kind: report }, null, 2));
}

// --- helpers ---

function okText(text: string) {
  return { content: [{ type: "text", text }] };
}
function errText(message: string) {
  return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
}
function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`'${name}' is required`);
  }
  return v;
}
function requireEnum<T extends string>(
  v: unknown,
  options: readonly T[],
  name: string,
): T {
  if (typeof v !== "string" || !options.includes(v as T)) {
    throw new Error(`'${name}' must be one of: ${options.join(", ")}`);
  }
  return v as T;
}
function optionalEnum<T extends string>(
  v: unknown,
  options: readonly T[],
): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" && options.includes(v as T)) return v as T;
  return undefined;
}
function optionalInt(v: unknown, fallback: number): number;
function optionalInt(v: unknown, fallback: undefined): number | undefined;
function optionalInt(v: unknown, fallback: number | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return fallback;
}
function optionalStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}
