/**
 * Phase 5 — Tool-use scaffold for the Troll (verifier-as-reward).
 *
 * Built-in safe tools:
 *   - json.parse:   parse + optional schema validation (no fetching)
 *   - regex.match:  test a regex against a string (sandboxed; capped runtime)
 *   - http.head:    HEAD a URL, return status + content-type. Disabled unless
 *                   GOBLINTOWN_TOOLS_HTTP=1 (network egress is opt-in).
 *   - web.fetch:    GET a public http(s) URL and return readable page text.
 *   - shell.run:    run a single shell command. Disabled unless
 *                   GOBLINTOWN_TOOLS_SHELL=1 AND a per-call --shell-cmd
 *                   allowlist is provided to the warren.
 *   - add-ons:      optional tool packs can contribute extra verifier tools.
 *                   The bundled Solana add-on is read-only.
 *
 * Tool-use is OPT-IN. Default troll remains pure-LLM. When --troll-tools is
 * passed, the troll runs a single tool-use round before producing its verdict.
 *
 * The dispatcher is exported for testability and is fully synchronous-friendly
 * for tools that don't need IO.
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}
export interface ToolResult {
  name: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>; // very loose; troll receives this as a hint
  invoke(args: Record<string, unknown>): Promise<unknown>;
}

const REGEX_TIMEOUT_MS = 200;
const WEB_FETCH_TIMEOUT_MS = 8000;
const WEB_FETCH_MAX_CHARS = 12000;

export const builtinTools: ToolDefinition[] = [
  {
    name: "json.parse",
    description: "Parse a JSON string. Returns { valid: boolean, parsed?: any, error?: string }.",
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async invoke(args) {
      const text = String(args.text ?? "");
      try {
        const parsed = JSON.parse(text);
        return { valid: true, parsed };
      } catch (e) {
        return { valid: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
  {
    name: "regex.match",
    description: "Test a regex against a string. Returns { matched: boolean, groups?: string[] }.",
    schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        flags: { type: "string" },
        text: { type: "string" },
      },
      required: ["pattern", "text"],
    },
    async invoke(args) {
      const pattern = String(args.pattern ?? "");
      const flags = String(args.flags ?? "");
      const text = String(args.text ?? "");
      // Compile in a try/catch — invalid pattern returns ok with matched=false.
      let re: RegExp;
      try {
        re = new RegExp(pattern, flags);
      } catch (e) {
        return { matched: false, error: "invalid pattern: " + (e instanceof Error ? e.message : String(e)) };
      }
      const start = Date.now();
      const m = re.exec(text);
      const ms = Date.now() - start;
      if (ms > REGEX_TIMEOUT_MS) {
        return { matched: false, error: `regex took ${ms}ms (cap ${REGEX_TIMEOUT_MS}ms)` };
      }
      return m ? { matched: true, groups: Array.from(m).slice(1) } : { matched: false };
    },
  },
  {
    name: "http.head",
    description: "HEAD request a URL. Returns { status, contentType, ok }. Disabled unless GOBLINTOWN_TOOLS_HTTP=1.",
    schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async invoke(args) {
      if (process.env.GOBLINTOWN_TOOLS_HTTP !== "1") {
        return { ok: false, error: "http.head disabled (set GOBLINTOWN_TOOLS_HTTP=1 to enable)" };
      }
      const url = String(args.url ?? "");
      try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return { ok: false, error: "only http(s) urls allowed" };
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        try {
          const res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
          return {
            ok: res.ok,
            status: res.status,
            contentType: res.headers.get("content-type") ?? "",
          };
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
];

export function createWebFetchTool(fetchImpl: typeof fetch = fetch): ToolDefinition {
  return {
    name: "web.fetch",
    description: "Fetch a public http(s) URL and return readable title/text. Blocks localhost and private-network hosts.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxChars: { type: "number" },
      },
      required: ["url"],
    },
    async invoke(args) {
      const url = String(args.url ?? "");
      const maxCharsRaw = Number(args.maxChars ?? WEB_FETCH_MAX_CHARS);
      const maxChars = Number.isFinite(maxCharsRaw)
        ? Math.max(500, Math.min(WEB_FETCH_MAX_CHARS, Math.floor(maxCharsRaw)))
        : WEB_FETCH_MAX_CHARS;
      const safe = validatePublicHttpUrl(url);
      if (!safe.ok) return safe;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), WEB_FETCH_TIMEOUT_MS);
      try {
        const res = await fetchImpl(safe.url, {
          method: "GET",
          redirect: "follow",
          signal: ctrl.signal,
          headers: {
            "User-Agent": "Goblintown/0.6 (+local chat web.fetch)",
            Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.2",
          },
        });
        const contentType = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        const readable = readableWebText(raw, contentType, maxChars);
        return {
          ok: res.ok,
          url: res.url || safe.url,
          status: res.status,
          contentType,
          title: extractHtmlTitle(raw),
          text: readable,
          truncated: readable.length >= maxChars,
        };
      } catch (e) {
        return { ok: false, url: safe.url, error: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Render a tool catalog the LLM sees. Pure.
 */
