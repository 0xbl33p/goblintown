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

function assertContainsInOrder(source: string, values: string[]): void {
  let cursor = 0;
  for (const value of values) {
    const next = source.indexOf(value, cursor);
    assert.notEqual(next, -1, `expected source to include ${value}`);
    cursor = next + value.length;
  }
}

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
      /<aside class="ops-sidebar goblin-sidebar" id="ops-sidebar">[\s\S]*\+ New chat[\s\S]*\+ New rite[\s\S]*CHATS[\s\S]*Bounty issue #72 chat[\s\S]*Solana wallet question[\s\S]*README cleanup chat[\s\S]*RITES[\s\S]*sidebarRiteButtons\(runs\)[\s\S]*<\/aside>/,
    );
    assert.match(serverSource, /function sidebarRiteButtons\(runs: Map<string, RunState>\)[\s\S]*Bounty issue #72[\s\S]*Provider setup audit[\s\S]*Tank UI simplification/);
    assert.match(serverSource, /<button class="sr-only" id="btn-regular-rite"/);
    assert.match(serverSource, /id="settings-icon-closed"[^>]*src="\/assets\/settingsclosed\.svg"/);
    assert.match(serverSource, /id="settings-icon-open"[^>]*src="\/assets\/settingsopen\.svg"/);
    assert.match(serverSource, /id="sidebar-settings-card"[\s\S]*Goblin Country[\s\S]*Moss Ledger[\s\S]*Code: MOSS7 · Signed in[\s\S]*Never trust a clean cache/);
    assert.match(serverSource, /\.sidebar-settings-card \{[\s\S]*position: absolute;[\s\S]*bottom: calc\(100% \+ 0\.75rem\);/);
    assert.match(serverSource, /<div class="ops-quick">[\s\S]*<\/div>\n        <div class="sidebar-settings" id="sidebar-settings">/);
    assert.match(serverSource, /\.ops-quick \{[\s\S]*flex: 1 1 auto;[\s\S]*min-height: 0;[\s\S]*overflow-y: auto;/);
    assert.match(serverSource, /\.sidebar-settings \{[\s\S]*margin-top: auto;[\s\S]*flex: 0 0 auto;/);
    assert.match(serverSource, /\.settings-icon \{[\s\S]*width: 1\.9rem;[\s\S]*aspect-ratio: 210 \/ 246;[\s\S]*height: auto;/);
    assert.match(serverSource, /\.settings-trigger \{[\s\S]*align-items: center;/);
    assert.doesNotMatch(serverSource, /id="btn-api-configs"/);
    assert.doesNotMatch(serverSource, /id="ops-line"/);
    assert.doesNotMatch(serverSource, /id="ops-run"/);
    assert.doesNotMatch(serverSource, /id="ops-examples"/);
    assert.doesNotMatch(serverSource, /Live Tank/);
  });

  it("collapses sidebar sections and moves town stats to the status bar", () => {
    assert.match(serverSource, /<span class="name" id="town-identity">Goblintown ·/);
    assert.doesNotMatch(serverSource, /<span class="name">WARREN ·/);
    assert.doesNotMatch(serverSource, /<span class="stat"><b id="stat-loot"/);
    assert.match(serverSource, /<span class="status-stats" id="status-stats">[\s\S]*id="stat-loot"[\s\S]*id="stat-rites"[\s\S]*id="stat-drift"/);
    assert.match(serverSource, /const tierName = \["unincorporated","hamlet","village","town","city"/);
    assert.match(serverSource, /id="surface-mode">chat<\/span>/);
    assert.match(serverSource, /function setSurfaceMode\(mode\)/);
    assert.match(serverSource, /setSurfaceMode\("chat"\)/);
    assert.match(serverSource, /setSurfaceMode\("rite"\)/);
    assert.match(serverSource, /class="sidebar-section-toggle"[\s\S]*data-sidebar-toggle="chats"[\s\S]*CHATS/);
    assert.match(serverSource, /class="sidebar-section-toggle"[\s\S]*data-sidebar-toggle="rites"[\s\S]*RITES/);
    assert.match(serverSource, /function setSidebarSectionCollapsed\(section, collapsed\)/);
    assert.match(serverSource, /\.sidebar-list\.collapsed \.sidebar-items \{[\s\S]*display: none;/);
  });

  it("opens settings as an inline sidebar surface instead of a floating top menu", () => {
    assert.match(serverSource, /<section class="settings-surface" id="settings-surface" hidden/);
    assert.match(serverSource, /<div id="settings-panel-dock" hidden><\/div>/);
    assertContainsInOrder(serverSource, [
      '<div class="settings-sidebar-panel" id="settings-sidebar-panel" hidden>',
      'id="settings-sidebar-menu"',
      "Account",
      "Country",
      "Group Chats",
      "Add-ons",
      "API",
      "Voice",
      "Solana Tools",
      "Context APIs",
      "Import Records",
      "Reset",
    ]);
    assert.doesNotMatch(serverSource, /id="settings-sidebar-surface-panel"/);
    assert.doesNotMatch(serverSource, /data-settings-section="mail">Mail<\/button>/);
    assert.doesNotMatch(serverSource, /id="settings-surface-menu"/);
    assert.match(serverSource, /\.ops-sidebar\.settings-mode \.ops-main,[\s\S]*\.ops-sidebar\.settings-mode \.ops-head \.ops-toggle \{[\s\S]*display: none;/);
    assert.match(serverSource, /\.chat-main\.settings-active \.chat-composer \{[\s\S]*display: none;/);
    assert.match(serverSource, /function setSidebarSettingsMode\(open\)/);
    assert.match(serverSource, /settingsSidebarPanel\.hidden = !open/);
    assert.match(serverSource, /settingsSidebarBack\.onclick = \(\) => \{[\s\S]*setSidebarSettingsMode\(false\);[\s\S]*showChatThreadSurface\(\);/);
    assert.match(serverSource, /function showSettingsSurface\(\)/);
    assert.match(serverSource, /sidebarFullSettings\.onclick = \(\) => \{[\s\S]*showSettingsSurface\(\);/);
    assert.match(serverSource, /function showSettingsSection\(section\)/);
    assert.match(serverSource, /settingsPopover\.classList\.toggle\("open", false\)/);
    assert.match(serverSource, /\$\("settings-surface-panel"\)\.innerHTML = settingsSectionHtml\(section\);/);
    assertContainsInOrder(serverSource, [
      "const settingsEmbeddedPanelIds = {",
      'account: "auth-popover"',
      'country: "country-popover"',
      'groups: "mail-popover"',
      'addons: "addon-popover"',
      'api: "provider-popover"',
      'voice: "voice-popover"',
      'solana: "onchain-popover"',
      'context: "sentiment-config-popover"',
      'reset: "settings-reset-panel"',
    ]);
    assert.match(serverSource, /function clearSettingsEmbeddedPanel\(\)/);
    assert.match(serverSource, /\.settings-surface-panel \.settings-embedded \{[\s\S]*position: static;[\s\S]*width: 100%;/);
    assert.match(serverSource, /target\.appendChild\(panel\);[\s\S]*panel\.classList\.add\("settings-embedded", "open"\);/);
    assert.match(serverSource, /setSidebarSettingsMode\(true\);[\s\S]*\$\("chat-main"\)\.classList\.add\("settings-active"\);[\s\S]*\$\("settings-surface"\)\.hidden = false;/);
  });

  it("embeds real settings controls into the main settings canvas", () => {
    assert.match(serverSource, /id="auth-popover"[\s\S]*id="cloud-local-mode"[\s\S]*id="cloud-enable-mode"[\s\S]*id="auth-google-btn"/);
    assert.match(serverSource, /id="country-popover"[\s\S]*id="country-enabled"[\s\S]*id="country-backend"[\s\S]*id="country-save"/);
    assert.match(serverSource, /id="mail-popover"[\s\S]*id="friend-target-code"[\s\S]*id="dm-compose-body"[\s\S]*id="dm-send-btn"/);
    assert.match(serverSource, /id="addon-popover"[\s\S]*id="addon-list"[\s\S]*id="addon-status"/);
    assert.match(serverSource, /id="provider-popover"[\s\S]*id="provider-preset"[\s\S]*id="provider-baseurl"[\s\S]*id="provider-save"/);
    assert.match(serverSource, /id="voice-popover"[\s\S]*id="voice-provider"[\s\S]*id="voice-baseurl"[\s\S]*id="voice-save"/);
    assert.match(serverSource, /id="onchain-popover"[\s\S]*id="onchain-address"[\s\S]*id="onchain-lookup"[\s\S]*id="onchain-transaction"/);
    assert.match(serverSource, /id="sentiment-config-popover"[\s\S]*id="sentiment-sources"[\s\S]*id="sentiment-secret-source"[\s\S]*id="sentiment-save-secret"/);
    assert.match(serverSource, /id="settings-reset-panel"[\s\S]*id="btn-asteroid"[\s\S]*Asteroid Mode/);
  });

  it("keeps first-run onboarding from swallowing app control clicks", () => {
    assert.match(serverSource, /const onboardingStorageKey = "goblintown\.onboarding\.v3"/);
    assert.match(serverSource, /id="onboard-provider-actions"[\s\S]*data-onboard-provider="openai"[\s\S]*data-onboard-provider="deepseek"[\s\S]*data-onboard-provider="lmstudio"[\s\S]*data-onboard-provider="ollama"[\s\S]*data-onboard-provider="anthropic"[\s\S]*data-onboard-provider="custom"/);
    assert.match(serverSource, /title: "Power the Chat"/);
    assert.match(serverSource, /async function chooseOnboardingProvider\(preset\)/);
    assert.match(serverSource, /showSettingsSurface\(\);[\s\S]*showSettingsSection\("api"\)/);
    assert.match(serverSource, /fetch\("\/api\/provider"/);
    assert.match(serverSource, /\.onboard-overlay \{[\s\S]*pointer-events: none;/);
    assert.match(serverSource, /\.onboard-card \{[\s\S]*pointer-events: auto;/);
  });

  it("keeps new chat and new rite as pinned unboxed sidebar actions", () => {
    assert.match(serverSource, /<div class="ops-actions" aria-label="New work">[\s\S]*id="btn-chat"[\s\S]*id="btn-rite"[\s\S]*<\/div>/);
    assert.match(serverSource, /\.ops-actions \.btn \{[\s\S]*min-height: 1\.45rem;[\s\S]*border: 0;[\s\S]*background: transparent;[\s\S]*text-align: left;/);
    assert.match(serverSource, /\.ops-actions \.btn\.primary \{[\s\S]*background: transparent;[\s\S]*border: 0;/);
    assert.doesNotMatch(serverSource, /\.ops-quick \.btn \{[\s\S]*border-radius: 8px;/);
  });

  it("makes record import ready inside the settings surface", () => {
    assert.match(serverSource, /settings-import-source/);
    assert.match(serverSource, /settings-import-query/);
    assert.match(serverSource, /settings-import-scan/);
    assert.match(serverSource, /settings-import-all/);
    assert.match(serverSource, /function scanSettingsImports\(\)/);
    assert.match(serverSource, /fetch\("\/api\/context\/chats\/scan"/);
    assert.match(serverSource, /function importSettingsRecords\(all\)/);
    assert.match(serverSource, /fetch\("\/api\/context\/chats\/import"/);
  });

  it("renames the friends messaging surface to group chats", () => {
    assert.match(serverSource, /data-settings-section="groups">Group Chats<\/button>/);
    assert.match(serverSource, /groups: \["Group Chats", "Friend group chats, shared threads, and collaboration rooms\."\]/);
    assert.match(serverSource, /<h3>Friends & Group Chats<\/h3>/);
    assert.match(serverSource, /<h4>Group Chats<\/h4>/);
    assert.match(serverSource, /encrypted group chat payloads/);
    assert.match(serverSource, /No group chats yet\./);
    assert.doesNotMatch(serverSource, /<h3>Friends & Mail<\/h3>/);
    assert.doesNotMatch(serverSource, /<h4>Threads<\/h4>/);
    assert.doesNotMatch(serverSource, /DM threads/);
  });

  it("loads chats and rites from the sidebar into the main surface", () => {
    assert.match(serverSource, /data-surface-kind="chat" data-chat-id="bounty-72-chat"/);
    assert.match(serverSource, /data-surface-kind="rite" data-run-id="sample-bounty-72"/);
    assert.match(serverSource, /id="root-rite-surface"/);
    assert.match(serverSource, /id="root-rite-discussion"/);
    assert.match(serverSource, /function sidebarRiteButtons\(runs: Map<string, RunState>\)/);
    assert.match(serverSource, /res\.send\(tankHtml\(warren\.manifest\.name, warren\.manifest\.country, loot\.length, rites\.length, drift, runs\)\)/);
    assert.match(serverSource, /\[\.\.\.runs\.values\(\)\][\s\S]*sort\(\(a, b\) => b\.record\.startedAt - a\.record\.startedAt\)[\s\S]*slice\(0, 6\)/);
    assert.match(serverSource, /function selectSidebarSurface\(kind, id\)/);
    assert.match(serverSource, /function renderInlineRite\(record\)/);
    assert.match(serverSource, /fetch\("\/api\/runs\/" \+ encodeURIComponent\(runId\) \+ "\?full=1"\)/);
    assert.match(serverSource, /const events = Array\.isArray\(record\.events\) \? record\.events : \[\]/);
    assert.doesNotMatch(serverSource, /record\.events\.slice/);
  });

  it("exposes the simplified chat composer controls and keyboard affordances", () => {
    assert.match(serverSource, /CHAT_PERSONA_UI\.intro/);
    assert.match(serverSource, /const CHAT_PERSONA = /);
    assert.match(serverSource, /function chatPersonaPick\(kind\)/);
    assert.match(serverSource, /function setRootChatStatus\(kind, detail\)/);
    assert.match(
      serverSource,
      /<div class="chat-thread" id="chat-thread"[\s\S]*<section class="settings-surface" id="settings-surface" hidden[\s\S]*<form class="chat-composer" id="root-chat-form">/,
    );
    assert.match(serverSource, /id="root-chat-send"[^>]*type="submit"[^>]*title="Send \(Enter\)"[\s\S]*↑/);
    assert.match(serverSource, /id="root-chat-voice" type="button" class="voice-trigger" title="Voice mode"/);
    assert.match(serverSource, /id="root-chat-voice"[\s\S]*textgoblinchat\.svg/);
    assert.match(serverSource, /class="voice-menu"[\s\S]*textgoblinchat\.svg[\s\S]*Text[\s\S]*fullgoblinchat\.svg[\s\S]*Chat Live[\s\S]*sttgoblinchat\.svg[\s\S]*Speak Only[\s\S]*ttsonlygoblinchat\.svg[\s\S]*Listen Only/);
    assert.match(serverSource, /function setRootChatVoiceMode\(mode\)/);
    assert.match(serverSource, /\$\("root-chat-voice"\)\.onclick = \(\) => \{[\s\S]*if \(rootChatVoiceMode !== "text"\) \{[\s\S]*setRootChatVoiceMode\("text"\);/);
    assert.match(serverSource, /if \(mode === "text"\) \{[\s\S]*setRootChatSpeakEnabled\(false\);[\s\S]*return;/);
    assert.match(serverSource, /function setVoiceTriggerIcon\(button\)/);
    assert.match(serverSource, /recognition\.onerror = \(event\) => setRootChatStatus\("voicePending", voiceInputErrorMessage\(event\)\)/);
    assert.match(serverSource, /toggleServerVoice\(activeGeneration\)\.catch\(\(err\) => \{[\s\S]*setRootChatStatus\("voicePending", voiceInputErrorMessage\(err\)\);/);
    assert.match(serverSource, /\.voice-menu \.voice-choice \{[\s\S]*background: transparent !important;[\s\S]*border: 0 !important;/);
    assert.doesNotMatch(serverSource, /\.voice-choice:hover,\n  \.voice-choice\.active,[^}]*background:/);
    assert.match(serverSource, /id="root-chat-personality-label"[\s\S]*goblin_mode/);
    assert.match(serverSource, /class="personality-menu"[\s\S]*chipper[\s\S]*nerdy[\s\S]*stoic[\s\S]*cynical[\s\S]*feral[\s\S]*goblin_mode/);
    assert.match(serverSource, /<button id="root-chat-speak" type="button" class="sr-only" title="Speak replies" aria-label="Speak replies" aria-pressed="false">/);
    assert.doesNotMatch(serverSource, /<button[^>]*id="root-chat-voice"[^>]*>Voice<\/button>/);
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
    assert.match(serverSource, /let rootChatSpeaking = false/);
    assert.match(serverSource, /let rootChatSpeechGeneration = 0/);
    assert.match(serverSource, /function browserTtsSupported\(\)/);
    assert.match(serverSource, /"speechSynthesis" in window && "SpeechSynthesisUtterance" in window/);
    assert.match(serverSource, /function goblinTtsText\(value\)/);
    assert.match(serverSource, /function speakRootChatMessage\(content\)/);
    assert.match(serverSource, /stopVoiceInput\(\);[\s\S]*rootChatSpeaking = true/);
    assert.match(serverSource, /const finishSpeech = \(\) => \{[\s\S]*rootChatSpeaking = false;[\s\S]*scheduleLiveVoiceRestart\(\);/);
    assert.match(serverSource, /new SpeechSynthesisUtterance\(text\)/);
    assert.match(serverSource, /window\.speechSynthesis\.speak\(utterance\)/);
    assert.match(serverSource, /\$\("root-chat-speak"\)\.onclick = \(\) =>/);
    assert.match(serverSource, /const speakingReply = speakRootChatMessage\(body\.message\.content\)/);
    assert.match(serverSource, /else if \(!speakingReply\) setRootChatStatus\("ready"\)/);
    assert.match(serverSource, /\["root-chat-speak", "Read single-goblin replies aloud with browser text-to-speech\."\]/);
  });

  it("starts New Rite as a chat-guided rite type question", () => {
    assert.match(serverSource, /function startNewRiteChatFlow\(\)/);
    assert.match(serverSource, /What type of rite should we run\?/);
    assert.match(serverSource, /className = "rite-choice-row"/);
    assert.match(serverSource, /\["regular", "Regular"\]/);
    assert.match(serverSource, /\["thesis", "Thesis"\]/);
    assert.match(serverSource, /\["onchain", "Crypto\/onchain"\]/);
    assert.match(serverSource, /\["sentiment", "Sentiment"\]/);
    assert.match(serverSource, /\["plan", "Plan"\]/);
    assert.match(serverSource, /button\.setAttribute\("data-rite-choice", choice\)/);
    assert.match(serverSource, /function handleRiteChoice\(choice\)/);
    assert.match(serverSource, /function clearRiteChoiceRows\(\)/);
    assert.match(serverSource, /document\.querySelectorAll\("\.rite-choice-row"\)\.forEach\(\(row\) => row\.remove\(\)\)/);
    assert.match(serverSource, /case "thesis":[\s\S]*openThesisForm\(\)/);
    assert.match(serverSource, /case "plan":[\s\S]*openRiteForm\(true\)/);
    assert.match(serverSource, /\$\("btn-rite"\)\.onclick = startNewRiteChatFlow/);
    assert.match(serverSource, /\$\("btn-regular-rite"\)\.onclick = startNewRiteChatFlow/);
  });

  it("keeps sidebar titles compact with hover tips and brighter settings icons", () => {
    assert.match(serverSource, /title="Bounty issue #72 chat"/);
    assert.match(serverSource, /title="\$\{esc\(record\.task \|\| record\.runId\)\}"/);
    assert.match(serverSource, /\.sidebar-item \{[\s\S]*white-space: nowrap;[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;/);
    assert.match(serverSource, /\.sidebar-item strong,[\s\S]*\.sidebar-item span \{[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
    assert.match(serverSource, /\.settings-icon \{[\s\S]*filter: brightness\(0\) saturate\(100%\) invert/);
    assert.match(serverSource, /\.settings-trigger:hover \.settings-icon/);
  });

  it("renders sidebar rite status as tight colored glyphs without row boxes", () => {
    assert.match(serverSource, /function sidebarStatusGlyph\(status: string\): string/);
    assert.match(serverSource, /case "done":[\s\S]*✔︎/);
    assert.match(serverSource, /case "error":[\s\S]*∅/);
    assert.match(serverSource, /case "failed":[\s\S]*∅/);
    assert.match(serverSource, /return `<span class="sidebar-status sidebar-status-running"/);
    assert.match(serverSource, /⏲/);
    assert.match(serverSource, /sidebarStatusGlyph\(status\)/);
    assert.match(serverSource, /\.sidebar-item \{[\s\S]*border: 0;[\s\S]*border-radius: 0;[\s\S]*background: transparent;/);
    assert.match(serverSource, /\.sidebar-item:hover \{[\s\S]*background: transparent;[\s\S]*border-color: transparent;/);
    assert.match(serverSource, /\.sidebar-item\.active \{[\s\S]*background: transparent;[\s\S]*border-color: transparent;/);
    assert.match(serverSource, /\.sidebar-status-done \{[\s\S]*color: #6dffb3;/);
    assert.match(serverSource, /\.sidebar-status-failed \{[\s\S]*color: #ff5d73;/);
    assert.match(serverSource, /\.sidebar-status-running \{[\s\S]*color: #ffb347;/);
    assert.doesNotMatch(serverSource, /<span>done<\/span>/);
  });
});
