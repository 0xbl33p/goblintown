import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { serve, type ServeHandle } from "../server.js";
import { initWarren } from "../warren.js";

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
  it("renders the chat-first Tank as the first usable app surface", async () => {
    const url = await startApp();
    const response = await fetch(url);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<div class="tank chat-mode" id="tank">/);
    assert.match(html, /<form class="chat-composer" id="root-chat-form">/);
    assert.match(html, /Ask anything\. One goblin answers fast\./);
    assert.match(html, /id="root-chat-send"[^>]*title="Send \(Enter\)"/);
    assert.match(html, /id="root-chat-speak"[^>]*aria-pressed="false">Speak<\/button>/);
    assert.match(html, /id="btn-sidebar-settings"[^>]*>Settings<\/button>/);
    assert.match(html, /id="btn-regular-rite"[^>]*>Regular<\/button>/);
    assert.doesNotMatch(html, /id="ops-line"/);
    assert.doesNotMatch(html, /Cmd\/Ctrl\+Enter/);
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
