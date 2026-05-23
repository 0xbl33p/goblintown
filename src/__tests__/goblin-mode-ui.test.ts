import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");
const cliSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");

describe("Goblin Mode shell", () => {
  it("makes Goblin Mode the default route and keeps the legacy Tank route available", () => {
    assert.match(serverSource, /app\.get\("\/", async \(_req, res\) => renderGoblinMode/);
    assert.match(serverSource, /app\.get\("\/tank"/);
    assert.match(serverSource, /function goblinModeHtml/);
  });

  it("exposes Single Goblin, Goblintown, and Tank controls", () => {
    assert.match(serverSource, /id="mode-single"/);
    assert.match(serverSource, /id="mode-town"/);
    assert.match(serverSource, /id="tank-enabled"/);
    assert.match(serverSource, /one chat goblin mode/i);
    assert.match(serverSource, /goblin-mode-shell/);
  });

  it("provides single-goblin and town run endpoints for the shell", () => {
    assert.match(serverSource, /app\.post\("\/api\/goblin\/single"/);
    assert.match(serverSource, /\/api\/goblin\/single/);
    assert.match(serverSource, /\/api\/plan/);
  });

  it("exposes local context ingestion and search in Goblin Mode", () => {
    assert.match(serverSource, /app\.post\("\/api\/context\/ingest"/);
    assert.match(serverSource, /app\.post\("\/api\/context\/search"/);
    assert.match(serverSource, /app\.post\("\/api\/context\/chats\/scan"/);
    assert.match(serverSource, /app\.post\("\/api\/context\/chats\/import"/);
    assert.match(serverSource, /app\.post\("\/api\/context\/vectorize"/);
    assert.match(serverSource, /\/context ingest/);
    assert.match(serverSource, /\/context search/);
    assert.match(serverSource, /chat-import-panel/);
    assert.match(serverSource, /Import All/);
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
    assert.match(packageJson, /"electron"/);
    assert.match(packageJson, /"@electron\/packager"/);
  });
});
