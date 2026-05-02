#!/usr/bin/env node
try {
  process.loadEnvFile?.();
} catch {
  // no .env file — that's fine
}

import { writeFile } from "node:fs/promises";
import { auditRite } from "./audit.js";
import { printBanner } from "./banners.js";
import { compareRites } from "./compare.js";
import { makeCreature } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { exportRiteMarkdown } from "./export.js";
import { sendToWarren, sendToWarrenHttp, verifyInbox } from "./federation.js";
import { renderLootAncestry, renderRiteGraph } from "./graph.js";
import { callCreatureStream } from "./openai-client.js";
import { dispatchQuest } from "./quest.js";
import { reroll } from "./reroll.js";
import { performRite, type RiteStep } from "./rite.js";
import { loadRewardPlugin } from "./reward-plugin.js";
import { previewScan, scavenge } from "./scavenge.js";
import { serve } from "./server.js";
import {
  CREATURE_KINDS,
  type CreatureKind,
  type Loot,
  type Personality,
} from "./types.js";
import { initWarren, loadWarren } from "./warren.js";

const HELP = `Goblintown — agent management protocol.

Usage:
  goblintown init
      Initialize a Warren in the current directory.

  goblintown summon <kind> --task "..." [--personality <p>]
      Run a single creature once. Output goes to stdout; loot is stashed.
      Kinds: ${CREATURE_KINDS.join(" ")}

  goblintown scavenge --task "..." --scan "<glob>" [--scan "<glob>"]...
      Run a Raccoon over matched files and stash the distilled facts.

  goblintown quest "<task>" [--pack <N>] [--personality <p>]
      Goblin pack with Troll arbitration. Default pack=3. Lightweight.

  goblintown rite "<task>" [--pack <N>] [--scan <glob>]... [--personality <p>] [--no-fallback]
                          [--budget <tokens>] [--max-output <tokens>]
      Full ceremony: Raccoon → Goblin pack → Gremlin chaos → Troll review → Ogre fallback.

  goblintown reroll <riteId> [--no-fallback] [--budget <tokens>]
      Re-run an existing rite with identical task / pack / personality / scan.

  goblintown export <riteId> [--out <path.md>]
      Render a Rite as a self-contained markdown document.

  goblintown compare <riteA> <riteB>
      Side-by-side comparison of two rites.

  goblintown audit <riteId>
      Walk a Rite's causal graph; report tokens, drift, longest chain, warnings.

  goblintown graph <riteId|lootId>
      Render the causal graph as ASCII (rite-shaped if it's a rite id,
      ancestry chain if it's a loot id).

  goblintown drift
      Aggregate personality-drift report across all stashed loot.

  goblintown hoard [--kind <k>] [--since <iso|ms>] [--limit <N>] [--rite <id>] [--quest <id>]
      List the contents of the Hoard, optionally filtered.

  goblintown send --to <warren-path> --loot <id> [--audience "..."]
      Pigeon-compress a Loot and deliver it to another Warren's inbox.

  goblintown inbox
      List inbox messages and verify their signatures.

  goblintown outbox
      List outbox records.

  goblintown serve [--port <N>]
      Start the Hoard web UI. Default port=7777.

Environment:
  OPENAI_API_KEY              required (except for init / drift / hoard / inbox / outbox / audit / graph / export / compare)
  GOBLINTOWN_MODEL_GOBLIN     default: gpt-5.4-mini
  GOBLINTOWN_MODEL_OGRE       default: gpt-5.5
  GOBLINTOWN_MODEL_TROLL      default: gpt-5.4-mini
  GOBLINTOWN_MAX_CONCURRENCY  default: 5 (in-flight OpenAI calls)
  (also: GREMLIN, RACCOON, PIGEON)

"OpenAI tried to put the goblins back in the box. We built the box for them."
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }

  switch (cmd) {
    case "init":
      return cmdInit();
    case "summon":
      return cmdSummon(argv.slice(1));
    case "scavenge":
      return cmdScavenge(argv.slice(1));
    case "quest":
      return cmdQuest(argv.slice(1));
    case "rite":
      return cmdRite(argv.slice(1));
    case "reroll":
      return cmdReroll(argv.slice(1));
    case "export":
      return cmdExport(argv.slice(1));
    case "compare":
      return cmdCompare(argv.slice(1));
    case "audit":
      return cmdAudit(argv.slice(1));
    case "graph":
      return cmdGraph(argv.slice(1));
    case "drift":
      return cmdDrift();
    case "hoard":
      return cmdHoard(argv.slice(1));
    case "send":
      return cmdSend(argv.slice(1));
    case "inbox":
      return cmdInbox();
    case "outbox":
      return cmdOutbox();
    case "serve":
      return cmdServe(argv.slice(1));
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

async function cmdInit(): Promise<void> {
  const w = await initWarren(process.cwd());
  process.stdout.write(
    `Warren "${w.manifest.name}" initialized at ${w.root}.\n` +
      `Hoard is empty. Summon something.\n`,
  );
}

async function cmdSummon(args: string[]): Promise<void> {
  const kind = args[0] as CreatureKind | undefined;
  if (!kind || !CREATURE_KINDS.includes(kind)) {
    process.stderr.write(
      `usage: goblintown summon <${CREATURE_KINDS.join("|")}> --task "..." [--personality <p>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args.slice(1));
  const task = flags.task;
  if (!task) {
    process.stderr.write(`--task is required\n`);
    process.exitCode = 1;
    return;
  }
  const personality = flags.personality as Personality | undefined;
  const creature = makeCreature(kind, personality);

  printBanner(kind);

  const { text, usage } = await callCreatureStream(creature, task, (chunk) => {
    process.stdout.write(chunk);
  });
  process.stdout.write("\n");

  try {
    const w = await loadWarren(process.cwd());
    const drift = measureDrift(text);
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
    await w.hoard.stash(loot);
    process.stdout.write(
      `\n— drift —\n` +
        `  cross-creature words: ${drift.totalCreatureWords} / ${drift.outputWordCount}` +
        `  rate=${drift.driftRate.toFixed(4)}\n` +
        `  ${formatMentions(drift.creatureMentions)}\n` +
        `  loot: ${loot.id}  tokens: ${usage.totalTokens}\n`,
    );
  } catch {
    // No Warren — print the drift report anyway, just don't stash.
    const drift = measureDrift(text);
    process.stdout.write(
      `\n— drift —\n` +
        `  cross-creature words: ${drift.totalCreatureWords} / ${drift.outputWordCount}` +
        `  rate=${drift.driftRate.toFixed(4)}\n` +
        `  ${formatMentions(drift.creatureMentions)}\n` +
        `  (no Warren — loot not stashed; tokens=${usage.totalTokens})\n`,
    );
  }
}

