import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
const cliHelpSource = readFileSync(join(repoRoot, "src", "cli-help.ts"), "utf8");
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const docsIndex = readFileSync(join(repoRoot, "docs", "README.md"), "utf8");
const beta07Install = readFileSync(join(repoRoot, "docs", "install", "beta-0.7.md"), "utf8");
const pipelineDoc = readFileSync(join(repoRoot, "docs", "architecture", "pipeline.md"), "utf8");
const singleGoblinDoc = readFileSync(join(repoRoot, "docs", "modes", "single-goblin.md"), "utf8");
const goblintownModeDoc = readFileSync(join(repoRoot, "docs", "modes", "goblintown-mode.md"), "utf8");
const extensionsOverview = readFileSync(join(repoRoot, "docs", "extensions", "overview.md"), "utf8");
const skillsDoc = readFileSync(join(repoRoot, "docs", "extensions", "skills.md"), "utf8");
const cloudCountryDoc = readFileSync(join(repoRoot, "docs", "features", "cloud-country.md"), "utf8");
const researchToolsDoc = readFileSync(join(repoRoot, "docs", "features", "research-tools.md"), "utf8");
const cliReference = readFileSync(join(repoRoot, "docs", "reference", "cli.md"), "utf8");
const httpApiReference = readFileSync(join(repoRoot, "docs", "reference", "http-api.md"), "utf8");
const storageLayout = readFileSync(join(repoRoot, "docs", "reference", "storage-layout.md"), "utf8");
const siteIndex = readFileSync(join(repoRoot, "site", "index.html"), "utf8");
const desktopReleaseWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "desktop-release.yml"), "utf8");
const beta07ReleaseNote = readFileSync(join(repoRoot, "docs", "releases", "0.7.0-beta.1.md"), "utf8");
const assetReadme = readFileSync(join(repoRoot, "site", "assets", "README.md"), "utf8");
const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");

