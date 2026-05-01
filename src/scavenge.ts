import { readFile, stat } from "node:fs/promises";
import { glob } from "glob";
import { relative } from "node:path";
import { makeRaccoon } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { callCreature } from "./openai-client.js";
import type { Loot, Personality } from "./types.js";
import type { Hoard } from "./hoard.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;

const IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.goblintown/**",
  "**/.git/**",
];

export interface ScavengeOptions {
  task: string;
  scanGlobs: string[];
  cwd: string;
  hoard: Hoard;
  personality?: Personality;
  riteId?: string;
}

export interface FileEntry {
  path: string;
  content: string;
  truncated: boolean;
}

export async function gatherFiles(
  cwd: string,
  patterns: string[],
): Promise<FileEntry[]> {
  const matched = new Set<string>();
  for (const pattern of patterns) {
    const hits = await glob(pattern, {
      cwd,
      absolute: true,
      nodir: true,
      ignore: IGNORE,
    });
    for (const h of hits) matched.add(h);
  }

  const out: FileEntry[] = [];
  let totalBytes = 0;
  for (const abs of [...matched].sort()) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    let info;
    try {
      info = await stat(abs);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    let content = await readFile(abs, "utf8");
    let truncated = false;
    if (content.length > MAX_FILE_BYTES) {
      content = content.slice(0, MAX_FILE_BYTES);
      truncated = true;
    }
    if (totalBytes + content.length > MAX_TOTAL_BYTES) {
      content = content.slice(0, MAX_TOTAL_BYTES - totalBytes);
      truncated = true;
    }
    totalBytes += content.length;
    out.push({ path: relative(cwd, abs), content, truncated });
  }
  return out;
}

export function formatContextDump(files: FileEntry[]): string {
  if (files.length === 0) return "(no files matched)";
  return files
    .map(
      (f) =>
        `=== ${f.path}${f.truncated ? " (truncated)" : ""} ===\n${f.content}`,
    )
    .join("\n\n");
}

export interface ScavengeResult {
  loot: Loot;
  files: FileEntry[];
  facts: string;
}

export async function scavenge(opts: ScavengeOptions): Promise<ScavengeResult> {
  const files = await gatherFiles(opts.cwd, opts.scanGlobs);
  const dump = formatContextDump(files);
  const raccoon = makeRaccoon(opts.personality);

  const fileWord = files.length === 1 ? "file" : "files";
  const userPrompt =
    `Task being prepared:\n${opts.task}\n\n` +
    `Context dump from the Warren (${files.length} ${fileWord}):\n` +
    dump +
    `\n\nReturn only the facts that matter for the task. Bullet points. Use "MISSING: ..." for anything needed but absent.`;

  const { text: output, usage } = await callCreature(raccoon, userPrompt);
  const drift = measureDrift(output);

  const loot: Loot = {
    id: "",
    riteId: opts.riteId,
    creatureKind: "raccoon",
    personality: raccoon.personality,
    model: raccoon.model,
    prompt: userPrompt,
    output,
    timestamp: Date.now(),
    drift,
    usage,
  };
  await opts.hoard.stash(loot);

  return { loot, files, facts: output };
}

export async function previewScan(
  cwd: string,
  patterns: string[],
): Promise<string[]> {
  const out = new Set<string>();
  for (const p of patterns) {
    const hits = await glob(p, {
      cwd,
      absolute: false,
      nodir: true,
      ignore: IGNORE,
    });
    for (const h of hits) out.add(h);
  }
  return [...out].sort();
}
