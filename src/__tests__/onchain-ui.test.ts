import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");
const cliSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");

describe("Solana onchain workflow", () => {
  it("exposes a Tank panel for address lookup and Goblintown analysis", () => {
    assert.match(serverSource, /id="onchain-chip"/);
    assert.match(serverSource, /id="onchain-address"/);
    assert.match(serverSource, /id="onchain-lookup"/);
    assert.match(serverSource, /id="onchain-analyze"/);
    assert.match(serverSource, /id="onchain-signature"/);
    assert.match(serverSource, /id="onchain-transaction"/);
    assert.match(serverSource, /\/api\/onchain\/solana\/lookup/);
    assert.match(serverSource, /\/api\/onchain\/solana\/transaction/);
    assert.match(serverSource, /function buildOnchainAnalysisTask/);
  });

  it("documents the explicit Solana lookup CLI path", () => {
    assert.match(cliSource, /goblintown addon solana <address>/);
    assert.match(cliSource, /async function cmdAddonSolana/);
  });
});
