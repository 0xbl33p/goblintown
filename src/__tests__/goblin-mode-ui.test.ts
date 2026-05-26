import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");
const cliSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
const desktopSource = readFileSync(join(repoRoot, "src", "desktop.ts"), "utf8");
const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");
const macInfoPlist = readFileSync(join(repoRoot, "build", "Info.plist"), "utf8");
const macEntitlements = readFileSync(join(repoRoot, "build", "entitlements.mac.plist"), "utf8");
const macInheritEntitlements = readFileSync(join(repoRoot, "build", "entitlements.mac.inherit.plist"), "utf8");

describe("AI-first Tank shell", () => {
  it("serves the full Tank shell from the default route", () => {
    assert.match(serverSource, /app\.get\("\/", async \(_req, res\) => renderHome/);
    assert.match(serverSource, /app\.get\("\/tank"/);
    assert.match(serverSource, /function tankHtml/);
    assert.match(serverSource, /<div class="tank chat-mode codex-chat-surface" id="tank">/);
    assert.doesNotMatch(serverSource, /app\.get\("\/", async \(_req, res\) => renderGoblinMode/);
  });

  it("keeps compact mini Tank controls out of the default shell", () => {
    assert.doesNotMatch(serverSource, /id="tank-box"/);
    assert.doesNotMatch(serverSource, /id="tank-enabled"/);
    assert.doesNotMatch(serverSource, /compact live Tank/i);
    assert.doesNotMatch(serverSource, /one chat goblin mode/i);
  });

  it("provides single-goblin and town run endpoints for the shell", () => {
    assert.match(serverSource, /app\.post\("\/api\/goblin\/single"/);
    assert.match(serverSource, /\/api\/goblin\/single/);
    assert.match(serverSource, /\/api\/plan/);
  });

  it("keeps local context ingestion and search APIs available", () => {
    assert.match(serverSource, /app\.post\("\/api\/context\/ingest"/);
    assert.match(serverSource, /app\.post\("\/api\/context\/search"/);
    assert.match(serverSource, /app\.post\("\/api\/context\/chats\/scan"/);
    assert.match(serverSource, /app\.post\("\/api\/context\/chats\/import"/);
    assert.match(serverSource, /app\.post\("\/api\/context\/vectorize"/);
  });

  it("lets the CLI accept slash commands", () => {
    assert.match(cliSource, /parseGoblinCommand/);
    assert.match(cliSource, /cmdSlash/);
    assert.match(cliSource, /cmd\.startsWith\("\/"\)/);
    assert.match(cliSource, /cmdContext/);
    assert.match(cliSource, /cmdContextScanChats/);
    assert.match(cliSource, /cmdContextImportChats/);
    assert.match(cliSource, /cmdContextVectorize/);
  });

  it("adds desktop application scripts and Electron metadata", () => {
    assert.match(packageJson, /"desktop"/);
    assert.match(packageJson, /"package:mac"/);
    assert.match(packageJson, /"dist:mac"/);
    assert.match(packageJson, /"dist:win"/);
    assert.match(packageJson, /"dist:linux"/);
    assert.match(packageJson, /"dist:desktop"/);
    assert.match(packageJson, /"electron"/);
    assert.match(packageJson, /"electron-builder"/);
    assert.match(packageJson, /"@electron\/packager"/);
    assert.match(packageJson, /"AppImage"/);
    assert.match(packageJson, /"nsis"/);
  });

  it("packages Electron with microphone permission support", () => {
    assert.match(desktopSource, /systemPreferences\.askForMediaAccess\("microphone"\)/);
    assert.match(desktopSource, /setPermissionCheckHandler/);
    assert.match(desktopSource, /setPermissionRequestHandler/);
    assert.match(desktopSource, /permission !== "media"/);
    assert.match(desktopSource, /mediaTypes[\s\S]*includes\("audio"\)/);
    assert.match(packageJson, /"extendInfo": \{[\s\S]*"NSMicrophoneUsageDescription"/);
    assert.match(packageJson, /--extend-info=build\/Info\.plist/);
    assert.match(macInfoPlist, /<key>NSMicrophoneUsageDescription<\/key>/);
    assert.match(macEntitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>/);
    assert.match(macInheritEntitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>/);
  });
});
