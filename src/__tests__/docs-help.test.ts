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
    assert.match(readme, /231 tests/);
  });

  it("updates the marketing site copy for the Tank and cloud mode", () => {
    assert.match(siteIndex, /first-run Local Only \/ Goblintown Cloud choice/);
    assert.match(siteIndex, /Settings menu/);
    assert.match(siteIndex, /Asteroid Mode/);
    assert.match(siteIndex, /231 tests/);
  });
});