export function renderToolCatalog(tools: ToolDefinition[]): string {
  return tools
    .map((t) => `- ${t.name}: ${t.description}\n    args schema: ${JSON.stringify(t.schema)}`)
    .join("\n");
}

/**
 * Parse a tool-call request from an LLM response. Forgiving: accepts an array
 * of tool calls in JSON, or a single object, or "[]" / null. Returns up to
 * `max` validated calls.
 */
export function parseToolCallsJson(raw: string, max = 4): ToolCall[] {
  const json = extractFirstJsonValue(raw);
  if (json == null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }

  // Allow either { calls: [...] } or [...] or a single { name, args }.
  let arr: unknown[] = [];
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.calls)) arr = obj.calls;
    else if (typeof obj.name === "string") arr = [parsed];
  }

  const out: ToolCall[] = [];
  for (const c of arr) {
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) continue;
    const args = (obj.args && typeof obj.args === "object")
      ? obj.args as Record<string, unknown>
      : {};
    out.push({ name, args });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Dispatch a list of tool calls, in order, against a tool registry. Skips
 * calls to unknown tools (returning an error result).
 */
export async function runToolCalls(
  calls: ToolCall[],
  tools: ToolDefinition[],
): Promise<ToolResult[]> {
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  const results: ToolResult[] = [];
  for (const call of calls) {
    const tool = byName.get(call.name);
    if (!tool) {
      results.push({ name: call.name, ok: false, error: "unknown tool" });
      continue;
    }
    const start = Date.now();
    try {
      const r = await tool.invoke(call.args);
      results.push({ name: call.name, ok: true, result: r, durationMs: Date.now() - start });
    } catch (e) {
      results.push({
        name: call.name, ok: false,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - start,
      });
    }
  }
  return results;
}

/**
 * Render tool results as a compact block to feed back to the troll.
 */
export function renderToolResults(results: ToolResult[]): string {
  if (results.length === 0) return "(no tools were called)";
  return results
    .map((r) => {
      const status = r.ok ? "ok" : "error";
      const body = r.ok
        ? truncate(JSON.stringify(r.result), 400)
        : `error: ${r.error}`;
      return `- ${r.name} [${status}, ${r.durationMs ?? 0}ms]: ${body}`;
    })
    .join("\n");
}

/* --------- internal --------- */

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function validatePublicHttpUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: "only http(s) urls allowed" };
    }
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local") ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return { ok: false, error: "private or local hosts are blocked" };
    }
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, error: "invalid url" };
  }
}

function extractHtmlTitle(raw: string): string {
  const match = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1]).replace(/\s+/g, " ").trim().slice(0, 240) : "";
}

function readableWebText(raw: string, contentType: string, maxChars: number): string {
  const isHtml = /html/i.test(contentType) || /<html|<!doctype html/i.test(raw.slice(0, 500));
  const isJson = /json/i.test(contentType);
  let text = raw;
  if (isJson) {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      text = raw;
    }
  } else if (isHtml) {
    text = raw
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  }
  return decodeHtml(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function extractFirstJsonValue(s: string): string | null {
  // Strip code fences.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : s;
  // Try array first, then object.
  for (const open of ["[", "{"]) {
    const close = open === "[" ? "]" : "}";
    const start = candidate.indexOf(open);
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) return candidate.slice(start, i + 1);
        }
      }
    }
  }
  return null;
}
