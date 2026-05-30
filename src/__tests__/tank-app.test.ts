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

  it("renders the tank-only shell with settings access in autopilot mode", async () => {
    const url = await startApp();
    const html = await (await fetch(url)).text();

    assert.equal((await fetch(url)).status, 200);
    // Tank diorama is the default (no chat-mode, no sidecar-mode)
    assert.match(html, /<div class="tank" id="tank">/);
    assert.doesNotMatch(html, /id="sidecar-surface"/);
    assert.doesNotMatch(html, /id="root-chat-form"/);
    // Settings popover and sidebar still accessible
    assert.match(html, /<div class="workarea goblin-shell" id="workarea">/);
    assert.match(html, /<aside class="ops-sidebar goblin-sidebar" id="ops-sidebar">/);
    assert.match(html, /id="settings-popover"/);
    assert.match(html, /id="auth-chip"/);
    assert.match(html, /id="provider-chip"/);
    // Tank graphics are present
    assert.match(html, /id="dag-panel"/);
    assert.match(html, /id="result-panel"/);
    assert.match(html, /id="bubble-layer"/);
    // Rite surface still accessible
    assert.match(html, /id="root-rite-surface"/);
  });

  it("renders the sidecar-and-rites shell when chat mode is requested", async () => {
    const url = await startApp();
    if (handle) await handle.close();
    handle = await serve({ cwd: warrenRoot!, port: 0, autopilot: false });
    const html = await (await fetch(handle.url)).text();

    assert.equal((await fetch(handle.url)).status, 200);
    assert.match(html, /<section class="sidebar-list" data-sidebar-section="rites" aria-label="Rites">[\s\S]*data-sidebar-toggle="rites"[\s\S]*Bounty issue #72[\s\S]*Provider setup audit[\s\S]*Tank UI simplification[\s\S]*<\/section>/);
    assert.match(html, /data-surface-kind="rite" data-run-id="sample-bounty-72"/);
    assert.match(html, /id="sidecar-surface"[\s\S]*Codex sidecar[\s\S]*id="sidecar-new-rite"[\s\S]*id="sidecar-new-plan"[\s\S]*id="sidecar-imports"/);
    assert.match(html, /id="root-rite-surface"/);
    assert.match(html, /id="root-rite-discussion"/);
    assert.match(html, /id="sidebar-settings-card"[\s\S]*Goblin Country[\s\S]*Moss Ledger[\s\S]*Code: MOSS7 · Signed in[\s\S]*Never trust a clean cache/);
    assert.match(html, /id="settings-icon-closed"[^>]*src="\/assets\/settingsclosed\.svg"/);
    assert.match(html, /id="settings-icon-open"[^>]*src="\/assets\/settingsopen\.svg"/);
    assert.doesNotMatch(html, /settings-card::after/);
    assert.match(html, /<div class="tank chat-mode codex-chat-surface sidecar-mode" id="tank">/);
    assert.match(html, /<form class="chat-composer sidecar-hidden" id="root-chat-form" aria-hidden="true">/);
    assert.match(html, /id="root-chat-personality-label"[\s\S]*goblin_mode/);
    assert.match(html, /id="root-chat-voice"[\s\S]*textgoblinchat\.svg/);
    assert.match(html, /class="voice-menu"[\s\S]*textgoblinchat\.svg[\s\S]*Text[\s\S]*fullgoblinchat\.svg[\s\S]*Chat Live[\s\S]*sttgoblinchat\.svg[\s\S]*Speak Only[\s\S]*ttsonlygoblinchat\.svg[\s\S]*Listen Only/);
    assert.match(html, /id="root-chat-send"[^>]*title="Send \(Enter\)"[\s\S]*↑/);
    assert.match(html, /id="root-chat-speak"[^>]*class="sr-only"/);
    assert.doesNotMatch(html, /id="btn-chat"/);
    assert.doesNotMatch(html, /data-sidebar-section="chats"/);
    assert.doesNotMatch(html, /Bounty issue #72 chat/);
    assert.doesNotMatch(html, /Message the single Goblin/);
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

  it("persists onboarding dismissal on the server so it does not return every launch", async () => {
    const url = await startApp();
    const initial = await fetch(new URL("/api/onboarding", url));
    const initialBody = await initial.json();

    assert.equal(initial.status, 200);
    assert.equal(initialBody.done, false);

    const saved = await fetch(new URL("/api/onboarding", url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
    const savedBody = await saved.json();
    const after = await fetch(new URL("/api/onboarding", url));
    const afterBody = await after.json();
    const html = await (await fetch(url)).text();

    assert.equal(saved.status, 200);
    assert.equal(savedBody.done, true);
    assert.equal(afterBody.done, true);
    assert.match(html, /fetch\("\/api\/onboarding"/);
    assert.match(html, /saveOnboardingDone\(\)/);
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
