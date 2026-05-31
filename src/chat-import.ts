import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { extractKeywords } from "./artifact.js";
import { artifactRetrievalText, embed } from "./embeddings.js";
import { makeGoblin } from "./creatures.js";
import { callCreature } from "./openai-client.js";
import type { Hoard } from "./hoard.js";
import type { Artifact, ArtifactClaim } from "./types.js";

export type ChatImportSource = "codex" | "chatgpt" | "folder";
export type ChatMessageRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatMessageRole;
  text: string;
  timestamp?: string;
}

export interface ChatRecord {
  id: string;
  source: Exclude<ChatImportSource, "folder">;
  title: string;
  rawRef: string;
  workspace?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: ChatMessage[];
}

export interface ChatScanOptions {
  source?: ChatImportSource;
  path?: string;
  query?: string;
  since?: string;
  limit?: number;
  homeDir?: string;
}

export interface ChatScanResult {
  records: ChatRecord[];
  skipped: { path: string; reason: string }[];
}

export interface ChatImportOptions {
  hoard: Hoard;
  records: ChatRecord[];
  ids?: string[];
  vectorize?: boolean;
  summarize?: boolean;
  summarizer?: (record: ChatRecord) => Promise<string>;
  embedder?: (text: string) => Promise<number[]>;
  timestamp?: number;
  maxChunkChars?: number;
}

export interface ChatImportResult {
  records: ChatRecord[];
  artifacts: Artifact[];
  vectorized: number;
  skipped: { id: string; reason: string }[];
}

export interface VectorizeOptions {
  hoard: Hoard;
  artifacts?: Artifact[];
  missingOnly?: boolean;
  limit?: number;
  embedder?: (text: string) => Promise<number[]>;
}

export interface VectorizeResult {
  scanned: number;
  vectorized: number;
  failed: { id: string; reason: string }[];
}

const DEFAULT_SCAN_LIMIT = 50;
const DEFAULT_CHUNK_CHARS = 6_000;
const MAX_SCAN_LIMIT = 500;
const DEFAULT_EMBEDDER = async (text: string): Promise<number[]> => embed(text);

export function parseCodexSessionJsonl(raw: string, rawRef: string): ChatRecord {
  const messages: ChatMessage[] = [];
  let sessionId = "";
  let workspace = "";
  let title = "";
  let createdAt = "";
  let updatedAt = "";

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const timestamp = stringValue(entry.timestamp);
    if (timestamp) {
      if (!createdAt) createdAt = timestamp;
      updatedAt = timestamp;
    }
    const type = stringValue(entry.type);
    const payload = objectValue(entry.payload);

    if (type === "session_meta") {
      sessionId = stringValue(payload.id) || sessionId;
      workspace = stringValue(payload.cwd) || workspace;
      title =
        stringValue(payload.thread_name) ||
        stringValue(payload.threadName) ||
        stringValue(payload.name) ||
        title;
      continue;
    }

    if (type !== "response_item") continue;
    if (stringValue(payload.type) !== "message") continue;
    const role = normalizeRole(stringValue(payload.role));
    if (!role) continue;
    const text = extractVisibleText(payload.content);
    if (!text) continue;
    messages.push({
      role,
      text: redactSecrets(text),
      timestamp,
    });
  }

  const fallbackId = createHash("sha256").update(rawRef).update("\0").update(raw).digest("hex").slice(0, 16);
  const firstUser = messages.find((m) => m.role === "user")?.text;
  return {
    id: `codex:${sessionId || fallbackId}`,
    source: "codex",
    title: title || titleFromText(firstUser) || basename(rawRef),
    rawRef,
    workspace: workspace || undefined,
    createdAt: createdAt || undefined,
    updatedAt: updatedAt || createdAt || undefined,
    messages,
  };
}

export function parseChatGptConversationsJson(raw: string, rawRef: string): ChatRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const conversations = Array.isArray(parsed) ? parsed : [parsed];
  return conversations.flatMap((item, idx): ChatRecord[] => {
    const convo = objectValue(item);
    const mapping = objectValue(convo.mapping);
    const messages: ChatMessage[] = [];
    const nodes = Object.values(mapping)
      .map((node) => objectValue(node))
      .sort((a, b) => numberValue(objectValue(a.message).create_time) - numberValue(objectValue(b.message).create_time));

    for (const node of nodes) {
      const message = objectValue(node.message);
      const author = objectValue(message.author);
      const role = normalizeRole(stringValue(author.role));
      if (!role) continue;
      const text = extractChatGptText(objectValue(message.content));
      if (!text) continue;
      const createTime = numberValue(message.create_time);
      messages.push({
        role,
        text: redactSecrets(text),
        timestamp: createTime ? new Date(createTime * 1000).toISOString() : undefined,
      });
    }

    if (messages.length === 0) return [];
    const id = stringValue(convo.id) || createHash("sha256").update(rawRef).update(String(idx)).digest("hex").slice(0, 16);
    const created = numberValue(convo.create_time);
    const updated = numberValue(convo.update_time);
    return [{
      id: `chatgpt:${id}`,
      source: "chatgpt",
      title: stringValue(convo.title) || titleFromText(messages[0]?.text) || `ChatGPT conversation ${idx + 1}`,
      rawRef,
      createdAt: created ? new Date(created * 1000).toISOString() : messages[0]?.timestamp,
      updatedAt: updated ? new Date(updated * 1000).toISOString() : messages[messages.length - 1]?.timestamp,
      messages,
    }];
  });
}

