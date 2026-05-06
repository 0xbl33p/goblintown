import type { OutputFormat } from "./types.js";

export function normalizeOutputFormat(value: unknown): OutputFormat {
  return value === "markdown" || value === "json" || value === "freeform"
    ? value
    : "freeform";
}

export function appendFormatInstruction(
  prompt: string,
  format: OutputFormat | undefined,
): string {
  const normalized = normalizeOutputFormat(format);
  const instruction = formatInstruction(normalized);
  if (!instruction) return prompt;
  return `${prompt}\n\n${instruction}`;
}

export function assertOutputFormat(
  output: string,
  format: OutputFormat | undefined,
): string {
  const normalized = normalizeOutputFormat(format);
  const trimmed = output.trim();
  if (normalized === "freeform" || normalized === "markdown") return trimmed;

  const json = extractFirstJsonObject(trimmed);
  if (!json) {
    throw new Error("Output is not a valid JSON object.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Output is not a valid JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Output is not a valid JSON object.");
  }
  return JSON.stringify(parsed, null, 2);
}

export function buildFormatRepairPrompt(opts: {
  format: OutputFormat;
  originalPrompt: string;
  output: string;
  error: string;
}): string {
  const instruction = formatInstruction(opts.format) ?? "";
  return [
    "The previous answer did not satisfy the required output format.",
    `Format error: ${opts.error}`,
    "",
    "Original task:",
    opts.originalPrompt,
    "",
    "Previous answer:",
    opts.output,
    "",
    "Rewrite the previous answer so it preserves the same substance and satisfies this format requirement:",
    instruction,
  ].join("\n");
}

function formatInstruction(format: OutputFormat): string | null {
  if (format === "freeform") return null;
  if (format === "markdown") {
    return [
      "Output format requirement:",
      "Return Markdown. Use headings, lists, tables, and fenced code blocks when they make the answer clearer.",
      "Do not wrap the entire answer in a code fence.",
    ].join("\n");
  }
  return [
    "Output format requirement:",
    "Return a single valid JSON object and nothing else.",
    "Do not include Markdown fences, comments, prose before the object, or prose after the object.",
  ].join("\n");
}

function extractFirstJsonObject(s: string): string | null {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
    } else {
      if (ch === "\"") inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return candidate.slice(start, i + 1);
      }
    }
  }
  return null;
}
