/**
 * Phase 4 — Inter-agent debate round.
 *
 * After the initial goblin pack proposes, run one debate round where each
 * goblin sees the others' outputs and may revise. This closes the O3
 * communication gap (per the LLM-MAS-RL survey): currently goblins work in
 * parallel sandboxes, never see each other's work. Debate is training-free
 * and on the order of one extra goblin call per pack member.
 *
 * Pure functions exported for testability:
 *   buildDebatePrompt — what each goblin sees during the debate round.
 */
import { makeGoblin } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { callCreature, callCreatureStream } from "./openai-client.js";
import { makeThinkingRelay } from "./streaming.js";
import type { Loot, OutputFormat, Personality } from "./types.js";
import type { Hoard } from "./hoard.js";

export function buildDebatePrompt(opts: {
  task: string;
  selfIndex: number;
  selfOutput: string;
  selfPersonality: Personality;
  peerOutputs: { index: number; personality: Personality; output: string }[];
}): string {
  const lines: string[] = [];
  lines.push(`Debate round.`);
  lines.push(``);
  lines.push(`Original task:`);
  lines.push(opts.task);
  lines.push(``);
  lines.push(`You are Goblin #${opts.selfIndex} (${opts.selfPersonality}). Your first attempt was:`);
  lines.push(opts.selfOutput);
  lines.push(``);
  if (opts.peerOutputs.length > 0) {
    lines.push(`Your peers proposed:`);
    for (const p of opts.peerOutputs) {
      lines.push(`--- Peer Goblin #${p.index} (${p.personality}) ---`);
      lines.push(truncate(p.output, 1200));
      lines.push(``);
    }
    lines.push(
      `Cross-examine all proposals (your own and peers'). Steal what is correct, reject what is wrong, fix what is incomplete. ` +
        `If a peer's approach is genuinely better, adopt it; if your own holds, reinforce it. ` +
        `Output a complete revised answer to the original task. No preamble, no narration of your reasoning.`,
    );
  } else {
    lines.push(`(no peer outputs — debate is degenerate; revise your own answer if you spot improvements.)`);
  }
  return lines.join("\n");
}

/**
 * Run one round of debate over the existing goblin pack. Each goblin emits
 * a revised loot which is stashed and returned alongside the original.
 *
 * Returns the *revised* loots (one per original goblin). Caller decides
 * whether to use them in place of, or in addition to, the originals.
 */
export async function runDebateRound(opts: {
  riteId: string;
  task: string;
  packLoots: Loot[];
  hoard: Hoard;
  maxOutputTokensPerCall?: number;
  outputFormat?: OutputFormat;
  onSpawn?: (index: number) => void;
  onDone?: (index: number, revisedLoot: Loot) => void;
  onThink?: (index: number, cumulativeText: string) => void;
}): Promise<{ revisedLoots: Loot[] }> {
  const jobs = opts.packLoots.map((selfLoot, i) => async () => {
    opts.onSpawn?.(i);
    const peers = opts.packLoots
      .map((p, j) => ({ index: j, personality: p.personality, output: p.output }))
      .filter((_, j) => j !== i);
    const goblin = makeGoblin(selfLoot.personality);
    const userPrompt = buildDebatePrompt({
      task: opts.task,
      selfIndex: i,
      selfOutput: selfLoot.output,
      selfPersonality: selfLoot.personality,
      peerOutputs: peers,
    });

    let output: string;
    let usage;
    if (opts.onThink) {
      const onThink = opts.onThink;
      const relay = makeThinkingRelay((text) => onThink(i, text));
      const r = await callCreatureStream(goblin, userPrompt, relay.onChunk, {
        maxOutputTokens: opts.maxOutputTokensPerCall,
        outputFormat: opts.outputFormat,
      });
      relay.done();
      output = r.text;
      usage = r.usage;
    } else {
      const r = await callCreature(goblin, userPrompt, {
        maxOutputTokens: opts.maxOutputTokensPerCall,
        outputFormat: opts.outputFormat,
      });
      output = r.text;
      usage = r.usage;
    }

    const drift = measureDrift(output);
    const revised: Loot = {
      id: "",
      riteId: opts.riteId,
      creatureKind: "goblin",
      personality: selfLoot.personality,
      model: goblin.model,
      prompt: userPrompt,
      output,
      parentLootIds: [selfLoot.id, ...peers.map((p) => opts.packLoots[p.index].id)],
      timestamp: Date.now(),
      drift,
      usage,
    };
    await opts.hoard.stash(revised);
    opts.onDone?.(i, revised);
    return revised;
  });

  const revisedLoots = await Promise.all(jobs.map((fn) => fn()));
  return { revisedLoots };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