export async function scanChatImports(opts: ChatScanOptions = {}): Promise<ChatScanResult> {
  const source = opts.source ?? "codex";
  const skipped: { path: string; reason: string }[] = [];
  const roots = resolveScanRoots(source, opts);
  const records: ChatRecord[] = [];

  for (const root of roots) {
    for (const file of await listChatFiles(root, source, skipped)) {
      try {
        const parsed = await parseChatFile(file, source);
        records.push(...parsed);
      } catch (err) {
        skipped.push({ path: file, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  const query = normalizeSearchText(opts.query ?? "");
  const filtered = records
    .filter((record) => record.messages.length > 0)
    .filter((record) => !Number.isFinite(sinceMs) || recordTimestampMs(record) >= sinceMs)
    .filter((record) => !query || normalizeSearchText(chatSearchText(record)).includes(query))
    .sort((a, b) => recordTimestampMs(b) - recordTimestampMs(a))
    .slice(0, clampLimit(opts.limit, DEFAULT_SCAN_LIMIT, 1, MAX_SCAN_LIMIT));

  return { records: filtered, skipped };
}

export function buildChatArtifacts(
  record: ChatRecord,
  opts: { timestamp?: number; maxChunkChars?: number; summary?: string } = {},
): Artifact[] {
  const timestamp = opts.timestamp ?? timestampForRecord(record);
  const maxChunkChars = Math.max(500, opts.maxChunkChars ?? DEFAULT_CHUNK_CHARS);
  const transcript = redactSecrets(renderTranscript(record));
  const contentHash = createHash("sha256")
    .update(record.id)
    .update("\0")
    .update(transcript)
    .digest("hex")
    .slice(0, 16);
  const rootId = `chat-${contentHash}`;
  const rootSummary = compactWhitespace(
    `Imported ${record.source} chat "${record.title}"` +
      `${record.workspace ? ` from ${record.workspace}` : ""}` +
      ` with ${record.messages.length} visible messages.`,
  );
  const summary = opts.summary ? redactSecrets(compactWhitespace(opts.summary)) : "";
  const root: Artifact = {
    id: rootId,
    riteId: `chat:${contentHash}`,
    task: rootSummary,
    outcome: "winner",
    claims: [{
      text: summary || rootSummary,
      confidence: "likely",
      evidenceIds: [0],
    }],
    evidence: [{
      kind: "file",
      ref: record.rawRef,
      snippet: transcript.slice(0, 900),
    }],
    openQuestions: [],
    nextSteps: [`Use imported chat ${record.title} as memory when relevant.`],
    parentArtifactIds: [],
    keywords: chatKeywords([record.source, record.title, record.workspace ?? "", summary, transcript].join("\n")),
    timestamp,
  };

  const chunks = chunkTranscript(transcript, maxChunkChars);
  const chunkArtifacts = chunks.map((chunk, index): Artifact => {
    const chunkHash = createHash("sha256")
      .update(rootId)
      .update("\0")
      .update(String(index))
      .update("\0")
      .update(chunk)
      .digest("hex")
      .slice(0, 16);
    const claim = `Imported chat chunk ${index + 1}/${chunks.length} from "${record.title}".`;
    return {
      id: `chatc-${chunkHash}`,
      riteId: `chat:${contentHash}:${index + 1}`,
      task: claim,
      outcome: "winner",
      claims: [{
        text: `${claim} ${compactWhitespace(chunk).slice(0, 280)}`,
        confidence: "likely",
        evidenceIds: [0],
      }],
      evidence: [{
        kind: "file",
        ref: record.rawRef,
        snippet: chunk.slice(0, 900),
      }],
      openQuestions: [],
      nextSteps: [],
      parentArtifactIds: [rootId],
      keywords: chatKeywords([record.title, record.workspace ?? "", chunk].join("\n")),
      timestamp,
    };
  });

  return [root, ...chunkArtifacts];
}

export async function importChatRecords(opts: ChatImportOptions): Promise<ChatImportResult> {
  const idSet = opts.ids && opts.ids.length > 0 ? new Set(opts.ids) : null;
  const selected = idSet ? opts.records.filter((record) => idSet.has(record.id)) : opts.records;
  const summaries = new Map<string, string>();
  if (opts.summarize) {
    const summarize = opts.summarizer ?? summarizeChatRecord;
    for (const record of selected) {
      summaries.set(record.id, await summarize(record));
    }
  }
  const artifacts = selected.flatMap((record) =>
    buildChatArtifacts(record, {
      timestamp: opts.timestamp,
      maxChunkChars: opts.maxChunkChars,
      summary: summaries.get(record.id),
    }),
  );

  let vectorized = 0;
  const skipped: { id: string; reason: string }[] = [];
  if (opts.vectorize !== false) {
    const v = await vectorizeArtifacts(artifacts, opts.embedder ?? DEFAULT_EMBEDDER);
    vectorized = v.vectorized;
    skipped.push(...v.failed);
  }

  for (const artifact of artifacts) await opts.hoard.stashArtifact(artifact);
  return { records: selected, artifacts, vectorized, skipped };
}

export async function vectorizeStoredArtifacts(opts: VectorizeOptions): Promise<VectorizeResult> {
  const all = opts.artifacts ?? await opts.hoard.allArtifacts();
  const selected = all
    .filter((artifact) => !opts.missingOnly || !artifact.embedding || artifact.embedding.length === 0)
    .slice(0, clampLimit(opts.limit, all.length || MAX_SCAN_LIMIT, 1, MAX_SCAN_LIMIT));
  const result = await vectorizeArtifacts(selected, opts.embedder ?? DEFAULT_EMBEDDER);
  for (const artifact of selected) {
    if (artifact.embedding && artifact.embedding.length > 0) await opts.hoard.stashArtifact(artifact);
  }
  return { scanned: selected.length, vectorized: result.vectorized, failed: result.failed };
}

export function chatRecordPreview(record: ChatRecord): Record<string, unknown> {
  return {
    id: record.id,
    source: record.source,
    title: record.title,
    rawRef: record.rawRef,
    workspace: record.workspace,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messages.length,
  };
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_SECRET]")
    .replace(/\b([A-Za-z0-9_]*API[_-]?KEY)\s*=\s*([^\s"'`]+)/gi, "$1=[REDACTED_SECRET]")
    .replace(/\b(BEARER)\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, "$1 [REDACTED_SECRET]");
}

async function vectorizeArtifacts(
  artifacts: Artifact[],
  embedder: (text: string) => Promise<number[]>,
): Promise<{ vectorized: number; failed: { id: string; reason: string }[] }> {
  let vectorized = 0;
  const failed: { id: string; reason: string }[] = [];
  for (const artifact of artifacts) {
    try {
      artifact.embedding = await embedder(redactSecrets(artifactRetrievalText(artifact)));
      vectorized++;
    } catch (err) {
      failed.push({ id: artifact.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { vectorized, failed };
}

function resolveScanRoots(source: ChatImportSource, opts: ChatScanOptions): string[] {
  if (opts.path) return [resolve(opts.path)];
  const home = opts.homeDir ?? homedir();
  if (source === "codex") {
    return [
      join(home, ".codex", "sessions"),
      join(home, ".codex", "archived_sessions"),
    ];
  }
  return [resolve(".")];
}

async function listChatFiles(
  root: string,
  source: ChatImportSource,
  skipped: { path: string; reason: string }[],
): Promise<string[]> {
  let info;
  try {
    info = await stat(root);
  } catch (err) {
    skipped.push({ path: root, reason: err instanceof Error ? err.message : String(err) });
    return [];
  }
  if (info.isFile()) return [root];
  if (!info.isDirectory()) return [];

  const out: string[] = [];
  await visit(root);
  return out.sort();

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: dir, reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (matchesSourceFile(path, source)) out.push(path);
    }
  }
}

function matchesSourceFile(path: string, source: ChatImportSource): boolean {
  const name = basename(path).toLowerCase();
  const ext = extname(path).toLowerCase();
  if (source === "codex") return ext === ".jsonl";
  if (source === "chatgpt") return name === "conversations.json" || ext === ".zip";
  return ext === ".jsonl" || name === "conversations.json" || ext === ".zip";
}

async function parseChatFile(path: string, source: ChatImportSource): Promise<ChatRecord[]> {
  const actualSource = source === "folder" ? sourceForFile(path) : source;
  if (actualSource === "codex") {
    return [parseCodexSessionJsonl(await readFile(path, "utf8"), displayPath(path))];
  }
  if (actualSource === "chatgpt") {
    const raw =
      extname(path).toLowerCase() === ".zip"
        ? await readConversationsJsonFromZip(path)
        : await readFile(path, "utf8");
    return parseChatGptConversationsJson(raw, displayPath(path));
  }
  return [];
}

function sourceForFile(path: string): Exclude<ChatImportSource, "folder"> {
  if (extname(path).toLowerCase() === ".jsonl") return "codex";
  return "chatgpt";
}

async function readConversationsJsonFromZip(path: string): Promise<string> {
  const zip = await readFile(path);
  let offset = 0;
  while (offset + 30 < zip.length) {
    const sig = zip.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const uncompressedSize = zip.readUInt32LE(offset + 22);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const name = zip.slice(offset + 30, offset + 30 + nameLen).toString("utf8");
    const dataStart = offset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compressedSize;
    if (basename(name) === "conversations.json") {
      const data = zip.slice(dataStart, dataEnd);
      if (method === 0) return data.toString("utf8");
      if (method === 8) return inflateRawSync(data, { finishFlush: 2 }).toString("utf8");
      throw new Error(`unsupported zip compression method ${method}`);
    }
    offset = dataEnd;
    if (uncompressedSize === 0 && compressedSize === 0 && nameLen === 0) break;
  }
  throw new Error("conversations.json not found in zip");
}

function extractVisibleText(content: unknown): string {
  if (typeof content === "string") return compactWhitespace(content);
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part): string[] => {
      if (typeof part === "string") return [part];
      const obj = objectValue(part);
      const type = stringValue(obj.type);
      if (type && !["input_text", "output_text", "text"].includes(type)) return [];
      const text = stringValue(obj.text);
      return text ? [text] : [];
    })
    .map(compactWhitespace)
    .filter(Boolean)
    .join("\n\n");
}

function extractChatGptText(content: Record<string, unknown>): string {
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .filter((part): part is string => typeof part === "string")
    .map(compactWhitespace)
    .filter(Boolean)
    .join("\n\n");
}

function renderTranscript(record: ChatRecord): string {
  const header = [
    `Source: ${record.source}`,
    `Title: ${record.title}`,
    record.createdAt ? `Created: ${record.createdAt}` : "",
    record.updatedAt ? `Updated: ${record.updatedAt}` : "",
    record.workspace ? `Workspace: ${record.workspace}` : "",
  ].filter(Boolean);
  const body = record.messages.map((m, idx) =>
    `## ${idx + 1}. ${m.role}${m.timestamp ? ` (${m.timestamp})` : ""}\n${m.text}`,
  );
  return [...header, "", ...body].join("\n");
}

async function summarizeChatRecord(record: ChatRecord): Promise<string> {
  const transcript = redactSecrets(renderTranscript(record)).slice(0, 16_000);
  const prompt = [
    "Summarize this imported prior chat for future local project memory.",
    "Return concise Markdown with: durable decisions, project context, unresolved questions, and useful references.",
    "Do not invent details that are not present in the transcript.",
    "",
    transcript,
  ].join("\n");
  const { text } = await callCreature(makeGoblin(), prompt, {
    outputFormat: "markdown",
    maxOutputTokens: 900,
  });
  return text;
}

function chunkTranscript(text: string, maxChunkChars: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxChunkChars && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.length ? chunks : [text.slice(0, maxChunkChars)];
}

function chatSearchText(record: ChatRecord): string {
  return [record.title, record.workspace ?? "", record.rawRef, ...record.messages.map((m) => m.text)].join("\n");
}

function titleFromText(text: string | undefined): string {
  return compactWhitespace(text ?? "").slice(0, 80);
}

function timestampForRecord(record: ChatRecord): number {
  return recordTimestampMs(record) || Date.now();
}

function recordTimestampMs(record: ChatRecord): number {
  const raw = record.updatedAt ?? record.createdAt ?? record.messages[0]?.timestamp ?? "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRole(value: string): ChatMessageRole | null {
  if (value === "user" || value === "assistant") return value;
  return null;
}

function compactWhitespace(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function normalizeSearchText(text: string): string {
  return compactWhitespace(text).toLowerCase();
}

function chatKeywords(text: string): string[] {
  const ranked = extractKeywords(text);
  const all = text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((token) => token.length >= 3);
  return [...new Set([...ranked, ...all])].slice(0, 240);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clampLimit(
  raw: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function displayPath(path: string): string {
  const cwd = resolve(".");
  const rel = relative(cwd, path);
  if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) return rel.split(sep).join("/");
  return path;
}
