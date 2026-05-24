import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSingleGoblinChatPrompt,
  detectGoblintownOffer,
  normalizeChatMessages,
} from "../chat.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");

describe("single goblin chat", () => {
  it("normalizes only user and assistant messages", () => {
    const messages = normalizeChatMessages([
      { role: "system", content: "ignored" },
      { role: "user", content: "  hello  " },
      { role: "assistant", content: "hi" },
      { role: "user", content: "" },
      null,
    ]);

    assert.deepEqual(messages, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("builds a single-goblin prompt from chat history", () => {
    const prompt = buildSingleGoblinChatPrompt([
      { role: "user", content: "What changed?" },
      { role: "assistant", content: "The route changed." },
      { role: "user", content: "Summarize it." },
    ]);

    assert.match(prompt, /AI-first single Goblin chat mode/);
    assert.match(prompt, /regular single LLM model call/);
    assert.match(prompt, /Do not run multi-agent Goblintown orchestration/);
    assert.match(prompt, /User: What changed\?/);
    assert.match(prompt, /Assistant: The route changed\./);
    assert.match(prompt, /User: Summarize it\./);
  });

  it("offers Goblintown for explicit requests", () => {
    const offer = detectGoblintownOffer([
      { role: "user", content: "Run Goblintown on this migration plan." },
    ]);

    assert.deepEqual(offer, {
      task: "Run Goblintown on this migration plan.",
      requested: true,
      reason: "explicit",
    });
  });

  it("offers Goblintown for complex tasks without auto-running it", () => {
    const offer = detectGoblintownOffer([
      {
        role: "user",
        content:
          "Audit this production migration plan, compare the risks, design a rollback strategy, and identify likely edge cases before implementation.",
      },
    ]);

    assert.equal(offer?.requested, false);
    assert.equal(offer?.reason, "complex");
  });

  it("does not offer Goblintown for simple chat", () => {
    const offer = detectGoblintownOffer([
      { role: "user", content: "What is this repo?" },
    ]);

    assert.equal(offer, undefined);
  });

  it("rejects prompts without a latest user message", () => {
    assert.throws(
      () => buildSingleGoblinChatPrompt([{ role: "assistant", content: "ready" }]),
      /latest user message/,
    );
  });

  it("exposes the chat page and api from the Tank server", () => {
    assert.match(serverSource, /app\.get\("\/chat"/);
    assert.match(serverSource, /app\.post\("\/api\/chat"/);
    assert.match(serverSource, /id="btn-chat"/);
    assert.match(serverSource, /id="chat-form"/);
    assert.match(serverSource, /id="chat-offer-run"/);
    assert.match(serverSource, /fetch\("\/api\/rite"/);
  });

  it("makes the Tank root chat-first and swaps to Tank mode for runs", () => {
    assert.match(serverSource, /id="root-chat-form"/);
    assert.match(serverSource, /class="tank chat-mode"/);
    assert.match(serverSource, /function showTankMode\(\)/);
    assert.match(serverSource, /function showChatMode\(\)/);
    assert.match(serverSource, /startGoblintownFromChat/);
  });

  it("exposes AI-first Tank navigation in the left sidebar", () => {
    assert.match(serverSource, /<aside class="ops-sidebar" id="ops-sidebar">/);
    assert.match(
      serverSource,
      /<aside class="ops-sidebar" id="ops-sidebar">[\s\S]*New Chat[\s\S]*New Rite[\s\S]*API Configs[\s\S]*Rites[\s\S]*Chats[\s\S]*Settings[\s\S]*<\/aside>/,
    );
  });

  it("exposes the AI-first Tank chat composer controls and keyboard affordances", () => {
    assert.match(
      serverSource,
      /<div class="chat-thread" id="chat-thread"[\s\S]*<\/div>[\s\S]*<form class="chat-composer" id="root-chat-form">/,
    );
    assert.match(serverSource, /<button id="root-chat-send" type="submit" title="Send \(Cmd\/Ctrl\+Enter\)">Send<\/button>/);
    assert.match(serverSource, /<button id="root-chat-voice" type="button" title="Voice">Voice<\/button>/);
    assert.match(serverSource, /<select id="root-chat-model"/);
    assert.match(serverSource, /<select id="root-chat-personality"/);
    assert.match(serverSource, /const tooltipEl = document\.createElement\("div"\)/);
    assert.match(serverSource, /\$\("root-chat-input"\)\.addEventListener\("keydown", \(event\) =>/);
    assert.match(serverSource, /event\.shiftKey && event\.key === "Enter"/);
    assert.match(serverSource, /\(event\.metaKey \|\| event\.ctrlKey\) && event\.key === "Enter"/);
    assert.match(serverSource, /\$\("root-chat-form"\)\.requestSubmit\(\)/);
  });

  it("starts New Rite as a chat-guided rite type question", () => {
    assert.match(serverSource, /function startNewRiteChatFlow\(\)/);
    assert.match(serverSource, /What type of rite should we run\?/);
    assert.match(serverSource, /regular · thesis · crypto\/onchain · sentiment · plan/);
    assert.match(serverSource, /\$\("btn-rite"\)\.onclick = startNewRiteChatFlow/);
  });
});
