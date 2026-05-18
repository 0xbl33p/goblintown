import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");
const cliSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");

describe("thesis workflow UI and CLI", () => {
  it("exposes a Tank thesis panel and API route", () => {
    assert.match(serverSource, /id="btn-thesis"/);
    assert.match(serverSource, /id="thesis-overlay"/);
    assert.match(serverSource, /id="thesis-subject"/);
    assert.match(serverSource, /id="thesis-solana"/);
    assert.match(serverSource, /\/api\/thesis/);
  });

  it("lets Tank thesis runs pass repository scan globs", () => {
    assert.match(serverSource, /id="thesis-globs"/);
    assert.match(serverSource, /name="scanGlobs"/);
    assert.match(serverSource, /scanGlobs:\s*thesisScanGlobs/);
    assert.match(serverSource, /body\.scanGlobs/);
  });

  it("keeps the thesis scan parser valid inside the inline Tank script", () => {
    assert.match(serverSource, /split\(\/\\\\r\?\\\\n\/\)/);
    assert.doesNotMatch(serverSource, /split\(\/\\r\?\\n\/\)/);
  });

  it("documents the thesis CLI command", () => {
    assert.match(cliSource, /goblintown thesis "<subject>"/);
    assert.match(cliSource, /async function cmdThesis/);
    assert.match(cliSource, /--solana <address>/);
  });

  it("documents thesis repo scanning in the CLI", () => {
    assert.match(cliSource, /--scan <glob>/);
    assert.match(cliSource, /collectFlag\(args, "scan"\)/);
  });
});
