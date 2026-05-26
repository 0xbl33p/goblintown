import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import {
  buildChatArtifacts,
  importChatRecords,
  parseChatGptConversationsJson,
  parseCodexSessionJsonl,
  redactSecrets,
  scanChatImports,
  vectorizeStoredArtifacts,
} from "../chat-import.js";
import { findRelevantArtifacts } from "../artifact.js";
import { Hoard } from "../hoard.js";

const tmpRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "goblintown-chat-import-"));
  tmpRoots.push(root);
  return root;
}

after(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("previous chat import", () => {
  it("parses Codex JSONL sessions into visible user and assistant messages", () => {
    const raw = [
      JSON.stringify({
        timestamp: "2026-05-22T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "sess-1",
          cwd: "/repo/goblintown",
          thread_name: "Goblin Tank voice",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-22T10:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Make the Tank AI-first." }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-22T10:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Use a router before full rites." }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-22T10:03:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: "{}",
        },
      }),
    ].join("\n");

    const record = parseCodexSessionJsonl(raw, "sessions/2026/05/demo.jsonl");

    assert.equal(record.source, "codex");
    assert.equal(record.id, "codex:sess-1");
    assert.equal(record.workspace, "/repo/goblintown");
    assert.equal(record.messages.length, 2);
    assert.equal(record.messages[0].role, "user");
    assert.equal(record.messages[1].role, "assistant");
    assert.match(record.title, /Goblin Tank voice|Make the Tank/);
  });

  it("parses ChatGPT conversations.json and skips non-user assistant roles", () => {
    const raw = JSON.stringify([
      {
        id: "conv-1",
        title: "Previous app direction",
        create_time: 1_779_000_000,
        update_time: 1_779_000_060,
        mapping: {
          root: { id: "root", parent: null, children: ["user-1"] },
          "user-1": {
            id: "user-1",
            parent: "root",
            children: ["assistant-1"],
            message: {
              author: { role: "user" },
              create_time: 1_779_000_001,
              content: { content_type: "text", parts: ["Can Goblintown import my old chats?"] },
            },
          },
          "assistant-1": {
            id: "assistant-1",
            parent: "user-1",
            children: ["system-1"],
            message: {
              author: { role: "assistant" },
              create_time: 1_779_000_002,
              content: { content_type: "text", parts: ["Yes, as structured memory."] },
            },
          },
          "system-1": {
            id: "system-1",
            parent: "assistant-1",
            children: [],
            message: {
              author: { role: "system" },
              create_time: 1_779_000_003,
              content: { content_type: "text", parts: ["hidden"] },
            },
          },
        },
      },
    ]);

    const records = parseChatGptConversationsJson(raw, "conversations.json");

    assert.equal(records.length, 1);
    assert.equal(records[0].source, "chatgpt");
    assert.equal(records[0].id, "chatgpt:conv-1");
    assert.equal(records[0].title, "Previous app direction");
    assert.equal(records[0].messages.length, 2);
    assert.equal(records[0].messages[0].text, "Can Goblintown import my old chats?");
    assert.equal(records[0].messages[1].text, "Yes, as structured memory.");
  });

  it("builds deterministic root and chunk artifacts with redacted secrets", () => {
    const record = {
      id: "codex:sess-redact",
      source: "codex" as const,
      title: "Secret chat",
      rawRef: "session.jsonl",
      workspace: "/repo",
      createdAt: "2026-05-22T10:00:00.000Z",
      updatedAt: "2026-05-22T10:04:00.000Z",
      messages: [
        { role: "user" as const, text: "My key is sk-live-abcdefghijklmnopqrstuvwxyz123456" },
        { role: "assistant" as const, text: "Do not store that token." },
        { role: "user" as const, text: "Remember the full Tank import plan." },
      ],
    };

    const artifacts = buildChatArtifacts(record, {
      timestamp: 1_700_000_000_000,
      maxChunkChars: 80,
    });
    const again = buildChatArtifacts(record, {
      timestamp: 9_999,
      maxChunkChars: 80,
    });

    assert.equal(artifacts[0].id, again[0].id);
    assert.match(artifacts[0].id, /^chat-[a-f0-9]{16}$/);
    assert.ok(artifacts.length > 1);
    assert.deepEqual(artifacts[1].parentArtifactIds, [artifacts[0].id]);
    assert.ok(artifacts.every((artifact) => !JSON.stringify(artifact).includes("sk-live")));
    assert.ok(JSON.stringify(artifacts).includes("[REDACTED_SECRET]"));
  });

  it("keeps transcript terms searchable through keyword fallback", () => {
    const artifacts = buildChatArtifacts({
      id: "codex:sess-keyword",
      source: "codex",
      title: "Keyword chat",
      rawRef: "keyword.jsonl",
      messages: [
        { role: "user", text: "Please remember the dagtacular import detail." },
        { role: "assistant", text: "The detail belongs in a chunk artifact." },
      ],
    });

    const matches = findRelevantArtifacts(artifacts, "dagtacular", 3);

    assert.ok(matches.length > 0);
    assert.ok(matches.some((artifact) => artifact.keywords.includes("dagtacular")));
  });

  it("imports chat artifacts and vectorizes them with an injected embedder", async () => {
    const root = await tempRoot();
    const hoard = new Hoard(join(root, ".goblintown", "hoard"));
    await hoard.init();

    const result = await importChatRecords({
      hoard,
      records: [
        {
          id: "codex:sess-vector",
          source: "codex",
          title: "Vector chat",
          rawRef: "vector.jsonl",
          messages: [
            { role: "user", text: "Goblintown needs indexed chat memory." },
            { role: "assistant", text: "Precompute embeddings on import." },
          ],
        },
      ],
      vectorize: true,
      embedder: async (text) => [text.length, 1],
      timestamp: 1_700_000_000_000,
    });

    assert.equal(result.records.length, 1);
    assert.equal(result.artifacts.length, 2);
    assert.equal(result.vectorized, 2);

    const stored = await hoard.allArtifacts();
    assert.equal(stored.length, 2);
    assert.ok(stored.every((artifact) => artifact.embedding?.length === 2));
  });

  it("uses explicit AI summaries only when requested", async () => {
    const root = await tempRoot();
    const hoard = new Hoard(join(root, ".goblintown", "hoard"));
    await hoard.init();
    let calls = 0;

    const result = await importChatRecords({
      hoard,
      records: [
        {
          id: "codex:sess-summary",
          source: "codex",
          title: "Summary chat",
          rawRef: "summary.jsonl",
          messages: [{ role: "user", text: "Summarize only when explicitly asked." }],
        },
      ],
      summarize: true,
      summarizer: async () => {
        calls++;
        return "AI summary: explicit distillation captured durable decisions.";
      },
      vectorize: false,
    });

    assert.equal(calls, 1);
    assert.match(result.artifacts[0].claims[0].text, /AI summary/);
  });

  it("scans Codex session directories and filters by query", async () => {
    const root = await tempRoot();
    const sessionDir = join(root, ".codex", "sessions", "2026", "05", "22");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "rollout-demo.jsonl"),
      [
        JSON.stringify({ type: "session_meta", timestamp: "2026-05-22T00:00:00.000Z", payload: { id: "demo" } }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-05-22T00:01:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Build previous chat import mode." }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const all = await scanChatImports({
      source: "codex",
      path: join(root, ".codex", "sessions"),
      query: "previous chat",
    });
    const none = await scanChatImports({
      source: "codex",
      path: join(root, ".codex", "sessions"),
      query: "unrelated solana",
    });

    assert.equal(all.records.length, 1);
    assert.equal(none.records.length, 0);
  });

  it("vectorizes stored artifacts that are missing embeddings", async () => {
    const root = await tempRoot();
    const hoard = new Hoard(join(root, ".goblintown", "hoard"));
    await hoard.init();
    const artifacts = buildChatArtifacts({
      id: "codex:sess-missing",
      source: "codex",
      title: "Missing vectors",
      rawRef: "missing.jsonl",
      messages: [{ role: "user", text: "Vectorize missing artifacts." }],
    });
    for (const artifact of artifacts) await hoard.stashArtifact(artifact);

    const result = await vectorizeStoredArtifacts({
      hoard,
      missingOnly: true,
      embedder: async (text) => [1, text.length],
    });

    assert.equal(result.vectorized, artifacts.length);
    const stored = await hoard.allArtifacts();
    assert.ok(stored.every((artifact) => artifact.embedding?.length === 2));
  });

  it("redacts common API-key shaped secrets", () => {
    assert.equal(
      redactSecrets("OPENAI_API_KEY=sk-test-abcdefghijklmnopqrstuvwxyz123456"),
      "OPENAI_API_KEY=[REDACTED_SECRET]",
    );
  });
});
