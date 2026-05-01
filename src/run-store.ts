import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Personality } from "./types.js";

export interface RunEvent {
  seq: number;
  kind: string;
  data: unknown;
}

export interface RunRecord {
  runId: string;
  task: string;
  packSize: number;
  scanGlobs: string[];
  personality?: Personality;
  noFallback?: boolean;
  events: RunEvent[];
  done: boolean;
  finalRiteId?: string;
  outcome?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export async function ensureRunDir(warrenRoot: string): Promise<string> {
  const dir = join(warrenRoot, ".goblintown", "runs");
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveRun(dir: string, rec: RunRecord): Promise<void> {
  await writeFile(
    join(dir, `${rec.runId}.json`),
    JSON.stringify(rec, null, 2),
    "utf8",
  );
}

export async function loadRun(dir: string, runId: string): Promise<RunRecord | null> {
  try {
    const raw = await readFile(join(dir, `${runId}.json`), "utf8");
    return JSON.parse(raw) as RunRecord;
  } catch {
    return null;
  }
}

export async function loadAllRuns(dir: string): Promise<RunRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, name), "utf8");
      out.push(JSON.parse(raw) as RunRecord);
    } catch {
      // skip malformed
    }
  }
  return out;
}
