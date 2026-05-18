import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
const cliHelpSource = readFileSync(join(repoRoot, "src", "cli-help.ts"), "utf8");
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const siteIndex = readFileSync(join(repoRoot, "site", "index.html"), "utf8");

describe("docs and CLI help", () => {
  it("documents the Goblintown Cloud command in CLI help", () => {
    for (const source of [cliSource, cliHelpSource]) {
      assert.match(source, /goblintown cloud/);
      assert.match(source, /first-run Local Only vs Goblintown Cloud choice/);
      assert.match(source, /FIREBASE_API_KEY\s+optional override/);
      assert.match(source, /Asteroid Mode/);
      assert.match(source, /goblintown addon enable solana/);
      assert.match(source, /goblintown addon solana <address>/);
      assert.match(source, /goblintown addon solana tx <signature>/);
      assert.match(source, /goblintown thesis "<subject>"/);
      assert.match(source, /--scan <glob>/);
      assert.match(source, /project-quality thesis memo/);
      assert.match(source, /not a buy\/sell recommendation/);
      assert.match(source, /GOBLINTOWN_TOOLS_SOLANA/);
      assert.match(source, /goblintown sentiment sources/);
      assert.match(source, /goblintown sentiment key set <source> --value <secret>/);
      assert.match(source, /COINGECKO_API_KEY/);
      assert.match(source, /NEYNAR_API_KEY/);
    }
    assert.match(cliSource, /case "cloud":\s+return cmdCloud/);
    assert.match(cliSource, /async function cmdCloud/);
    assert.match(cliSource, /goblintown-88fd6/);
    assert.match(cliSource, /Use Goblintown Cloud/);
  });

  it("updates README for local-first cloud, Settings, and reset flows", () => {
    assert.match(readme, /## Goblintown Cloud/);
    assert.match(readme, /Stay Local/);
    assert.match(readme, /Use Goblintown Cloud/);
    assert.match(readme, /Settings -> Account/);
    assert.match(readme, /Settings -> Reset -> Asteroid Mode/);
    assert.match(readme, /FIREBASE_API_KEY/);
    assert.match(readme, /optional Firebase overrides/);
    assert.match(readme, /270 tests/);
    assert.match(readme, /## Add-ons/);
    assert.match(readme, /## Thesis Engine/);
    assert.match(readme, /## Sentiment Sources/);
    assert.match(readme, /--scan "README\.md"/);
    assert.match(readme, /Unknown \/ Unverified/);
    assert.match(readme, /\.goblintown\/secrets\.json/);
    assert.match(readme, /goblintown sentiment sources/);
    assert.match(readme, /COINGECKO_API_KEY/);
    assert.match(readme, /NEYNAR_API_KEY/);
    assert.match(readme, /goblintown thesis ".*" --solana <address>/);
    assert.match(readme, /quality and advantages/);
    assert.match(readme, /not a buy\/sell recommendation/);
    assert.match(readme, /solana\.profile/);
    assert.match(readme, /solana\.transaction/);
    assert.match(readme, /solana\.balance/);
    assert.match(readme, /Settings -> Onchain/);
    assert.match(readme, /\/api\/onchain\/solana\/lookup/);
  });

  it("updates the marketing site copy for the Tank and cloud mode", () => {
    assert.match(siteIndex, /first-run Local Only \/ Goblintown Cloud choice/);
    assert.match(siteIndex, /Settings menu/);
    assert.match(siteIndex, /Asteroid Mode/);
    assert.match(siteIndex, /270 tests/);
    assert.match(siteIndex, /Solana add-on/);
    assert.match(siteIndex, /Thesis engine/);
    assert.match(siteIndex, /Sentiment sources/);
    assert.match(siteIndex, /quality and advantages/);
    assert.match(siteIndex, /not buyability/);
    assert.match(siteIndex, /scan repo files/);
    assert.match(siteIndex, /Unknown \/ Unverified/);
    assert.match(siteIndex, /goblintown sentiment sources/);
    assert.match(siteIndex, /COINGECKO_API_KEY/);
    assert.match(siteIndex, /NEYNAR_API_KEY/);
    assert.match(siteIndex, /goblintown addon solana &lt;address&gt;/);
    assert.match(siteIndex, /goblintown addon solana tx &lt;signature&gt;/);
  });
});
