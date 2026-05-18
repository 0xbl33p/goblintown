import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");
const cliSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");

describe("sentiment UI and CLI", () => {
  it("exposes local sentiment endpoints and a Settings panel", () => {
    assert.match(serverSource, /\/api\/sentiment\/sources/);
    assert.match(serverSource, /\/api\/sentiment\/market/);
    assert.match(serverSource, /\/api\/sentiment\/project/);
    assert.match(serverSource, /id="sentiment-chip"/);
    assert.match(serverSource, /id="sentiment-popover"/);
    assert.match(serverSource, /id="sentiment-secret"/);
  });

  it("documents the sentiment CLI commands and local secret flow", () => {
    assert.match(cliSource, /goblintown sentiment sources/);
    assert.match(cliSource, /goblintown sentiment key set <source> --value <secret>/);
    assert.match(cliSource, /async function cmdSentiment/);
    assert.match(cliSource, /COINGECKO_API_KEY/);
    assert.match(cliSource, /NEYNAR_API_KEY/);
  });
});
