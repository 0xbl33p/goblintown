#!/usr/bin/env node
try {
  process.loadEnvFile?.();
} catch {
  // no .env file — that's fine
}

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { printBanner } from "./banners.js";
import {
  dispatchRiteToPeer,
  MAX_PEERS,
  normalizeWarrenPeer,
  selectPeers,
  sendToWarren,
  sendToWarrenHttp,
  verifyInbox,
} from "./collab/index.js";
import {
  auditRite,
  compareRites,
  exportRiteMarkdown,
  loadRewardPlugin,
  measureDrift,
  renderLootAncestry,
  renderRiteGraph,
  reroll,
  exportRunAsMasTrace,
} from "./analysis/index.js";
import {
  MODEL_SLOTS,
  PROVIDER_PRESETS,
  CREATURE_KINDS,
  normalizeOutputFormat,
  type CreatureKind,
  type ModelSlot,
  type Personality,
  type Loot,
  type Artifact,
} from "./core/index.js";
import { buildCliHelp } from "./cli-help.js";
import {
  callCreatureStream,
  dispatchQuest,
  makeCreature,
  performRite,
  previewScan,
  scavenge,
  type RiteStep,
} from "./pipeline/index.js";
import { ensureRunDir, initWarren, loadAllRuns, loadRun, loadWarren, saveWarrenManifest } from "./storage/index.js";
import { serve } from "./server.js";

