import { open, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Personality } from "./types.js";

export type RunMode = "rite" | "plan";
export type RunStatus = "running" | "done" | "error" | "interrupted";

export interface RunEvent {
  seq: number;
  kind: string;
  data: unknown;
}

export interface RunCheckpoint {
  mode?: RunMode;
  phase: string;
  lastEventKind: string;
  lastEventSeq: number;
  updatedAt: number;
  nodeId?: string;
  planNodeIds?: string[];
  completedNodeIds?: string[];
  failedNodeIds?: string[];
  lootIds?: string[];
  artifactIds?: string[];
  finalRiteId?: string;
}

export interface RunStartRequest {
  mode: RunMode;
  payload: Record<string, unknown>;
}

export interface RunRecord {
  runId: string;
  task: string;
  packSize: number;
  scanGlobs: string[];
  personality?: Personality;
  noFallback?: boolean;
  mode?: RunMode;
  status?: RunStatus;
  request?: RunStartRequest;
  checkpoint?: RunCheckpoint;
  resumable?: boolean;
  resumePrompt?: string;
  resumedFromRunId?: string;
  resumedByRunId?: string;
  nextSeq?: number;
  eventsCompacted?: boolean;
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

const MAX_PERSISTED_THINKING_TEXT = 8_000;
const MAX_LEGACY_JSON_BYTES = 16 * 1024 * 1024;
const LEGACY_SAMPLE_BYTES = 256 * 1024;

export async function saveRun(dir: string, rec: RunRecord): Promise<void> {
  const compact = compactRunRecord(rec);
  await writeFile(
    join(dir, `${rec.runId}.json`),
    JSON.stringify(compact, null, 2),
    "utf8",
  );
}

export async function loadRun(dir: string, runId: string): Promise<RunRecord | null> {
  try {
    const path = join(dir, `${runId}.json`);
    return await readRunFile(path);
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
      const rec = await readRunFile(join(dir, name));
      out.push(rec);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function appendRunEvent(
  rec: RunRecord,
  kind: string,
  data: unknown,
  now = Date.now(),
): RunEvent {
  const seq = rec.nextSeq ?? rec.events.length;
  const liveEvent = { seq, kind, data };
  rec.nextSeq = seq + 1;

  const storedEvent = compactRunEvent(liveEvent);
  const compactKey = thinkingEventKey(storedEvent);
  if (compactKey) {
    const existing = rec.events.findIndex((ev) => thinkingEventKey(ev) === compactKey);
    if (existing >= 0) {
      rec.events.splice(existing, 1);
    }
    rec.events.push(storedEvent);
    rec.eventsCompacted = true;
  } else {
    rec.events.push(storedEvent);
  }

  updateCheckpointFromEvent(rec, storedEvent, now);
  return liveEvent;
}

export function markRunInterrupted(rec: RunRecord, now = Date.now()): void {
  rec.done = true;
  rec.status = "interrupted";
  rec.resumable = true;
  rec.error = rec.error ?? "interrupted (server restarted)";
  rec.finishedAt = rec.finishedAt ?? now;
  rec.resumePrompt = buildResumePrompt(rec);
}

export function markRunFinished(
  rec: RunRecord,
  status: Exclude<RunStatus, "running" | "interrupted">,
  now = Date.now(),
): void {
  rec.done = true;
  rec.status = status;
  rec.resumable = status === "error";
  rec.finishedAt = now;
  if (rec.resumable) rec.resumePrompt = buildResumePrompt(rec);
}

export function buildResumePrompt(rec: RunRecord): string {
  const mode = rec.mode ?? rec.request?.mode ?? "rite";
  const checkpoint = rec.checkpoint;
  const lines = [
    `Continue the interrupted ${mode} run ${rec.runId}.`,
    `Original task: ${truncateForPrompt(rec.task, 1_200)}`,
  ];
  if (rec.error) {
    lines.push(`Last error: ${truncateForPrompt(rec.error, 500)}`);
  }
  if (checkpoint) {
    lines.push(`Last durable phase: ${checkpoint.phase}.`);
    if (checkpoint.nodeId) lines.push(`Last plan node: ${checkpoint.nodeId}.`);
    if (checkpoint.completedNodeIds?.length) {
      lines.push(`Completed plan nodes: ${checkpoint.completedNodeIds.join(", ")}.`);
    }
    if (checkpoint.failedNodeIds?.length) {
      lines.push(`Failed plan nodes: ${checkpoint.failedNodeIds.join(", ")}.`);
    }
    if (checkpoint.lootIds?.length) {
      lines.push(`Known loot IDs: ${checkpoint.lootIds.slice(-8).join(", ")}.`);
    }
    if (checkpoint.artifactIds?.length) {
      lines.push(`Known artifact IDs: ${checkpoint.artifactIds.slice(-8).join(", ")}.`);
    }
    if (checkpoint.finalRiteId) lines.push(`Last rite ID: ${checkpoint.finalRiteId}.`);
  }
  lines.push(
    "Resume from the next useful checkpoint. Do not replay already completed work unless it is needed to recover context. Produce a final user-observable result.",
  );
  return lines.join("\n");
}

function compactRunRecord(rec: RunRecord): RunRecord {
  const copy: RunRecord = {
    ...rec,
    nextSeq: rec.nextSeq ?? rec.events.length,
    events: compactRunEvents(rec.events),
  };
  if (copy.events.length !== rec.events.length) copy.eventsCompacted = true;
  return copy;
}

function compactRunEvents(events: RunEvent[]): RunEvent[] {
  const out: RunEvent[] = [];
  const thinkingIndexes = new Map<string, number>();
  for (const ev of events) {
    const compact = compactRunEvent(ev);
    const key = thinkingEventKey(compact);
    if (!key) {
      out.push(compact);
      continue;
    }
    const existing = thinkingIndexes.get(key);
    if (existing !== undefined) {
      out.splice(existing, 1);
      for (const [knownKey, index] of thinkingIndexes.entries()) {
        if (index > existing) thinkingIndexes.set(knownKey, index - 1);
      }
    }
    thinkingIndexes.set(key, out.length);
    out.push(compact);
  }
  return out;
}

function compactRunEvent(ev: RunEvent): RunEvent {
  const data = compactThinkingData(ev.data);
  if (data === ev.data) return ev;
  return { ...ev, data };
}

function compactThinkingData(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if (data.kind === "thinking" && typeof data.text === "string") {
    return { ...data, text: trimThinkingText(data.text) };
  }
  if (isRecord(data.step) && data.step.kind === "thinking" && typeof data.step.text === "string") {
    return {
      ...data,
      step: { ...data.step, text: trimThinkingText(data.step.text) },
    };
  }
  return data;
}

function trimThinkingText(text: string): string {
  if (text.length <= MAX_PERSISTED_THINKING_TEXT) return text;
  return `[truncated]\n${text.slice(-MAX_PERSISTED_THINKING_TEXT)}`;
}

function thinkingEventKey(ev: RunEvent): string | null {
  if (!isRecord(ev.data)) return null;
  if (ev.kind === "step" && ev.data.kind === "thinking") {
    return `step:${String(ev.data.slot ?? "default")}`;
  }
  if (ev.kind === "step" && isRecord(ev.data.step) && ev.data.step.kind === "thinking") {
    return `plan-step:${String(ev.data.nodeId ?? "node")}:${String(ev.data.step.slot ?? "default")}`;
  }
  return null;
}

function updateCheckpointFromEvent(rec: RunRecord, ev: RunEvent, now: number): void {
  const info = eventCheckpointInfo(ev);
  if (!info) return;
  const prev = rec.checkpoint;
  const checkpoint: RunCheckpoint = {
    mode: rec.mode ?? rec.request?.mode ?? prev?.mode,
    phase: info.phase,
    lastEventKind: info.lastEventKind,
    lastEventSeq: ev.seq,
    updatedAt: now,
    nodeId: info.nodeId ?? prev?.nodeId,
    planNodeIds: mergeIds(prev?.planNodeIds, info.planNodeIds),
    completedNodeIds: mergeIds(prev?.completedNodeIds, info.completedNodeIds),
    failedNodeIds: mergeIds(prev?.failedNodeIds, info.failedNodeIds),
    lootIds: mergeIds(prev?.lootIds, info.lootIds),
    artifactIds: mergeIds(prev?.artifactIds, info.artifactIds),
    finalRiteId: info.finalRiteId ?? prev?.finalRiteId,
  };
  rec.checkpoint = dropEmptyCheckpointArrays(checkpoint);
}

function eventCheckpointInfo(ev: RunEvent): {
  phase: string;
  lastEventKind: string;
  nodeId?: string;
  planNodeIds?: string[];
  completedNodeIds?: string[];
  failedNodeIds?: string[];
  lootIds?: string[];
  artifactIds?: string[];
  finalRiteId?: string;
} | null {
  if (ev.kind === "step" && isRecord(ev.data)) {
    if (isRecord(ev.data.step)) {
      return stepCheckpointInfo(ev.data.step, stringValue(ev.data.nodeId));
    }
    return stepCheckpointInfo(ev.data);
  }

  if (ev.kind === "plan:built" && isRecord(ev.data) && isRecord(ev.data.plan)) {
    const nodes = Array.isArray(ev.data.plan.nodes) ? ev.data.plan.nodes : [];
    return {
      phase: "plan:built",
      lastEventKind: ev.kind,
      planNodeIds: nodes
        .map((n) => (isRecord(n) ? stringValue(n.id) : undefined))
        .filter((id): id is string => !!id),
    };
  }
  if (ev.kind === "plan:node:start" && isRecord(ev.data)) {
    return {
      phase: "plan:node:start",
      lastEventKind: ev.kind,
      nodeId: stringValue(ev.data.nodeId),
    };
  }
  if (ev.kind === "plan:node:done" && isRecord(ev.data)) {
    return {
      phase: "plan:node:done",
      lastEventKind: ev.kind,
      nodeId: stringValue(ev.data.nodeId),
      completedNodeIds: maybeOne(stringValue(ev.data.nodeId)),
      finalRiteId: stringValue(ev.data.riteId),
    };
  }
  if (ev.kind === "plan:node:failed" && isRecord(ev.data)) {
    return {
      phase: "plan:node:failed",
      lastEventKind: ev.kind,
      nodeId: stringValue(ev.data.nodeId),
      failedNodeIds: maybeOne(stringValue(ev.data.nodeId)),
    };
  }
  if (ev.kind === "done" && isRecord(ev.data)) {
    return {
      phase: "done",
      lastEventKind: ev.kind,
      finalRiteId: stringValue(ev.data.riteId),
      lootIds: maybeOne(stringValue(ev.data.winnerLootId) ?? stringValue(ev.data.finalLootId)),
      artifactIds: maybeOne(stringValue(ev.data.finalArtifactId)),
    };
  }
  if (ev.kind.startsWith("plan:")) {
    return { phase: ev.kind, lastEventKind: ev.kind };
  }
  return null;
}

function stepCheckpointInfo(step: Record<string, unknown>, nodeId?: string): ReturnType<typeof eventCheckpointInfo> {
  const kind = stringValue(step.kind);
  if (!kind) return null;
  return {
    phase: kind,
    lastEventKind: `step:${kind}`,
    nodeId,
    lootIds: [
      stringValue(step.lootId),
      stringValue(step.winnerLootId),
      stringValue(step.gremlinId),
      stringValue(step.finalLootId),
    ].filter((id): id is string => !!id),
    artifactIds: maybeOne(stringValue(step.artifactId) ?? stringValue(step.finalArtifactId)),
    finalRiteId: stringValue(step.riteId),
  };
}

function dropEmptyCheckpointArrays(checkpoint: RunCheckpoint): RunCheckpoint {
  const out = { ...checkpoint };
  if (!out.planNodeIds?.length) delete out.planNodeIds;
  if (!out.completedNodeIds?.length) delete out.completedNodeIds;
  if (!out.failedNodeIds?.length) delete out.failedNodeIds;
  if (!out.lootIds?.length) delete out.lootIds;
  if (!out.artifactIds?.length) delete out.artifactIds;
  if (!out.nodeId) delete out.nodeId;
  if (!out.finalRiteId) delete out.finalRiteId;
  return out;
}

function mergeIds(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  if (!existing?.length && !incoming?.length) return undefined;
  const merged = new Set<string>(existing ?? []);
  for (const id of incoming ?? []) {
    if (id) merged.add(id);
  }
  return [...merged];
}

function maybeOne(value: string | undefined): string[] | undefined {
  return value ? [value] : undefined;
}

function truncateForPrompt(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

async function readRunFile(path: string): Promise<RunRecord> {
  const file = await stat(path);
  if (file.size > MAX_LEGACY_JSON_BYTES) {
    return readLargeLegacyRun(path, file.size);
  }
  const raw = await readFile(path, "utf8");
  return normalizeLoadedRecord(JSON.parse(raw) as RunRecord);
}

async function readLargeLegacyRun(path: string, size: number): Promise<RunRecord> {
  const handle = await open(path, "r");
  try {
    const headSize = Math.min(LEGACY_SAMPLE_BYTES, size);
    const tailSize = Math.min(LEGACY_SAMPLE_BYTES, size);
    const head = Buffer.alloc(headSize);
    const tail = Buffer.alloc(tailSize);
    await handle.read(head, 0, headSize, 0);
    await handle.read(tail, 0, tailSize, Math.max(0, size - tailSize));
    const headText = head.toString("utf8");
    const tailText = tail.toString("utf8");
    const joined = `${headText}\n${tailText}`;
    const runId = stringField(headText, "runId") ?? path.replace(/.*[\\/]/, "").replace(/\.json$/, "");
    const task = stringField(headText, "task") ?? "unknown task";
    const rec: RunRecord = {
      runId,
      task,
      packSize: numberField(headText, "packSize") ?? 0,
      scanGlobs: stringArrayField(headText, "scanGlobs") ?? [],
      personality: stringField(headText, "personality") as Personality | undefined,
      noFallback: booleanField(headText, "noFallback"),
      mode: stringField(joined, "mode") as RunMode | undefined,
      status: (stringField(joined, "status") as RunStatus | undefined) ?? legacyStatus(joined),
      events: [],
      eventsCompacted: true,
      done: booleanField(tailText, "done") ?? true,
      finalRiteId: stringField(tailText, "finalRiteId"),
      outcome: stringField(tailText, "outcome"),
      error: stringField(tailText, "error"),
      startedAt: numberField(joined, "startedAt") ?? 0,
      finishedAt: numberField(tailText, "finishedAt"),
    };
    rec.nextSeq = numberField(tailText, "nextSeq") ?? eventCountEstimate(joined);
    if (rec.status === "interrupted" || rec.status === "error") {
      rec.resumable = true;
      rec.resumePrompt = buildResumePrompt(rec);
    }
    return normalizeLoadedRecord(rec);
  } finally {
    await handle.close();
  }
}

function normalizeLoadedRecord(rec: RunRecord): RunRecord {
  rec.events = compactRunEvents(Array.isArray(rec.events) ? rec.events : []);
  rec.nextSeq = rec.nextSeq ?? nextSeqFromEvents(rec.events);
  rec.status = rec.status ?? (rec.done ? (rec.error ? "error" : "done") : "running");
  rec.mode = rec.mode ?? rec.request?.mode;
  if (rec.status === "interrupted" || rec.status === "error") {
    rec.resumable = rec.resumable ?? true;
    rec.resumePrompt = rec.resumePrompt ?? buildResumePrompt(rec);
  }
  return rec;
}

function nextSeqFromEvents(events: RunEvent[]): number {
  let next = 0;
  for (const ev of events) next = Math.max(next, ev.seq + 1);
  return next;
}

function legacyStatus(text: string): RunStatus | undefined {
  const done = booleanField(text, "done");
  const error = stringField(text, "error");
  if (error) return "error";
  if (done === true) return "done";
  if (done === false) return "running";
  return undefined;
}

function eventCountEstimate(text: string): number | undefined {
  const matches = text.match(/"seq"\s*:\s*(\d+)/g);
  if (!matches?.length) return undefined;
  const last = matches[matches.length - 1].match(/(\d+)/);
  return last ? Number(last[1]) + 1 : undefined;
}

function stringField(text: string, name: string): string | undefined {
  const match = text.match(new RegExp(`"${escapeRegex(name)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

function numberField(text: string, name: string): number | undefined {
  const match = text.match(new RegExp(`"${escapeRegex(name)}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

function booleanField(text: string, name: string): boolean | undefined {
  const match = text.match(new RegExp(`"${escapeRegex(name)}"\\s*:\\s*(true|false)`));
  if (!match) return undefined;
  return match[1] === "true";
}

function stringArrayField(text: string, name: string): string[] | undefined {
  const match = text.match(new RegExp(`"${escapeRegex(name)}"\\s*:\\s*(\\[[\\s\\S]*?\\])`));
  if (!match) return undefined;
  try {
    const arr = JSON.parse(match[1]) as unknown;
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : undefined;
  } catch {
    return undefined;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
