import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { serve, type ServeHandle } from "../server.js";
import { initWarren } from "../warren.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let handle: ServeHandle | undefined;
let warrenRoot: string | undefined;

async function startApp(): Promise<string> {
  warrenRoot = await mkdtemp(join(tmpdir(), "goblintown-app-test-"));
  await initWarren(warrenRoot);
  handle = await serve({ cwd: warrenRoot, port: 0 });
  return handle.url;
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = undefined;
  if (warrenRoot) await rm(warrenRoot, { recursive: true, force: true });
  warrenRoot = undefined;
});

describe("Tank app smoke", () => {
  it("bundles the approved shell state icons", () => {
    for (const asset of [
      "fullgoblinchat.svg",
      "sttgoblinchat.svg",
      "textgoblinchat.svg",
      "ttsonlygoblinchat.svg",
      "settingsclosed.svg",
      "settingsopen.svg",
    ]) {
      assert.equal(existsSync(join(repoRoot, "site/assets", asset)), true, `${asset} should be bundled`);
    }
  });

  it("renders the simplified chat-and-rites shell as the first usable app surface", async () => {
    const url = await startApp();
    const response = await fetch(url);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<div class="workarea goblin-shell" id="workarea">/);
    assert.match(html, /<aside class="ops-sidebar goblin-sidebar" id="ops-sidebar">/);
    assert.match(html, /<section class="sidebar-list" data-sidebar-section="chats" aria-label="Chats">[\s\S]*data-sidebar-toggle="chats"[\s\S]*Bounty issue #72 chat[\s\S]*Solana wallet question[\s\S]*README cleanup chat[\s\S]*<\/section>/);
    assert.match(html, /<section class="sidebar-list" data-sidebar-section="rites" aria-label="Rites">[\s\S]*data-sidebar-toggle="rites"[\s\S]*Bounty issue #72[\s\S]*Provider setup audit[\s\S]*Tank UI simplification[\s\S]*<\/section>/);
    assert.match(html, /data-surface-kind="chat" data-chat-id="bounty-72-chat"/);
    assert.match(html, /data-surface-kind="rite" data-run-id="sample-bounty-72"/);
    assert.match(html, /id="root-rite-surface"/);
    assert.match(html, /id="root-rite-discussion"/);
    assert.match(html, /id="sidebar-settings-card"[\s\S]*Goblin Country[\s\S]*Moss Ledger[\s\S]*Code: MOSS7 · Signed in[\s\S]*Never trust a clean cache/);
    assert.match(html, /id="settings-icon-closed"[^>]*src="\/assets\/settingsclosed\.svg"/);
    assert.match(html, /id="settings-icon-open"[^>]*src="\/assets\/settingsopen\.svg"/);
    assert.doesNotMatch(html, /settings-card::after/);
    assert.match(html, /<div class="tank chat-mode codex-chat-surface" id="tank">/);
    assert.match(html, /<form class="chat-composer" id="root-chat-form">/);
    assert.match(html, /id="root-chat-personality-label"[\s\S]*goblin_mode/);
    assert.match(html, /id="root-chat-voice"[\s\S]*textgoblinchat\.svg/);
    assert.match(html, /class="voice-menu"[\s\S]*textgoblinchat\.svg[\s\S]*Text[\s\S]*fullgoblinchat\.svg[\s\S]*Chat Live[\s\S]*sttgoblinchat\.svg[\s\S]*Speak Only[\s\S]*ttsonlygoblinchat\.svg[\s\S]*Listen Only/);
    assert.match(html, /id="root-chat-send"[^>]*title="Send \(Enter\)"[\s\S]*↑/);
    assert.match(html, /id="root-chat-speak"[^>]*class="sr-only"/);
    assert.doesNotMatch(html, />Speak<\/button>/);
    assert.doesNotMatch(html, /<button[^>]*id="root-chat-voice"[^>]*>Voice<\/button>/);
    assert.doesNotMatch(html, /Max tokens/);
    assert.doesNotMatch(html, /Live Tank/);
    assert.doesNotMatch(html, /id="ops-line"/);
    assert.doesNotMatch(html, /Cmd\/Ctrl\+Enter/);
  });

  it("ships parseable root app JavaScript so controls can attach", async () => {
    const url = await startApp();
    const response = await fetch(url);
    const html = await response.text();
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const rootScript = scripts.at(-1)?.[1] ?? "";

    assert.ok(rootScript.length > 1000);
    assert.doesNotThrow(() => new Script(rootScript, { filename: "goblintown-root.js" }));
  });

  it("returns useful app API errors instead of a broken chat state", async () => {
    const url = await startApp();
    const response = await fetch(new URL("/api/chat", url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "assistant", content: "ready" }] }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "messages must end with a user message" });
  });

  it("serves default voice config without coupling it to text provider config", async () => {
    const url = await startApp();
    const response = await fetch(new URL("/api/voice", url));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.config.provider, "browser");
    assert.equal(body.config.language, "en-US");
    assert.match(body.config.prompt, /Goblintown chat/);
    assert.equal(body.runtime.needsServer, false);
    assert.equal(body.runtime.hasApiKey, true);
  });

  it("rejects server transcription when browser-only voice is active", async () => {
    const url = await startApp();
    const response = await fetch(new URL("/api/voice/transcribe", url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioBase64: Buffer.from("fake audio").toString("base64"),
        mimeType: "audio/webm",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "browser voice runs locally in the browser" });
  });

  it("normalizes hostile voice config posts instead of storing unsafe connector values", async () => {
    const url = await startApp();
    const response = await fetch(new URL("/api/voice", url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "../../deepgram",
        baseURL: "   ",
        apiKeyEnv: "bad env",
        language: "",
        prompt: "",
        apiKey: "should-not-be-used-for-browser",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.config.provider, "browser");
    assert.equal(body.config.baseURL, undefined);
    assert.equal(body.config.apiKeyEnv, undefined);
    assert.equal(body.config.language, "en-US");
    assert.equal(body.runtime.needsServer, false);
  });
});