const HELP = buildCliHelp(CREATURE_KINDS);

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
    case "route":
      return cmdRoute(argv.slice(1));
    case "country":
      return cmdCountry(argv.slice(1));
    case "serve":
      return cmdServe(argv.slice(1));
    case "ancestry":
      return cmdAncestry(argv.slice(1));
    case "export-trace":
      return cmdExportTrace(argv.slice(1));
    case "plan":
      return cmdPlan(argv.slice(1));
    case "fold":
      return cmdFold(argv.slice(1));
    case "reset":
      return cmdReset(argv.slice(1));
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
  const outputFormat = normalizeOutputFormat(
    flags.format ?? w.manifest.provider?.outputFormat,
  );

  process.stdout.write(
    `Dispatching ${packSize} goblin(s) on quest "${truncate(task, 60)}"...\n`,
  );
  const t0 = Date.now();
  const result = await dispatchQuest({
    task,
    packSize,
    hoard: w.hoard,
    personality,
    outputFormat,
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
      `usage: goblintown rite "<task>" [--pack <N>] [--scan <glob>]... [--personality <p>] [--no-fallback] [--budget <tokens>] [--max-output <tokens>] [--cite <riteId>]... [--remember]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const scanGlobs = collectFlag(args, "scan");
  const cites = collectFlag(args, "cite");
  const remember = flags.remember === "true";
  const packSize = flags.pack ? Number(flags.pack) : 3;
  const personality = flags.personality as Personality | undefined;
  const noFallback = flags["no-fallback"] === "true";
  const noSpecialist = flags["no-specialist"] === "true";
  const specialistCap = flags["specialist-cap"]
    ? Number(flags["specialist-cap"])
    : undefined;
  const debate = flags.debate === "true";
  const trollTools = flags["troll-tools"] === "true";
  const budgetTokens = flags.budget ? Number(flags.budget) : undefined;
  const maxOutputTokensPerCall = flags["max-output"]
    ? Number(flags["max-output"])
    : undefined;

  const w = await loadWarren(process.cwd());
  const outputFormat = normalizeOutputFormat(
    flags.format ?? w.manifest.provider?.outputFormat,
  );
  const rewardPlugin = await loadRewardPlugin(w.root);
  if (rewardPlugin.source !== "builtin") {
    process.stdout.write(`(reward plugin: ${rewardPlugin.source})\n`);
  }

  // Phase 1+6 memory: load any --cite'd or --remember'd artifacts.
  const parentArtifacts: Artifact[] = [];
  for (const riteId of cites) {
    const a = await w.hoard.getArtifactByRiteId(riteId);
    if (a) parentArtifacts.push(a);
    else process.stderr.write(`(warning: no artifact found for rite ${riteId})\n`);
  }
  if (remember) {
    const all = await w.hoard.allArtifacts();
    const { findRelevantArtifactsEmbedded } = await import("./embeddings.js");
    const auto = (await findRelevantArtifactsEmbedded({
      artifacts: all,
      queryText: task,
      limit: 3,
      hoard: w.hoard,
    })).filter((a) => !parentArtifacts.some((p) => p.id === a.id));
    parentArtifacts.push(...auto);
  }
  if (parentArtifacts.length > 0) {
    process.stdout.write(
      `(loaded ${parentArtifacts.length} prior artifact(s): ${parentArtifacts.map((a) => a.id).join(", ")})\n`,
    );
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
    noSpecialist,
    specialistCap,
    debate,
    trollTools,
    budgetTokens,
    maxOutputTokensPerCall,
    outputFormat,
    parentArtifacts,
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
    case "artifacts:loaded":
      return `  raccoon loaded ${s.count} prior artifact(s): ${s.artifactIds.join(", ")}`;
    case "pack:start":
      return `  dispatching pack of ${s.size}...`;
    case "pack:goblin":
      return `    goblin ${s.index + 1}${s.personality ? ` [${s.personality}]` : ""} → ${s.lootId}`;
    case "debate:start":
      return `  debate round ${s.round} (size ${s.size})...`;
    case "debate:goblin":
      return `    debate goblin ${s.index + 1} → ${s.lootId}`;
    case "debate:done":
      return `  debate round ${s.round} done`;
    case "chaos:start":
      return `  gremlins running chaos pass...`;
    case "chaos:done":
      return `    gremlin → ${s.gremlinId} (on goblin ${s.goblinId})`;
    case "review:start":
      return `  troll reviewing...`;
    case "tool:calls":
      return `    troll invoking tools: ${s.calls.map((c) => c.name).join(", ")}`;
    case "tool:results":
      return `    tool results: ${s.results.map((r) => `${r.name}=${r.ok ? "ok" : "err"}`).join(", ")}`;
    case "review:verdict":
      return `    troll: ${s.verdict.passed ? "PASS" : "FAIL"} score=${s.verdict.score.toFixed(2)} (${s.verdict.lootId})`;
    case "specialist:cluster:start":
      return `  pack failed; clustering failure modes...`;
    case "specialist:cluster:done":
      return `  identified ${s.clusters.length} cluster(s): ${s.clusters.map((c) => `${c.name}[${c.severity}]`).join(", ")}`;
    case "specialist:spawn":
      return `    specialist #${s.index + 1} → focus: "${truncate(s.focus, 80)}"`;
    case "specialist:done":
      return `    specialist #${s.index + 1} delivered ${s.lootId}`;
    case "specialist:verdict":
      return `    specialist #${s.index + 1} troll: ${s.verdict.passed ? "PASS" : "FAIL"} score=${s.verdict.score.toFixed(2)}`;
    case "fallback:start":
      return `  specialists insufficient; summoning ogre...`;
    case "fallback:done":
      return `  ogre delivered ${s.lootId}`;
    case "scribe:start":
      return `  pigeon-scribe writing artifact...`;
    case "scribe:done":
      return `  artifact ${s.artifactId} stashed`;
    case "scribe:error":
      return `  ⚠ scribe failed: ${s.message}`;
    case "thinking":
      return `    [${s.slot}] thinking… ${s.text.length} chars`;
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
  if (report.artifact) {
    process.stdout.write(`\nArtifact (Phase 1):\n`);
    process.stdout.write(`  id:             ${report.artifact.id}\n`);
    process.stdout.write(`  parents:        ${report.artifact.parentArtifactIds.length}\n`);
    process.stdout.write(`  children:       ${report.artifactChildren?.length ?? 0}\n`);
    process.stdout.write(`  claims:         ${report.artifact.claims.length}\n`);
    process.stdout.write(`  open questions: ${report.artifact.openQuestions.length}\n`);
    process.stdout.write(`  next steps:     ${report.artifact.nextSteps.length}\n`);
  } else {
    process.stdout.write(`\nArtifact (Phase 1): none (scribe failed or skipped)\n`);
  }
  if ((r.specialistLootIds?.length ?? 0) > 0) {
    process.stdout.write(`\nSpecialist recovery (Phase 2): ${r.specialistLootIds!.length} specialist(s)\n`);
    for (const sid of r.specialistLootIds!) {
      const v = r.specialistVerdicts?.[sid];
      process.stdout.write(`  ${sid}  ${v ? `${v.passed ? "PASS" : "FAIL"} score=${v.score.toFixed(2)}` : "(no verdict)"}\n`);
    }
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

async function cmdRoute(args: string[]): Promise<void> {
  const sub = args[0];
  const w = await loadWarren(process.cwd());
  const routes = w.manifest.provider?.routes ?? {};
  if (!sub || sub === "ls" || sub === "list") {
    process.stdout.write(`Per-creature routes:\n`);
    for (const slot of MODEL_SLOTS) {
      const route = routes[slot];
      if (!route) {
        process.stdout.write(`  ${slot.padEnd(9)} (default provider)\n`);
        continue;
      }
      const bits = [
        `preset=${route.preset}`,
        route.model ? `model=${route.model}` : "",
        route.baseURL ? `base=${route.baseURL}` : "",
        route.apiKeyEnv ? `key=${route.apiKeyEnv}` : "",
        route.outputFormat ? `format=${route.outputFormat}` : "",
      ].filter(Boolean);
      process.stdout.write(`  ${slot.padEnd(9)} ${bits.join(" ")}\n`);
    }
    return;
  }
  if (sub === "clear") {
    const flags = parseFlags(args.slice(1));
    const slotRaw = args.slice(1).find((a) => !a.startsWith("--"));
    if (flags.all === "true") {
      w.manifest.provider = {
        ...(w.manifest.provider ?? { preset: "openai" }),
        routes: {},
      };
      await saveWarrenManifest(w);
      process.stdout.write(`Cleared all route overrides.\n`);
      return;
    }
    if (!slotRaw || !isModelSlot(slotRaw)) {
      process.stderr.write(
        `usage: goblintown route clear <${MODEL_SLOTS.join("|")}> | --all\n`,
      );
      process.exitCode = 1;
      return;
    }
    const next = { ...(w.manifest.provider?.routes ?? {}) };
    delete next[slotRaw];
    w.manifest.provider = {
      ...(w.manifest.provider ?? { preset: "openai" }),
      routes: next,
    };
    await saveWarrenManifest(w);
    process.stdout.write(`Cleared route for ${slotRaw}.\n`);
    return;
  }
  if (sub === "set") {
    const rest = args.slice(1);
    const slotRaw = rest.find((a) => !a.startsWith("--"));
    const flags = parseFlags(rest);
    if (!slotRaw || !isModelSlot(slotRaw)) {
      process.stderr.write(
        `usage: goblintown route set <${MODEL_SLOTS.join("|")}> --preset <${Object.keys(PROVIDER_PRESETS).join("|")}> [--model <name>] [--base-url <url>] [--api-key-env <ENV>] [--format freeform|markdown|json]\n`,
      );
      process.exitCode = 1;
      return;
    }
    const preset = flags.preset;
    if (!preset || !(preset in PROVIDER_PRESETS)) {
      process.stderr.write(
        `--preset is required and must be one of: ${Object.keys(PROVIDER_PRESETS).join(", ")}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const route = {
      preset: preset as keyof typeof PROVIDER_PRESETS,
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags["base-url"] ? { baseURL: flags["base-url"] } : {}),
      ...(flags["api-key-env"] ? { apiKeyEnv: flags["api-key-env"] } : {}),
      ...(flags.format
        ? { outputFormat: normalizeOutputFormat(flags.format) }
        : {}),
    };
    w.manifest.provider = {
      ...(w.manifest.provider ?? { preset: "openai" }),
      routes: {
        ...(w.manifest.provider?.routes ?? {}),
        [slotRaw]: route,
      },
    };
    await saveWarrenManifest(w);
    process.stdout.write(`Route set for ${slotRaw}: preset=${preset}\n`);
    return;
  }
  process.stderr.write(
    `usage: goblintown route [list|set|clear]\n` +
      `  set:   goblintown route set <slot> --preset <id> [--model <name>] [--base-url <url>] [--api-key-env <ENV>] [--format freeform|markdown|json]\n` +
      `  clear: goblintown route clear <slot>|--all\n`,
  );
  process.exitCode = 1;
}

async function cmdCountry(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "peer" || sub === "peers") {
    return cmdCountryPeer(args.slice(1));
  }
  if (sub === "run") {
    return cmdCountryRun(args.slice(1));
  }
  process.stderr.write(
    `usage: goblintown country peer <add|rm|ls> ...\n` +
      `   or: goblintown country run --task "..." [--peer <name>]... [--all]\n`,
  );
  process.exitCode = 1;
}

async function cmdCountryPeer(args: string[]): Promise<void> {
  const action = args[0];
  const w = await loadWarren(process.cwd());
  const peers = w.manifest.peers ?? [];
  if (!action || action === "ls" || action === "list") {
    if (peers.length === 0) {
      process.stdout.write(`No peers configured.\n`);
      return;
    }
    process.stdout.write(`Peers:\n`);
    for (const p of peers) {
      process.stdout.write(
        `  ${p.name.padEnd(16)} ${p.url}${p.note ? `  (${p.note})` : ""}\n`,
      );
    }
    return;
  }
  if (action === "add") {
    const flags = parseFlags(args.slice(1));
    const candidate = normalizeWarrenPeer({
      name: flags.name,
      url: flags.url,
      note: flags.note,
      createdAt: new Date().toISOString(),
    });
    if (!candidate) {
      process.stderr.write(
        `usage: goblintown country peer add --name <peer> --url <http://host:port> [--note "..."]\n`,
      );
      process.exitCode = 1;
      return;
    }
    const existing = peers.find(
      (p) => p.name.toLowerCase() === candidate.name.toLowerCase(),
    );
    if (!existing && peers.length >= MAX_PEERS) {
      process.stderr.write(
        `Team is full: max ${MAX_PEERS + 1} members total (lead + ${MAX_PEERS} peers).\n`,
      );
      process.exitCode = 1;
      return;
    }
    const next = existing
      ? peers.map((p) => (p.name.toLowerCase() === candidate.name.toLowerCase() ? candidate : p))
      : [...peers, candidate];
    w.manifest.peers = next;
    await saveWarrenManifest(w);
    process.stdout.write(
      `${existing ? "Updated" : "Added"} peer ${candidate.name} -> ${candidate.url}\n`,
    );
    return;
  }
  if (action === "rm" || action === "remove" || action === "del") {
    const name = args[1];
    if (!name) {
      process.stderr.write(`usage: goblintown country peer rm <peer>\n`);
      process.exitCode = 1;
      return;
    }
    const before = peers.length;
    w.manifest.peers = peers.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
    if (w.manifest.peers.length === before) {
      process.stderr.write(`No such peer: ${name}\n`);
      process.exitCode = 1;
      return;
    }
    await saveWarrenManifest(w);
    process.stdout.write(`Removed peer ${name}\n`);
    return;
  }
  process.stderr.write(
    `usage: goblintown country peer <add|rm|ls>\n` +
      `  add: goblintown country peer add --name <peer> --url <http://host:port>\n`,
  );
  process.exitCode = 1;
}

async function cmdCountryRun(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const task = flags.task;
  if (!task) {
    process.stderr.write(
      `usage: goblintown country run --task "..." [--peer <name>]... [--all] [--pack <N>] [--scan <glob>]... [--format freeform|markdown|json]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const w = await loadWarren(process.cwd());
  const peers = w.manifest.peers ?? [];
  if (peers.length === 0) {
    process.stderr.write(
      `No peers configured. Add one with:\n  goblintown country peer add --name alpha --url http://localhost:7777\n`,
    );
    process.exitCode = 1;
    return;
  }
  const peerRefs = collectFlag(args, "peer");
  const selection = selectPeers(peers, flags.all === "true" ? [] : peerRefs);
  if (selection.missing.length > 0) {
    process.stderr.write(`Unknown peer(s): ${selection.missing.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }
  const targets =
    flags.all === "true" || peerRefs.length === 0 ? peers : selection.selected;
  const packSize = flags.pack ? Number(flags.pack) : 3;
  const scanGlobs = collectFlag(args, "scan");
  const budgetTokens = flags.budget ? Number(flags.budget) : undefined;
  const maxOutputTokens = flags["max-output"] ? Number(flags["max-output"]) : undefined;
  const outputFormat = normalizeOutputFormat(
    flags.format ?? w.manifest.provider?.outputFormat,
  );

  process.stdout.write(
    `Dispatching to ${targets.length} peer(s): ${targets.map((p) => p.name).join(", ")}\n`,
  );
  const results = await Promise.allSettled(
    targets.map((peer) =>
      dispatchRiteToPeer(
        peer,
        {
          task,
          packSize,
          scanGlobs,
          personality: flags.personality as Personality | undefined,
          budgetTokens,
          maxOutputTokens,
          outputFormat,
        },
        {
          timeoutMs: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined,
        },
      ),
    ),
  );
  for (let i = 0; i < results.length; i++) {
    const peer = targets[i];
    const r = results[i];
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      process.stdout.write(`  ✗ ${peer.name} ${msg}\n`);
      continue;
    }
    const info = r.value;
    if (info.error) {
      process.stdout.write(
        `  ✗ ${peer.name} run=${info.runId} error=${info.error}\n`,
      );
      continue;
    }
    process.stdout.write(
      `  ✓ ${peer.name} run=${info.runId} rite=${info.finalRiteId ?? "?"} outcome=${info.outcome ?? "unknown"}\n`,
    );
  }
}

async function cmdServe(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const port = flags.port ? Number(flags.port) : 7777;
  await serve({ cwd: process.cwd(), port });
}

async function cmdPlan(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const task = positional[0];
  if (!task) {
    process.stderr.write(`usage: goblintown plan "<task>" [--max-nodes N] [--max-replan N] [--budget tokens] [--cite <riteId>]... [--remember]\n`);
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const cites = collectFlag(args, "cite");
  const remember = flags.remember === "true";
  const maxNodes = flags["max-nodes"] ? Number(flags["max-nodes"]) : 6;
  const maxReplan = flags["max-replan"] ? Number(flags["max-replan"]) : 2;
  const budgetTokens = flags.budget ? Number(flags.budget) : undefined;
  const maxOutputTokensPerCall = flags["max-output"] ? Number(flags["max-output"]) : undefined;

  const w = await loadWarren(process.cwd());
  const outputFormat = normalizeOutputFormat(
    flags.format ?? w.manifest.provider?.outputFormat,
  );
  const rewardPlugin = await loadRewardPlugin(w.root);

  const { findRelevantArtifacts } = await import("./artifact.js");
  const parents: Artifact[] = [];
  for (const r of cites) {
    const a = await w.hoard.getArtifactByRiteId(r);
    if (a) parents.push(a);
  }
  if (remember) {
    const all = await w.hoard.allArtifacts();
    const auto = findRelevantArtifacts(all, task, 3).filter(
      (a) => !parents.some((p) => p.id === a.id),
    );
    parents.push(...auto);
  }
  if (parents.length > 0) {
    process.stdout.write(`(loaded ${parents.length} prior artifact(s))\n`);
  }

  process.stdout.write(`Planning task...\n`);
  const { planTask } = await import("./planner.js");
  const { plan } = await planTask({
    task,
    parentArtifacts: parents,
    maxNodes,
    maxOutputTokens: maxOutputTokensPerCall,
  });
  process.stdout.write(`Plan ${plan.id}: ${plan.nodes.length} node(s)\n`);
  for (const n of plan.nodes) {
    const inputs = n.inputs.length > 0 ? ` ← [${n.inputs.join(",")}]` : "";
    process.stdout.write(`  ${n.id} (${n.kind}, pack=${n.packSize ?? 3}, ${n.personality ?? "?"}): ${truncate(n.task, 80)}${inputs}\n`);
  }
  process.stdout.write(`Executing...\n\n`);

  const { executePlan } = await import("./plan-executor.js");
  const t0 = Date.now();
  const result = await executePlan({
    plan,
    cwd: w.root,
    hoard: w.hoard,
    rewardFn: rewardPlugin.fn,
    budgetTokens,
    maxOutputTokensPerCall,
    outputFormat,
    parentArtifacts: parents,
    maxReplanDepth: maxReplan,
    onPlanEvent: (ev) => {
      if (ev.kind === "plan:node:start") process.stdout.write(`  ▸ node ${ev.nodeId} starting\n`);
      else if (ev.kind === "plan:node:done") process.stdout.write(`  ✓ node ${ev.nodeId} done — rite=${ev.riteId} outcome=${ev.outcome}${ev.artifactId ? ` artifact=${ev.artifactId}` : ""}\n`);
      else if (ev.kind === "plan:node:failed") process.stdout.write(`  ✗ node ${ev.nodeId} failed: ${ev.reason}\n`);
      else if (ev.kind === "plan:replan") process.stdout.write(`  ↻ replanning (depth ${ev.depth}): ${ev.reason}\n`);
      else if (ev.kind === "plan:done") process.stdout.write(`  ${ev.outcome === "success" ? "✓" : "✗"} plan ${ev.outcome}\n`);
    },
    onStep: (nodeId, step) => process.stdout.write(`    [${nodeId}] ${formatRiteStep(step)}\n`),
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`\nPlan finished in ${dt}s — ${result.outcome}\n`);
  if (result.finalArtifact) {
    process.stdout.write(`Final artifact: ${result.finalArtifact.id}\n`);
  }
}

async function cmdExportTrace(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const idArg = positional[0];
  if (!idArg) {
    process.stderr.write(
      `usage: goblintown export-trace <runId|riteId> [--out <path.json>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const w = await loadWarren(process.cwd());
  const runDir = await ensureRunDir(w.root);
  let run = await loadRun(runDir, idArg);
  if (!run) {
    // Allow lookup by riteId.
    const all = await loadAllRuns(runDir);
    run = all.find((r) => r.finalRiteId === idArg) ?? null;
  }
  if (!run) {
    process.stderr.write(`No run or rite found for "${idArg}".\n`);
    process.exitCode = 1;
    return;
  }
  const trace = exportRunAsMasTrace(run, w.manifest.name);
  const json = JSON.stringify(trace, null, 2);
  if (flags.out) {
    await writeFile(flags.out, json, "utf8");
    process.stdout.write(`Wrote ${flags.out} (${trace.events.length} events, ${trace.edges.length} edges).\n`);
  } else {
    process.stdout.write(json + "\n");
  }
}

async function cmdReset(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const yes = flags.yes === "true" || flags.y === "true";
  const onlyArtifacts = flags.artifacts === "true";
  const onlyRuns = flags.runs === "true";
  const onlyHoard = flags.hoard === "true";
  // Default = --all: hoard + runs.
  const all = flags.all === "true" || (!onlyArtifacts && !onlyRuns && !onlyHoard);

  const w = await loadWarren(process.cwd());
  const root = w.root;
  const targets: { label: string; path: string }[] = [];
  if (all || onlyHoard) {
    targets.push(
      { label: "loot",      path: w.hoard.lootDir },
      { label: "quests",    path: w.hoard.questDir },
      { label: "rites",     path: w.hoard.riteDir },
      { label: "artifacts", path: w.hoard.artifactDir },
      { label: "inbox",     path: w.hoard.inboxDir },
      { label: "outbox",    path: w.hoard.outboxDir },
    );
  }
  if (onlyArtifacts) {
    targets.push({ label: "artifacts", path: w.hoard.artifactDir });
  }
  if (all || onlyRuns) {
    targets.push({ label: "runs", path: join(root, ".goblintown", "runs") });
  }

  // Show what will be deleted.
  process.stdout.write(`Reset target(s) under ${root}/.goblintown/:\n`);
  let totalFiles = 0;
  for (const t of targets) {
    const n = await countFiles(t.path);
    totalFiles += n;
    process.stdout.write(`  ${t.label.padEnd(10)}  ${n} file(s)  (${t.path})\n`);
  }
  if (totalFiles === 0) {
    process.stdout.write(`Nothing to delete.\n`);
    return;
  }

  if (!yes) {
    process.stdout.write(`\nThis will delete ${totalFiles} file(s). warren.json and reward.mjs are preserved.\n`);
    process.stdout.write(`Type "RESET" to confirm: `);
    const answer = await readStdinLine();
    if (answer.trim() !== "RESET") {
      process.stdout.write(`Aborted.\n`);
      return;
    }
  }

  for (const t of targets) {
    try {
      await rm(t.path, { recursive: true, force: true });
      await mkdir(t.path, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  warning: failed to reset ${t.label}: ${msg}\n`);
    }
  }
  process.stdout.write(`Town reset (${totalFiles} file(s) cleared).\n`);
}

async function countFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, nl));
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function cmdFold(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const threshold = flags.threshold ? Number(flags.threshold) : 30;
  const minOverlap = flags["min-overlap"] ? Number(flags["min-overlap"]) : 2;
  const maxCluster = flags["max-cluster"] ? Number(flags["max-cluster"]) : 6;
  const minAgeDays = flags["min-age-days"] ? Number(flags["min-age-days"]) : 7;

  const w = await loadWarren(process.cwd());
  const { foldArtifacts } = await import("./fold.js");
  const { created, foldedInputCount } = await foldArtifacts({
    hoard: w.hoard,
    threshold,
    minOverlap,
    maxClusterSize: maxCluster,
    minAgeDays,
    onProgress: (m) => process.stdout.write(`  ${m}\n`),
  });
  process.stdout.write(`Folded ${foldedInputCount} input artifact(s) into ${created.length} summary artifact(s).\n`);
  for (const a of created) {
    process.stdout.write(`  ${a.id}  parents=${a.parentArtifactIds.length}  task="${truncate(a.task, 80)}"\n`);
  }
}

async function cmdAncestry(args: string[]): Promise<void> {
  const riteId = args.find((a) => !a.startsWith("--"));
  if (!riteId) {
    process.stderr.write(`usage: goblintown ancestry <riteId>\n`);
    process.exitCode = 1;
    return;
  }
  const w = await loadWarren(process.cwd());
  const all = await w.hoard.allArtifacts();
  const root = all.find((a) => a.riteId === riteId || a.id === riteId);
  if (!root) {
    process.stderr.write(`No artifact found for rite/id "${riteId}".\n`);
    process.exitCode = 1;
    return;
  }

  // Walk parents
  const byId = new Map(all.map((a) => [a.id, a] as const));
  const parents: typeof all = [];
  const seen = new Set<string>();
  const queue = [...root.parentArtifactIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const a = byId.get(id);
    if (!a) continue;
    parents.push(a);
    queue.push(...a.parentArtifactIds);
  }

  // Walk children (any artifact citing root in its parents)
  const children = all.filter((a) => a.parentArtifactIds.includes(root.id));

  const fmt = (a: typeof root): string =>
    `  ${a.id}  rite=${a.riteId}  outcome=${a.outcome}  task="${truncate(a.task, 70)}"`;

  process.stdout.write(`Ancestry for artifact ${root.id} (rite ${root.riteId}):\n\n`);
  if (parents.length > 0) {
    process.stdout.write(`Parents (${parents.length}):\n`);
    for (const p of parents) process.stdout.write(fmt(p) + "\n");
  } else {
    process.stdout.write(`Parents: (none — root rite)\n`);
  }
  process.stdout.write(`\nThis:\n${fmt(root)}\n`);
  if (children.length > 0) {
    process.stdout.write(`\nChildren (${children.length}):\n`);
    for (const c of children) process.stdout.write(fmt(c) + "\n");
  } else {
    process.stdout.write(`\nChildren: (none yet)\n`);
  }

  if (root.claims.length > 0) {
    process.stdout.write(`\nClaims:\n`);
    for (const c of root.claims) {
      process.stdout.write(`  - (${c.confidence}) ${c.text}\n`);
    }
  }
  if (root.openQuestions.length > 0) {
    process.stdout.write(`\nOpen questions:\n`);
    for (const q of root.openQuestions) process.stdout.write(`  - ${q}\n`);
  }
  if (root.nextSteps.length > 0) {
    process.stdout.write(`\nSuggested next steps:\n`);
    for (const n of root.nextSteps) process.stdout.write(`  - ${n}\n`);
  }
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

function isModelSlot(value: string): value is ModelSlot {
  return MODEL_SLOTS.includes(value as ModelSlot);
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
