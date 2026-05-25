import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSingleGoblinChatPrompt,
  collectChatWebToolResults,
  detectGoblintownOffer,
  extractChatWebUrls,
  normalizeLikelyChatUrls,
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
    assert.match(prompt, /Goblintown vocabulary/);
    assert.match(prompt, /A rite is a full Goblintown run/);
    assert.match(prompt, /The Tank is the main app surface/);
    assert.match(prompt, /Loot is a saved model output/);
    assert.match(prompt, /Be useful first, with a little Goblintown-native bite/);
    assert.match(prompt, /User: What changed\?/);
    assert.match(prompt, /Assistant: The route changed\./);
    assert.match(prompt, /User: Summarize it\./);
  });

  it("extracts public web URLs from the latest chat message", () => {
    const urls = extractChatWebUrls([
      { role: "user", content: "ignore https://old.example/a" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "Check https://github.com/0xbl33p/goblintown, then https://example.com/docs." },
    ]);

    assert.deepEqual(urls, [
      "https://github.com/0xbl33p/goblintown",
      "https://example.com/docs",
    ]);
  });

  it("normalizes obvious GitHub issue URL typo suffixes", () => {
    assert.equal(
      normalizeLikelyChatUrls("Run https://github.com/aeyakovenko/percolator-cli/issues/72g please"),
      "Run https://github.com/aeyakovenko/percolator-cli/issues/72 please",
    );
    assert.deepEqual(
      extractChatWebUrls([
        { role: "user", content: "Solve https://github.com/aeyakovenko/percolator-cli/issues/72g" },
      ]),
      ["https://github.com/aeyakovenko/percolator-cli/issues/72"],
    );
    assert.equal(
      detectGoblintownOffer([
        { role: "user", content: "Lets run a rite to solve this bounty: https://github.com/aeyakovenko/percolator-cli/issues/72g" },
      ])?.task,
      "Lets run a rite to solve this bounty: https://github.com/aeyakovenko/percolator-cli/issues/72",
    );
  });

  it("adds fetched website context to the single-goblin prompt", async () => {
    const results = await collectChatWebToolResults(
      [{ role: "user", content: "What is on https://github.com/example/repo?" }],
      async () =>
        new Response("<html><title>Repo Page</title><body><h1>Example Repo</h1><p>Important README text.</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const prompt = buildSingleGoblinChatPrompt(
      [{ role: "user", content: "What is on https://github.com/example/repo?" }],
      results,
    );

    assert.equal(results.length, 1);
    assert.match(prompt, /Web tool results/);
    assert.match(prompt, /https:\/\/github.com\/example\/repo/);
    assert.match(prompt, /Repo Page/);
    assert.match(prompt, /Important README text/);
    assert.match(prompt, /cite the relevant URL/);
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

  it("treats explicit rite requests as run requests", () => {
    const offer = detectGoblintownOffer([
      { role: "user", content: "Run a rite about whether the Beatles are good." },
    ]);

    assert.deepEqual(offer, {
      task: "Run a rite about whether the Beatles are good.",
      requested: true,
      reason: "explicit",
    });
  });

  it("uses the previous user task for bare rite follow-ups", () => {
    const offer = detectGoblintownOffer([
      { role: "user", content: "Is Abbey Road better than Revolver?" },
      { role: "assistant", content: "Short answer: close call." },
      { role: "user", content: "do a rite" },
    ]);

    assert.deepEqual(offer, {
      task: "Is Abbey Road better than Revolver?",
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
    assert.match(serverSource, /id="chat-send" type="submit" title="Send \(Enter or Cmd\/Ctrl\+Enter\)"/);
    assert.match(serverSource, /id="chat-offer-run"/);
    assert.match(serverSource, /fetch\("\/api\/rite"/);
    assert.match(serverSource, /async function startOfferedRite\(taskValue\)/);
    assert.match(serverSource, /body\.goblintownOffer && body\.goblintownOffer\.requested/);
    assert.match(serverSource, /await startOfferedRite\(body\.goblintownOffer\.task\)/);
    assert.match(serverSource, /input\.addEventListener\("keydown", \(event\) =>/);
    assert.match(serverSource, /event\.key !== "Enter" \|\| event\.shiftKey/);
    assert.match(serverSource, /event\.metaKey \|\| event\.ctrlKey \|\| !event\.altKey/);
    assert.match(serverSource, /function submitChatForm\(\)/);
    assert.match(serverSource, /typeof form\.requestSubmit === "function"/);
    assert.match(serverSource, /send\.click\(\)/);
    assert.match(serverSource, /submitChatForm\(\)/);
  });

  it("makes the Tank root chat-first and swaps to Tank mode for runs", () => {
    assert.match(serverSource, /id="root-chat-form"/);
    assert.match(serverSource, /class="tank chat-mode codex-chat-surface"/);
    assert.match(serverSource, /function showTankMode\(\)/);
    assert.match(serverSource, /function showChatMode\(\)/);
    assert.match(serverSource, /startGoblintownFromChat/);
  });

  it("exposes separate chats and rites in the left sidebar", () => {
    assert.match(serverSource, /<aside class="ops-sidebar goblin-sidebar" id="ops-sidebar">/);
    assert.match(
      serverSource,
      /<aside class="ops-sidebar goblin-sidebar" id="ops-sidebar">[\s\S]*\+ New chat[\s\S]*\+ New rite[\s\S]*CHATS[\s\S]*Bounty issue #72 chat[\s\S]*Solana wallet question[\s\S]*README cleanup chat[\s\S]*RITES[\s\S]*Bounty issue #72[\s\S]*Provider setup audit[\s\S]*Tank UI simplification[\s\S]*<\/aside>/,
    );
    assert.match(serverSource, /<button class="sr-only" id="btn-regular-rite"/);
    assert.match(serverSource, /id="settings-icon-closed"[^>]*src="\/assets\/settingsclosed\.svg"/);
    assert.match(serverSource, /id="settings-icon-open"[^>]*src="\/assets\/settingsopen\.svg"/);
    assert.match(serverSource, /id="sidebar-settings-card"[\s\S]*Goblin Country[\s\S]*Moss Ledger[\s\S]*Code: MOSS7 · Signed in[\s\S]*Never trust a clean cache/);
    assert.match(serverSource, /\.sidebar-settings-card \{[\s\S]*position: absolute;[\s\S]*bottom: calc\(100% \+ 0\.75rem\);/);
    assert.doesNotMatch(serverSource, /id="btn-api-configs"/);
    assert.doesNotMatch(serverSource, /id="ops-line"/);
    assert.doesNotMatch(serverSource, /id="ops-run"/);
    assert.doesNotMatch(serverSource, /id="ops-examples"/);
    assert.doesNotMatch(serverSource, /Live Tank/);
  });

  it("exposes the simplified chat composer controls and keyboard affordances", () => {
    assert.match(serverSource, /CHAT_PERSONA_UI\.intro/);
    assert.match(serverSource, /const CHAT_PERSONA = /);
    assert.match(serverSource, /function chatPersonaPick\(kind\)/);
    assert.match(serverSource, /function setRootChatStatus\(kind, detail\)/);
    assert.match(
      serverSource,
      /<div class="chat-thread" id="chat-thread"[\s\S]*<\/div>[\s\S]*<form class="chat-composer" id="root-chat-form">/,
    );
    assert.match(serverSource, /id="root-chat-send"[^>]*type="submit"[^>]*title="Send \(Enter\)"[\s\S]*↑/);
    assert.match(serverSource, /id="root-chat-voice" type="button" class="voice-trigger" title="Voice mode"/);
    assert.match(serverSource, /class="voice-menu"[\s\S]*fullgoblinchat\.svg[\s\S]*Chat Live[\s\S]*sttgoblinchat\.svg[\s\S]*Speak Only[\s\S]*ttsonlygoblinchat\.svg[\s\S]*Listen Only/);
    assert.match(serverSource, /id="root-chat-personality-label"[\s\S]*goblin_mode/);
    assert.match(serverSource, /class="personality-menu"[\s\S]*chipper[\s\S]*nerdy[\s\S]*stoic[\s\S]*cynical[\s\S]*feral[\s\S]*goblin_mode/);
    assert.match(serverSource, /<button id="root-chat-speak" type="button" class="sr-only" title="Speak replies" aria-label="Speak replies" aria-pressed="false">/);
    assert.doesNotMatch(serverSource, />Voice<\/button>/);
    assert.doesNotMatch(serverSource, />Speak<\/button>/);
    assert.doesNotMatch(serverSource, /Max tokens/);
    assert.match(serverSource, /<select id="root-chat-model"/);
    assert.match(serverSource, /<select id="root-chat-personality"/);
    assert.match(serverSource, /const tooltipEl = document\.createElement\("div"\)/);
    assert.match(serverSource, /function resetRootChat\(\)/);
    assert.match(serverSource, /\$\("btn-chat"\)\.onclick = \(\) => \{[\s\S]*resetRootChat\(\);/);
    assert.match(serverSource, /\$\("root-chat-input"\)\.addEventListener\("keydown", \(event\) =>/);
    assert.match(serverSource, /event\.shiftKey && event\.key === "Enter"/);
    assert.match(serverSource, /if \(event\.key === "Enter"\) \{/);
    assert.match(serverSource, /\$\("root-chat-form"\)\.requestSubmit\(\)/);
    assert.match(serverSource, /modelSlot: \$\("root-chat-model"\)\.value === "inherit" \? undefined : \$\("root-chat-model"\)\.value/);
    assert.match(serverSource, /chatPersonaPick\("emptyResponse"\)/);
    assert.match(serverSource, /body\.goblintownOffer && body\.goblintownOffer\.requested/);
    assert.match(serverSource, /chatPersonaPick\("handoff"\)/);
    assert.match(serverSource, /await startGoblintownFromChat\(body\.goblintownOffer\.task\)/);
  });

  it("wires browser text-to-speech for single-goblin replies", () => {
    assert.match(serverSource, /let rootChatSpeakEnabled = false/);
    assert.match(serverSource, /function browserTtsSupported\(\)/);
    assert.match(serverSource, /"speechSynthesis" in window && "SpeechSynthesisUtterance" in window/);
    assert.match(serverSource, /function goblinTtsText\(value\)/);
    assert.match(serverSource, /function speakRootChatMessage\(content\)/);
    assert.match(serverSource, /new SpeechSynthesisUtterance\(text\)/);
    assert.match(serverSource, /window\.speechSynthesis\.speak\(utterance\)/);
    assert.match(serverSource, /\$\("root-chat-speak"\)\.onclick = \(\) =>/);
    assert.match(serverSource, /speakRootChatMessage\(body\.message\.content\)/);
    assert.match(serverSource, /\["root-chat-speak", "Read single-goblin replies aloud with browser text-to-speech\."\]/);
  });

  it("starts New Rite as a chat-guided rite type question", () => {
    assert.match(serverSource, /function startNewRiteChatFlow\(\)/);
    assert.match(serverSource, /What type of rite should we run\?/);
    assert.match(serverSource, /regular · thesis · crypto\/onchain · sentiment · plan/);
    assert.match(serverSource, /\$\("btn-rite"\)\.onclick = startNewRiteChatFlow/);
    assert.match(serverSource, /\$\("btn-regular-rite"\)\.onclick = startNewRiteChatFlow/);
  });
});
