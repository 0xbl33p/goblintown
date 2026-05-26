import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extractKeywords } from "./artifact.js";
import type { Hoard } from "./hoard.js";
import type { Artifact } from "./types.js";

export interface ContextIngestFile {
  path: string;
  relativePath: string;
  size: number;
}

export interface ContextIngestSkipped {
  path: string;
  reason: string;
}

export interface ContextIngestResult {
  artifacts: Artifact[];
  skipped: ContextIngestSkipped[];
}

export interface ContextArtifactInput {
  root: string;
  filePath: string;
  content: string;
  timestamp?: number;
  parentArtifactIds?: string[];
}

export interface ContextIngestOptions {
  root: string;
  hoard: Hoard;
  inputPath: string;
  limit?: number;
  maxFileBytes?: number;
  maxCharsPerFile?: number;
  timestamp?: number;
  parentArtifactIds?: string[];
}

const DEFAULT_LIMIT = 80;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_CHARS_PER_FILE = 12_000;

const INGESTIBLE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".csv",
  ".go",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".log",
  ".md",
  ".markdown",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const SKIPPED_DIR_NAMES = new Set([
  ".git",
  ".goblintown",
  ".next",
  "coverage",
  "dist",
  "node_modules",
  "release",
]);

export function buildContextArtifact(input: ContextArtifactInput): Artifact {
  const root = resolve(input.root);
  const filePath = resolve(input.filePath);
  const ref = displayPath(root, filePath);
  const normalized = normalizeContextText(input.content);
  const storedContent = normalized.slice(0, DEFAULT_MAX_CHARS_PER_FILE);
  const excerpt = compactWhitespace(storedContent).slice(0, 900);
  const summary = summarizeContext(storedContent, ref);
  const hash = createHash("sha256")
    .update(ref)
    .update("\0")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
  const id = `ctx-${hash}`;
  const keywords = extractKeywords([ref, summary, excerpt].join("\n"));

  return {
    id,
    riteId: `context:${hash}`,
    task: `Imported context: ${ref}`,
    outcome: "winner",
    claims: [
      {
        text: summary,
        confidence: "likely",
        evidenceIds: [0],
      },
    ],
    evidence: [
      {
        kind: "file",
        ref,
        snippet: excerpt,
      },
    ],
    openQuestions: [],
    nextSteps: [`Use ${ref} as prior context when it is relevant to a task.`],
    parentArtifactIds: input.parentArtifactIds ?? [],
    keywords,
    timestamp: input.timestamp ?? Date.now(),
  };
}

export async function listIngestibleContextFiles(opts: {
  root: string;
  inputPath: string;
  limit?: number;
  maxFileBytes?: number;
}): Promise<ContextIngestFile[]> {
  const result = await collectContextFiles(opts);
  return result.files;
}

export async function ingestContextPath(
  opts: ContextIngestOptions,
): Promise<ContextIngestResult> {
  const maxChars = opts.maxCharsPerFile ?? DEFAULT_MAX_CHARS_PER_FILE;
  const collected = await collectContextFiles(opts);
  const artifacts: Artifact[] = [];
  const skipped = [...collected.skipped];

  for (const file of collected.files) {
    try {
      const raw = await readFile(file.path, "utf8");
      const normalized = normalizeContextText(raw);
      if (!normalized) {
        skipped.push({ path: file.relativePath, reason: "empty text" });
        continue;
      }
      const artifact = buildContextArtifact({
        root: opts.root,
        filePath: file.path,
        content: normalized.slice(0, maxChars),
        timestamp: opts.timestamp,
        parentArtifactIds: opts.parentArtifactIds,
      });
      await opts.hoard.stashArtifact(artifact);
      artifacts.push(artifact);
    } catch (err) {
      skipped.push({
        path: file.relativePath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { artifacts, skipped };
}

async function collectContextFiles(opts: {
  root: string;
  inputPath: string;
  limit?: number;
  maxFileBytes?: number;
}): Promise<{ files: ContextIngestFile[]; skipped: ContextIngestSkipped[] }> {
  const root = resolve(opts.root);
  const inputPath = resolve(root, opts.inputPath);
  const limit = clampPositiveInteger(opts.limit, DEFAULT_LIMIT, 1, 500);
  const maxFileBytes = clampPositiveInteger(
    opts.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    1,
    5 * 1024 * 1024,
  );
  const files: ContextIngestFile[] = [];
  const skipped: ContextIngestSkipped[] = [];

  await visit(inputPath);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files: files.slice(0, limit), skipped };

  async function visit(path: string): Promise<void> {
    let info;
    try {
      info = await stat(path);
    } catch (err) {
      skipped.push({
        path: displayPath(root, path),
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (info.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(path.split(sep).pop() ?? "")) return;
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch (err) {
        skipped.push({
          path: displayPath(root, path),
          reason: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        await visit(join(path, entry.name));
      }
      return;
    }

    if (!info.isFile()) return;
    const relativePath = displayPath(root, path);
    if (!isIngestibleExtension(path)) {
      skipped.push({ path: relativePath, reason: "unsupported extension" });
      return;
    }
    if (info.size > maxFileBytes) {
      skipped.push({ path: relativePath, reason: "file too large" });
      return;
    }
    files.push({
      path,
      relativePath,
      size: info.size,
    });
  }
}

function displayPath(root: string, filePath: string): string {
  const rel = relative(root, filePath);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    return rel.split(sep).join("/");
  }
  return filePath;
}

function isIngestibleExtension(path: string): boolean {
  return INGESTIBLE_EXTENSIONS.has(extname(path).toLowerCase());
}

function normalizeContextText(text: string): string {
  return text.replace(/\0/g, "").replace(/\r\n?/g, "\n").trim();
}

function summarizeContext(text: string, ref: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const firstHeading = lines.find((line) => /^#{1,6}\s+\S/.test(line));
  const firstUseful = firstHeading ?? lines[0] ?? ref;
  const secondUseful = lines.find((line) => line !== firstUseful && !/^#{1,6}\s+\S/.test(line));
  const summary = [stripMarkdownHeading(firstUseful), secondUseful]
    .filter((line): line is string => !!line)
    .join(" ");
  return `Imported context from ${ref}: ${truncate(compactWhitespace(summary), 280)}`;
}

function stripMarkdownHeading(line: string): string {
  return line.replace(/^#{1,6}\s+/, "");
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function clampPositiveInteger(
  raw: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}