async function cmdScavenge(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const scanGlobs = collectFlag(args, "scan");
  const task = flags.task;
  if (!task || scanGlobs.length === 0) {
    process.stderr.write(
      `usage: goblintown scavenge --task "..." --scan "<glob>" [--scan "<glob>"]...\n`,
    );
    process.exitCode = 1;
    return;
  }
  const w = await loadWarren(process.cwd());
  if (flags.preview === "true") {
    const paths = await previewScan(w.root, scanGlobs);
    process.stdout.write(
      `Would scan ${paths.length} file(s):\n${paths.map((p) => "  " + p).join("\n")}\n`,
    );
    return;
  }
  const result = await scavenge({
    task,
    scanGlobs,
    cwd: w.root,
    hoard: w.hoard,
    personality: flags.personality as Personality | undefined,
  });
  process.stdout.write(
    `Raccoon scavenged ${result.files.length} file(s). Loot: ${result.loot.id}\n\n` +
      `${result.facts}\n`,
  );
}

async function cmdQuest(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const task = positional[0];
  if (!task) {
    process.stderr.write(
      `usage: goblintown quest "<task>" [--pack <N>] [--personality <p>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const packSize = flags.pack ? Number(flags.pack) : 3;
  const personality = flags.personality as Personality | undefined;

  const w = await loadWarren(process.cwd());

  process.stdout.write(
    `Dispatching ${packSize} goblin(s) on quest "${truncate(task, 60)}"...\n`,
  );
  const t0 = Date.now();
  const result = await dispatchQuest({
    task,
    packSize,
    hoard: w.hoard,
    personality,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  process.stdout.write(
    `\nQuest ${result.quest.id} finished in ${dt}s.\n\n`,
  );
  for (const l of result.loot) {
    const v = result.quest.trollVerdicts[l.id];
    const tag = l.id === result.winner.id ? "  <-- WINNER" : "";
    process.stdout.write(
      `  ${l.id}  shinies=${(l.reward ?? 0).toFixed(3)}  ` +
        `troll=${v.score.toFixed(2)} ${v.passed ? "PASS" : "FAIL"}  ` +
        `drift=${l.drift.driftRate.toFixed(4)}${tag}\n`,
    );
    process.stdout.write(`     critique: ${truncate(v.critique, 120)}\n`);
  }
  process.stdout.write(`\n— winning loot —\n\n${result.winner.output}\n`);
}

async function cmdRite(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const task = positional[0];
  if (!task) {
    process.stderr.write(
      `usage: goblintown rite "<task>" [--pack <N>] [--scan <glob>]... [--personality <p>] [--no-fallback] [--budget <tokens>] [--max-output <tokens>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const scanGlobs = collectFlag(args, "scan");
  const packSize = flags.pack ? Number(flags.pack) : 3;
  const personality = flags.personality as Personality | undefined;
  const noFallback = flags["no-fallback"] === "true";
  const budgetTokens = flags.budget ? Number(flags.budget) : undefined;
  const maxOutputTokensPerCall = flags["max-output"]
    ? Number(flags["max-output"])
    : undefined;

  const w = await loadWarren(process.cwd());
  const rewardPlugin = await loadRewardPlugin(w.root);
  if (rewardPlugin.source !== "builtin") {
    process.stdout.write(`(reward plugin: ${rewardPlugin.source})\n`);
  }
  process.stdout.write(
    `Beginning rite (pack=${packSize}, scan=${scanGlobs.length} glob(s)` +
      `${budgetTokens ? `, budget=${budgetTokens}` : ""})...\n`,
  );

  const t0 = Date.now();
  const result = await performRite({
    task,
    packSize,
    scanGlobs,
    cwd: w.root,
    hoard: w.hoard,
    personality,
    rewardFn: rewardPlugin.fn,
    noFallback,
    budgetTokens,
    maxOutputTokensPerCall,
    onStep: (s) => process.stdout.write(formatRiteStep(s) + "\n"),
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  process.stdout.write(`\nRite ${result.rite.id} finished in ${dt}s — ${result.rite.outcome}.\n\n`);

  for (const gid of result.rite.goblinLootIds) {
    const v = result.rite.trollVerdicts[gid];
    const tag = gid === result.rite.winnerLootId ? "  <-- WINNER" : "";
    const tline =
      v
        ? `troll=${v.score.toFixed(2)} ${v.passed ? "PASS" : "FAIL"}`
        : "troll=—";
    process.stdout.write(`  goblin ${gid}  ${tline}${tag}\n`);
    if (v?.critique) {
      process.stdout.write(`    critique: ${truncate(v.critique, 120)}\n`);
    }
  }
  if (result.rite.ogreLootId) {
    process.stdout.write(`  ogre   ${result.rite.ogreLootId}  (fallback)\n`);
  }

  process.stdout.write(`\n— winning loot —\n\n${result.winnerLoot.output}\n`);
}

function formatRiteStep(s: RiteStep): string {
  switch (s.kind) {
    case "scavenge:start":
      return `  raccoon scavenging (${s.globs.length} glob(s))...`;
    case "scavenge:done":
      return `  raccoon stashed ${s.lootId} (${s.fileCount} file(s))`;
    case "pack:start":
      return `  dispatching pack of ${s.size}...`;
    case "pack:goblin":
      return `    goblin ${s.index + 1} → ${s.lootId}`;
    case "chaos:start":
      return `  gremlins running chaos pass...`;
    case "chaos:done":
      return `    gremlin → ${s.gremlinId} (on goblin ${s.goblinId})`;
    case "review:start":
      return `  troll reviewing...`;
    case "review:verdict":
      return `    troll: ${s.verdict.passed ? "PASS" : "FAIL"} score=${s.verdict.score.toFixed(2)} (${s.verdict.lootId})`;
    case "fallback:start":
      return `  pack failed; summoning ogre...`;
    case "fallback:done":
      return `  ogre delivered ${s.lootId}`;
    case "budget:exceeded":
      return `  ⚠ budget exceeded at ${s.phase}: used ${s.used} / cap ${s.cap}`;
    case "rite:done":
      return `  rite outcome: ${s.outcome}`;
  }
}

async function cmdReroll(args: string[]): Promise<void> {
  const riteId = args.find((a) => !a.startsWith("--"));
  if (!riteId) {
    process.stderr.write(
      `usage: goblintown reroll <riteId> [--no-fallback] [--budget <tokens>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const w = await loadWarren(process.cwd());
  const rewardPlugin = await loadRewardPlugin(w.root);
  const original = await w.hoard.getRite(riteId);
  if (!original) {
    process.stderr.write(`Rite ${riteId} not found.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Rerolling rite ${riteId}\n` +
      `  task: "${truncate(original.task, 80)}"\n` +
      `  pack=${original.packSize}  personality=${original.personality}\n`,
  );
  const t0 = Date.now();
  const result = await reroll({
    riteId,
    cwd: w.root,
    hoard: w.hoard,
    rewardFn: rewardPlugin.fn,
    noFallback: flags["no-fallback"] === "true",
    budgetTokens: flags.budget ? Number(flags.budget) : undefined,
    onStep: (s) => process.stdout.write(formatRiteStep(s) + "\n"),
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(
    `\nNew rite ${result.rite.id} (${result.rite.outcome}) in ${dt}s.\n` +
      `Compare: goblintown compare ${riteId} ${result.rite.id}\n`,
  );
}

async function cmdExport(args: string[]): Promise<void> {
  const riteId = args.find((a) => !a.startsWith("--"));
  if (!riteId) {
    process.stderr.write(
      `usage: goblintown export <riteId> [--out <path.md>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const w = await loadWarren(process.cwd());
  const md = await exportRiteMarkdown(w.hoard, riteId);
  if (!md) {
    process.stderr.write(`Rite ${riteId} not found.\n`);
    process.exitCode = 1;
    return;
  }
  if (flags.out) {
    await writeFile(flags.out, md, "utf8");
    process.stdout.write(`Wrote ${md.length} bytes to ${flags.out}\n`);
  } else {
    process.stdout.write(md);
    if (!md.endsWith("\n")) process.stdout.write("\n");
  }
}

async function cmdCompare(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const [a, b] = positional;
  if (!a || !b) {
    process.stderr.write(`usage: goblintown compare <riteA> <riteB>\n`);
    process.exitCode = 1;
    return;
  }
  const w = await loadWarren(process.cwd());
  const report = await compareRites(w.hoard, a, b);
  if (!report) {
    process.stderr.write(`One or both rites not found (${a}, ${b}).\n`);
    process.exitCode = 1;
    return;
  }
  const fmt = (label: string, x: typeof report.a) =>
    `${label} ${x.rite.id}\n` +
    `  outcome:        ${x.rite.outcome}\n` +
    `  pack:           ${x.rite.packSize}\n` +
    `  personality:    ${x.rite.personality}\n` +
    `  total loot:     ${x.totalLoot}\n` +
    `  total tokens:   ${x.totalTokens}\n` +
    `  avg drift rate: ${x.avgDriftRate.toFixed(4)}\n` +
    `  pass rate:      ${(x.passRate * 100).toFixed(0)}%\n`;
  process.stdout.write(
    fmt("A:", report.a) + "\n" + fmt("B:", report.b) + "\n",
  );
  process.stdout.write(
    `task identical: ${report.taskMatches ? "yes" : "no"}\n\n`,
  );
  if (report.a.winner) {
    process.stdout.write(
      `--- winner of A (${report.a.winner.id}) ---\n${report.a.winner.output}\n\n`,
    );
  }
  if (report.b.winner) {
    process.stdout.write(
      `--- winner of B (${report.b.winner.id}) ---\n${report.b.winner.output}\n`,
    );
  }
}

async function cmdAudit(args: string[]): Promise<void> {
  const riteId = args[0];
  if (!riteId) {
    process.stderr.write(`usage: goblintown audit <riteId>\n`);
    process.exitCode = 1;
    return;
  }
  const w = await loadWarren(process.cwd());
  const report = await auditRite(w.hoard, riteId);
  if (!report) {
    process.stderr.write(`Rite ${riteId} not found.\n`);
    process.exitCode = 1;
    return;
  }
  const r = report.rite;
  process.stdout.write(
    `Audit of rite ${r.id}\n` +
      `  outcome:        ${r.outcome}\n` +
      `  task:           "${truncate(r.task, 80)}"\n` +
      `  total loot:     ${report.totalLoot}\n` +
      `  tokens:         total=${report.totalTokens} prompt=${report.promptTokens} completion=${report.completionTokens}\n` +
      `  longest chain:  depth=${report.longestChain.length}  ${report.longestChain.lootIds.join(" → ")}\n` +
      `  highest drift:  ${
        report.highestDrift
          ? `${report.highestDrift.kind} ${report.highestDrift.lootId} rate=${report.highestDrift.rate.toFixed(4)}`
          : "(none)"
      }\n\n`,
  );
  process.stdout.write(`By creature kind:\n`);
  for (const [kind, stats] of Object.entries(report.byKind)) {
    if (stats.count === 0) continue;
    process.stdout.write(
      `  ${kind.padEnd(8)} n=${stats.count}  tokens=${stats.totalTokens}  ` +
        `avg drift=${stats.avgDriftRate.toFixed(4)}  avg shinies=${stats.avgRewardOrZero.toFixed(3)}\n`,
    );
  }
  if (report.warnings.length > 0) {
    process.stdout.write(`\nWarnings:\n`);
    for (const w of report.warnings) process.stdout.write(`  ⚠ ${w}\n`);
  }
}

async function cmdGraph(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    process.stderr.write(`usage: goblintown graph <riteId|lootId>\n`);
    process.exitCode = 1;
    return;
  }
  const w = await loadWarren(process.cwd());
  const riteRendered = await renderRiteGraph(w.hoard, id);
  if (riteRendered) {
    process.stdout.write(riteRendered + "\n");
    return;
  }
  const lootRendered = await renderLootAncestry(w.hoard, id);
  if (lootRendered) {
    process.stdout.write(lootRendered + "\n");
    return;
  }
  process.stderr.write(`No rite or loot found with id ${id}.\n`);
  process.exitCode = 1;
}

async function cmdDrift(): Promise<void> {
  const w = await loadWarren(process.cwd());
  const all = await w.hoard.allLoot();
  if (all.length === 0) {
    process.stdout.write(`Hoard is empty.\n`);
    return;
  }
  process.stdout.write(`Hoard contains ${all.length} loot drop(s).\n\n`);

  const byKind = new Map<CreatureKind, number[]>();
  for (const k of CREATURE_KINDS) byKind.set(k, []);
  for (const l of all) byKind.get(l.creatureKind)?.push(l.drift.driftRate);

  process.stdout.write(
    `Drift rate by creature kind (cross-creature mentions / total words):\n`,
  );
  for (const k of CREATURE_KINDS) {
    const rates = byKind.get(k) ?? [];
    if (rates.length === 0) {
      process.stdout.write(`  ${k.padEnd(8)} (n=0)\n`);
      continue;
    }
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    process.stdout.write(
      `  ${k.padEnd(8)} avg=${avg.toFixed(4)}  n=${rates.length}\n`,
    );
  }
  process.stdout.write(
    `\nReminder: high cross-creature drift means your reward signal is leaking.\n` +
      `That is the exact bug from the Incident. Tune accordingly.\n`,
  );
}

async function cmdHoard(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const w = await loadWarren(process.cwd());
  const limit = flags.limit ? Math.max(1, Number(flags.limit)) : Infinity;
  const since = flags.since ? parseTimestamp(flags.since) : null;
  const kind = flags.kind as CreatureKind | undefined;
  const filterRite = flags.rite;
  const filterQuest = flags.quest;

  if (kind && !CREATURE_KINDS.includes(kind)) {
    process.stderr.write(`unknown --kind: ${kind}\n`);
    process.exitCode = 1;
    return;
  }

  let loot = await w.hoard.allLoot();
  if (kind) loot = loot.filter((l) => l.creatureKind === kind);
  if (since !== null) loot = loot.filter((l) => l.timestamp >= since);
  if (filterRite) loot = loot.filter((l) => l.riteId === filterRite);
  if (filterQuest) loot = loot.filter((l) => l.questId === filterQuest);
  loot.sort((a, b) => b.timestamp - a.timestamp);
  if (Number.isFinite(limit)) loot = loot.slice(0, limit);

  let rites = await w.hoard.allRites();
  if (since !== null) rites = rites.filter((r) => r.startedAt >= since);
  rites.sort((a, b) => b.startedAt - a.startedAt);

  let quests = await w.hoard.allQuests();
  if (since !== null) quests = quests.filter((q) => q.startedAt >= since);
  quests.sort((a, b) => b.startedAt - a.startedAt);

  process.stdout.write(
    `Hoard at ${w.root}\n` +
      `  loot:   ${loot.length}${kind ? ` (kind=${kind})` : ""}` +
      `${since !== null ? ` (since=${new Date(since).toISOString()})` : ""}\n` +
      `  quests: ${quests.length}\n` +
      `  rites:  ${rites.length}\n\n`,
  );

  if (kind || filterRite || filterQuest || since !== null) {
    for (const l of loot) {
      const tokens = l.usage ? `tokens=${l.usage.totalTokens} ` : "";
      process.stdout.write(
        `  ${l.creatureKind.padEnd(8)} ${l.id}  ${tokens}drift=${l.drift.driftRate.toFixed(4)}` +
          ` ${new Date(l.timestamp).toISOString()}\n`,
      );
    }
    return;
  }

  for (const r of rites) {
    process.stdout.write(
      `  rite  ${r.id}  ${r.outcome.padEnd(15)}  pack=${r.packSize}\n` +
        `    "${truncate(r.task, 80)}"\n`,
    );
  }
  for (const q of quests) {
    process.stdout.write(
      `  quest ${q.id}  pack=${q.packSize}  winner=${q.winnerLootId ?? "—"}\n` +
        `    "${truncate(q.task, 80)}"\n`,
    );
  }
}

function parseTimestamp(raw: string): number {
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && raw.trim().length > 0) {
    // 10-digit values are seconds; longer values are milliseconds
    if (raw.length <= 10) return asNum * 1000;
    return asNum;
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Could not parse --since value: ${raw}`);
}

async function cmdSend(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const to = flags.to;
  const lootId = flags.loot;
  if (!to || !lootId) {
    process.stderr.write(
      `usage: goblintown send --to <warren-path-or-url> --loot <id> [--audience "..."]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const w = await loadWarren(process.cwd());
  const isUrl = /^https?:\/\//i.test(to);
  if (isUrl) {
    const result = await sendToWarrenHttp({
      fromWarrenName: w.manifest.name,
      fromHoard: w.hoard,
      fromPeerSecret: w.manifest.peerSecret,
      toUrl: to,
      sourceLootId: lootId,
      audience: flags.audience,
      personality: flags.personality as Personality | undefined,
    });
    process.stdout.write(
      `Pigeon delivered to ${to} (remote id ${result.remoteId}).\n` +
        `  source loot:  ${result.outbox.sourceLootId}\n` +
        `  pigeon loot:  ${result.outbox.pigeonLootId}\n` +
        `  signature:    ${result.outbox.signature}\n`,
    );
    return;
  }
  const result = await sendToWarren({
    fromWarrenName: w.manifest.name,
    fromHoard: w.hoard,
    fromPeerSecret: w.manifest.peerSecret,
    toWarrenPath: to,
    sourceLootId: lootId,
    audience: flags.audience,
    personality: flags.personality as Personality | undefined,
  });
  process.stdout.write(
    `Pigeon delivered ${result.outbox.id} to ${result.deliveredTo}.\n` +
      `  source loot:  ${result.outbox.sourceLootId}\n` +
      `  pigeon loot:  ${result.outbox.pigeonLootId}\n` +
      `  signature:    ${result.outbox.signature}\n`,
  );
}

async function cmdInbox(): Promise<void> {
  const w = await loadWarren(process.cwd());
  const msgs = (await w.hoard.allInbox()).sort(
    (a, b) => b.receivedAt - a.receivedAt,
  );
  if (msgs.length === 0) {
    process.stdout.write(`Inbox empty.\n`);
    return;
  }
  for (const m of msgs) {
    const ok = verifyInbox(m, w.manifest.peerSecret);
    process.stdout.write(
      `${m.id}  from=${m.fromWarren}  audience="${m.audience}"  ${ok ? "VERIFIED" : "BAD-SIG"}\n` +
        `  ${truncate(m.body, 200)}\n`,
    );
  }
}

async function cmdOutbox(): Promise<void> {
  const w = await loadWarren(process.cwd());
  const recs = (await w.hoard.allOutbox()).sort(
    (a, b) => b.sentAt - a.sentAt,
  );
  if (recs.length === 0) {
    process.stdout.write(`Outbox empty.\n`);
    return;
  }
  for (const r of recs) {
    process.stdout.write(
      `${r.id}  to=${r.toWarren}  source=${r.sourceLootId}  pigeon=${r.pigeonLootId}\n`,
    );
  }
}

async function cmdServe(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const port = flags.port ? Number(flags.port) : 7777;
  await serve({ cwd: process.cwd(), port });
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function collectFlag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] && !args[i + 1].startsWith("--")) {
      out.push(args[i + 1]);
      i++;
    }
  }
  return out;
}

function formatMentions(m: Record<CreatureKind, number>): string {
  return CREATURE_KINDS.map((k) => `${k}:${m[k]}`).join(" ");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

main().catch((err) => {
  process.stderr.write(`\nGoblintown error: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
