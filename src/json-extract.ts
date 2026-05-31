/**
 * Extract the first balanced top-level JSON object from a model response,
 * stripping a leading ```json code fence if present. Returns the matched
 * substring (still unparsed) or null when no balanced object is found.
 *
 * Shared by the creatures that ask a model for a single JSON object
 * (artifact, planner, specialist) and by the output formatter.
 */
export function extractFirstJsonObject(s: string): string | null {
  // Strip code fences if present.
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
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return candidate.slice(start, i + 1);
      }
    }
  }
  return null;
}
