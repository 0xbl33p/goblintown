import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  builtinTools,
  createWebFetchTool,
  parseToolCallsJson,
  renderToolCatalog,
  renderToolResults,
  runToolCalls,
  type ToolDefinition,
} from "../tools.js";

describe("parseToolCallsJson", () => {
  it("parses an array of calls", () => {
    const out = parseToolCallsJson(`[{"name":"json.parse","args":{"text":"{}"}}]`);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "json.parse");
    assert.deepEqual(out[0].args, { text: "{}" });
  });

  it("parses a single object as a one-call array", () => {
    const out = parseToolCallsJson(`{"name":"regex.match","args":{"pattern":"\\\\d+","text":"42"}}`);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "regex.match");
  });

  it("parses { calls: [...] } envelope", () => {
    const out = parseToolCallsJson(`{"calls":[{"name":"a"},{"name":"b"}]}`);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(c => c.name), ["a","b"]);
  });

  it("strips code fences and prose", () => {
    const out = parseToolCallsJson("here:\n```json\n[{\"name\":\"x\"}]\n```");
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "x");
  });

  it("returns [] for empty array or null input", () => {
    assert.deepEqual(parseToolCallsJson("[]"), []);
    assert.deepEqual(parseToolCallsJson("null"), []);
    assert.deepEqual(parseToolCallsJson(""), []);
  });

  it("respects max cap", () => {
    const json = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ name: "t" + i })));
    const out = parseToolCallsJson(json, 3);
    assert.equal(out.length, 3);
  });

  it("drops unnamed calls", () => {
    const out = parseToolCallsJson(`[{"name":"good"},{"args":{}}]`);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "good");
  });
});

describe("runToolCalls (json.parse, regex.match)", () => {
  it("dispatches valid json.parse", async () => {
    const r = await runToolCalls([{ name: "json.parse", args: { text: '{"a":1}' } }], builtinTools);
    assert.equal(r[0].ok, true);
    assert.deepEqual((r[0].result as { valid: boolean; parsed: unknown }).parsed, { a: 1 });
  });

  it("returns valid=false for malformed json", async () => {
    const r = await runToolCalls([{ name: "json.parse", args: { text: "{not json}" } }], builtinTools);
    const result = r[0].result as { valid: boolean; error?: string };
    assert.equal(r[0].ok, true);
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });

  it("regex.match finds groups", async () => {
    const r = await runToolCalls(
      [{ name: "regex.match", args: { pattern: "(\\d+)", text: "abc 42 def" } }],
      builtinTools,
    );
    const result = r[0].result as { matched: boolean; groups: string[] };
    assert.equal(result.matched, true);
    assert.deepEqual(result.groups, ["42"]);
  });

  it("regex.match handles invalid pattern gracefully", async () => {
    const r = await runToolCalls(
      [{ name: "regex.match", args: { pattern: "([", text: "x" } }],
      builtinTools,
    );
    const result = r[0].result as { matched: boolean; error?: string };
    assert.equal(result.matched, false);
    assert.ok(result.error);
  });

  it("returns error result for unknown tool", async () => {
    const r = await runToolCalls([{ name: "ghost", args: {} }], builtinTools);
    assert.equal(r[0].ok, false);
    assert.equal(r[0].error, "unknown tool");
  });

  it("runs multiple tools in order", async () => {
    const r = await runToolCalls([
      { name: "json.parse", args: { text: "[1]" } },
      { name: "regex.match", args: { pattern: "x", text: "y" } },
    ], builtinTools);
    assert.equal(r.length, 2);
    assert.equal(r[0].name, "json.parse");
    assert.equal(r[1].name, "regex.match");
  });

  it("custom tool registry overrides builtins", async () => {
    const custom: ToolDefinition[] = [{
      name: "echo",
      description: "echoes its arg",
      schema: { type: "object" },
      async invoke(args) { return args; },
    }];
    const r = await runToolCalls([{ name: "echo", args: { hi: 1 } }], custom);
    assert.deepEqual(r[0].result, { hi: 1 });
  });
});

describe("http.head safety gate", () => {
  it("is disabled by default", async () => {
    const orig = process.env.GOBLINTOWN_TOOLS_HTTP;
    delete process.env.GOBLINTOWN_TOOLS_HTTP;
    try {
      const r = await runToolCalls(
        [{ name: "http.head", args: { url: "https://example.com" } }],
        builtinTools,
      );
      const result = r[0].result as { ok: boolean; error?: string };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /disabled/);
    } finally {
      if (orig !== undefined) process.env.GOBLINTOWN_TOOLS_HTTP = orig;
    }
  });
});

describe("web.fetch", () => {
  it("fetches readable public page text", async () => {
    const tool = createWebFetchTool(async () =>
      new Response("<html><title>GitHub Repo</title><body><script>nope()</script><h1>Goblintown</h1><p>README facts.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await tool.invoke({ url: "https://github.com/0xbl33p/goblintown" }) as {
      ok: boolean;
      title: string;
      text: string;
    };

    assert.equal(result.ok, true);
    assert.equal(result.title, "GitHub Repo");
    assert.match(result.text, /Goblintown/);
    assert.match(result.text, /README facts/);
    assert.doesNotMatch(result.text, /nope/);
  });

  it("blocks local/private hosts", async () => {
    const tool = createWebFetchTool(async () => {
      throw new Error("fetch should not run");
    });
    const result = await tool.invoke({ url: "http://localhost:3000" }) as {
      ok: boolean;
      error?: string;
    };

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /private|local/);
  });
});

describe("renderToolCatalog", () => {
  it("includes tool name, description, and arg schema", () => {
    const out = renderToolCatalog(builtinTools);
    assert.ok(out.includes("json.parse"));
    assert.ok(out.includes("regex.match"));
    assert.ok(out.includes("args schema"));
  });
});

describe("renderToolResults", () => {
  it("renders ok and error results compactly", () => {
    const out = renderToolResults([
      { name: "a", ok: true, result: { x: 1 }, durationMs: 5 },
      { name: "b", ok: false, error: "kaboom", durationMs: 12 },
    ]);
    assert.ok(out.includes("a [ok"));
    assert.ok(out.includes("b [error"));
    assert.ok(out.includes("kaboom"));
  });

  it("handles empty results", () => {
    assert.ok(renderToolResults([]).includes("no tools"));
  });
});