function assertIncludesAll(source: string, patterns: RegExp[]): void {
  for (const pattern of patterns) {
    assert.match(source, pattern);
  }
}

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
      assert.match(source, /goblintown context ingest <path>/);
      assert.match(source, /goblintown context search "<query>"/);
      assert.match(source, /goblintown context scan chats/);
      assert.match(source, /goblintown context import chats/);
      assert.match(source, /goblintown context vectorize/);
      assert.match(source, /file-backed Artifacts/);
    }
    assert.match(cliSource, /case "cloud":\s+return cmdCloud/);
    assert.match(cliSource, /async function cmdCloud/);
    assert.match(cliSource, /goblintown-88fd6/);
    assert.match(cliSource, /Use Goblintown Cloud/);
  });

  it("keeps README as the front page and moves detailed product docs into docs/", () => {
    assertIncludesAll(readme, [
      /<img src="site\/assets\/gtownlogo\.svg"/,
      /docs\/assets\/screenshots\/goblintown-chat\.jpg/,
      /docs\/assets\/screenshots\/goblintown-settings\.jpg/,
      /docs\/assets\/screenshots\/goblintown-rites\.jpg/,
      /## Download/,
      /Goblintown-0\.7\.0-beta\.1-mac-arm64\.dmg/,
      /Goblintown-0\.7\.0-beta\.1-win-x64\.exe/,
      /release\/parts/,
      /docs\/install\/beta-0\.7\.md/,
      /docs\/architecture\/pipeline\.md/,
      /docs\/extensions\/skills\.md/,
      /docs\/reference\/http-api\.md/,
      /docs\/reference\/cli\.md/,
      /Single Goblin mode/,
      /Goblintown mode/,
      /not a buy\/sell recommendation/,
    ]);

    assertIncludesAll(docsIndex, [
      /Goblintown Docs/,
      /install\/beta-0\.7\.md/,
      /architecture\/pipeline\.md/,
      /modes\/single-goblin\.md/,
      /modes\/goblintown-mode\.md/,
      /extensions\/overview\.md/,
      /reference\/http-api\.md/,
      /assets\/screenshots/,
    ]);

    assertIncludesAll(beta07Install, [
      /release\/parts/,
      /shasum -a 256 -c release\/parts\/SHA256SUMS\.txt/,
      /npm run release:ready/,
      /Gatekeeper/,
      /SmartScreen/,
      /\.github\/workflows\/desktop-release\.yml/,
      /MAC_CSC_LINK/,
      /WIN_CSC_LINK/,
    ]);

    assertIncludesAll(pipelineDoc, [
      /Raccoon/,
      /Goblin pack/,
      /Gremlin/,
      /Troll/,
      /Specialists/,
      /Ogre/,
      /Pigeon-Scribe/,
      /src\/rite\.ts/,
      /src\/plan-executor\.ts/,
    ]);

    assertIncludesAll(singleGoblinDoc, [
      /\/api\/goblin\/single/,
      /goblintown \/ask/,
      /one worker/,
      /configured Goblin model slot/,
    ]);

    assertIncludesAll(goblintownModeDoc, [
      /goblintown rite/,
      /goblintown plan/,
      /Planner/,
      /\.goblintown\/runs/,
    ]);

    assertIncludesAll(cloudCountryDoc, [
      /Stay Local/,
      /Use Goblintown Cloud/,
      /Settings -> Account/,
      /Settings -> Reset -> Asteroid Mode/,
      /FIREBASE_API_KEY/,
      /goblintown-88fd6/,
      /country peer add/,
    ]);

    assertIncludesAll(researchToolsDoc, [
      /goblintown thesis/,
      /--scan "README\.md"/,
      /Unknown \/ Unverified/,
      /not a buy\/sell recommendation/,
      /quality and advantages/,
      /Tank `SENTIMENT`/,
      /Settings -> Sentiment Sources/,
      /COINGECKO_API_KEY/,
      /NEYNAR_API_KEY/,
      /\.goblintown\/secrets\.json/,
      /solana\.profile/,
      /solana\.transaction/,
      /solana\.balance/,
      /GOBLINTOWN_TOOLS_SOLANA/,
    ]);

    assertIncludesAll(extensionsOverview, [
      /Add-ons/,
      /Solana/,
      /Reward Plugins/,
      /Provider Routes/,
      /src\/addons\.ts/,
      /src\/tools\.ts/,
    ]);

    assertIncludesAll(skillsDoc, [
      /\.agents\/skills\/add-provider-package\/SKILL\.md/,
      /npx skills add/,
      /docs explain Goblintown to users/,
    ]);

    assertIncludesAll(storageLayout, [
      /\.goblintown\//,
      /hoard\/loot/,
      /hoard\/artifacts/,
      /runs\/<runId>\.json/,
    ]);

    assertIncludesAll(cliReference, [
      /goblintown context ingest \.\/notes/,
      /goblintown context scan chats/,
      /goblintown context import chats --source chatgpt/,
      /goblintown sentiment sources/,
    ]);

    assertIncludesAll(httpApiReference, [
      /\/api\/goblin\/single/,
      /\/api\/context\/ingest/,
      /\/api\/onchain\/solana\/lookup/,
    ]);
  });

  it("ships a signed desktop release workflow for GitHub Release assets", () => {
    assert.match(desktopReleaseWorkflow, /name: Desktop Release/);
    assert.match(desktopReleaseWorkflow, /workflow_dispatch/);
    assert.match(desktopReleaseWorkflow, /npx electron-builder --mac dmg --arm64 --x64 --publish never/);
    assert.match(desktopReleaseWorkflow, /npx electron-builder --win nsis --x64 --arm64 --publish never/);
    assert.match(desktopReleaseWorkflow, /npx electron-builder --linux AppImage --x64 --arm64 --publish never/);
    assert.match(desktopReleaseWorkflow, /MAC_CSC_LINK/);
    assert.match(desktopReleaseWorkflow, /WIN_CSC_LINK/);
    assert.match(desktopReleaseWorkflow, /gh release upload/);
  });

  it("documents the unsigned beta 0.7 package location", () => {
    assert.match(beta07ReleaseNote, /water-bear86\/goblintown/);
    assert.match(beta07ReleaseNote, /release\/v0\.7\.0-beta\.1\/release\/parts/);
    assert.match(beta07ReleaseNote, /Gatekeeper friction/);
    assert.match(beta07ReleaseNote, /SmartScreen warnings/);
    assert.match(beta07ReleaseNote, /Goblintown-0\.7\.0-beta\.1-mac-arm64\.dmg\.part-\*/);
    assert.match(beta07ReleaseNote, /shasum -a 256 -c release\/parts\/SHA256SUMS\.txt/);
  });

  it("documents the mayor app icon as the distribution icon source", () => {
    assert.match(assetReadme, /mayor-icon\.png/);
    assert.match(assetReadme, /distribution icon source used to generate `build\/icon\.png`, `build\/icon\.icns`, and `build\/icon\.ico`/);
    assert.match(packageJson, /"build\/icon\.png"/);
    assert.match(packageJson, /"build\/icon\.icns"/);
    assert.match(packageJson, /"build\/icon\.ico"/);
    assert.doesNotMatch(packageJson, /"build\/icon\.svg"/);
  });

  it("updates the marketing site copy for the Tank and cloud mode", () => {
    assert.match(siteIndex, /local model should power Goblintown/);
    assert.match(siteIndex, /assets\/mayor-icon\.png/);
    assert.match(siteIndex, /release\/v0\.7\.0-beta\.1\/release\/parts/);
    assert.match(siteIndex, /Goblintown-0\.7\.0-beta\.1-mac-arm64\.dmg\.part-\*/);
    assert.match(siteIndex, /Goblintown-0\.7\.0-beta\.1-win-x64\.exe\.part-\*/);
    assert.match(siteIndex, /shasum -a 256 -c release\/parts\/SHA256SUMS\.txt/);
    assert.doesNotMatch(siteIndex, /npmjs\.com/);
    assert.doesNotMatch(siteIndex, /npm install -g goblintown@beta/);
    assert.match(siteIndex, /Settings menu/);
    assert.match(siteIndex, /Asteroid Mode/);
    assert.match(siteIndex, /318 tests/);
    assert.match(siteIndex, /goblintown context ingest \.\/notes/);
    assert.match(siteIndex, /goblintown context scan chats/);
    assert.match(siteIndex, /goblintown context import chats --source chatgpt/);
    assert.match(siteIndex, /pre-vectorized/);
    assert.match(siteIndex, /\/context search "desktop app tank"/);
    assert.match(siteIndex, /local context ingestion/);
    assert.match(siteIndex, /Solana add-on/);
    assert.match(siteIndex, /Thesis engine/);
    assert.match(siteIndex, /Sentiment sources/);
    assert.match(siteIndex, /Tank Sentiment tool/);
    assert.match(siteIndex, /Settings Sentiment Sources/);
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
