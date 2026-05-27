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
const desktopReleaseWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "desktop-release.yml"), "utf8");
const beta07ReleaseNote = readFileSync(join(repoRoot, "docs", "releases", "0.7.0-beta.1.md"), "utf8");
const assetReadme = readFileSync(join(repoRoot, "site", "assets", "README.md"), "utf8");
const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");

describe("docs and CLI help", () => {
  it("documents every command in cli-help and wires it into the CLI", () => {
    // Help text lives once, in cli-help.ts (buildCliHelp), and cli.ts consumes it.
    assert.match(cliSource, /import \{ buildCliHelp \} from "\.\/cli-help\.js"/);
    assert.match(cliSource, /const HELP = buildCliHelp\(CREATURE_KINDS\)/);

    assert.match(cliHelpSource, /goblintown cloud/);
    assert.match(cliHelpSource, /first-run Local Only vs Goblintown Cloud choice/);
    assert.match(cliHelpSource, /FIREBASE_API_KEY\s+optional override/);
    assert.match(cliHelpSource, /Asteroid Mode/);
    assert.match(cliHelpSource, /goblintown addon enable solana/);
    assert.match(cliHelpSource, /goblintown addon solana <address>/);
    assert.match(cliHelpSource, /goblintown addon solana tx <signature>/);
    assert.match(cliHelpSource, /goblintown thesis "<subject>"/);
    assert.match(cliHelpSource, /--scan <glob>/);
    assert.match(cliHelpSource, /project-quality thesis memo/);
    assert.match(cliHelpSource, /not a buy\/sell recommendation/);
    assert.match(cliHelpSource, /GOBLINTOWN_TOOLS_SOLANA/);
    assert.match(cliHelpSource, /goblintown sentiment sources/);
    assert.match(cliHelpSource, /COINGECKO_API_KEY/);
    assert.match(cliHelpSource, /NEYNAR_API_KEY/);
    assert.match(cliHelpSource, /goblintown context ingest <path>/);
    assert.match(cliHelpSource, /goblintown context search "<query>"/);
    assert.match(cliHelpSource, /goblintown context scan chats/);
    assert.match(cliHelpSource, /goblintown context import chats/);
    assert.match(cliHelpSource, /goblintown context vectorize/);
    assert.match(cliHelpSource, /file-backed Artifacts/);

    // cli.ts still dispatches and implements the cloud command.
    assert.match(cliSource, /case "cloud":/);
    assert.match(cliSource, /async function cmdCloud/);
    assert.match(cliSource, /goblintown-88fd6/);
    assert.match(cliSource, /Use Goblintown Cloud/);
  });

  it("README leads with the desktop app, real download links, and no HTTP endpoints", () => {
    assert.match(readme, /<img src="site\/assets\/gtownlogo\.svg"/);
    assert.match(readme, /## Download/);
    // Per-platform installer links point at the canonical GitHub Release assets.
    assert.match(readme, /releases\/download\/v0\.7\.0-beta\.1\/Goblintown-0\.7\.0-beta\.1-mac-arm64\.dmg/);
    assert.match(readme, /Goblintown-0\.7\.0-beta\.1-win-x64\.exe/);
    assert.match(readme, /Goblintown-0\.7\.0-beta\.1-linux-arm64\.AppImage/);
    assert.match(readme, /npm install -g goblintown/);
    assert.match(readme, /goblintown serve/);
    // GUI-first framing.
    assert.match(readme, /## Using Goblintown/);
    assert.match(readme, /Single Goblin/);
    assert.match(readme, /\*\*Goblintown\*\* turns the prompt into a planner/);
    assert.match(readme, /run `goblintown --help`/);
    // Providers, cloud, build, tests, research, citing.
    assert.match(readme, /OPENROUTER_API_KEY/);
    assert.match(readme, /ANTHROPIC_API_KEY/);
    assert.match(readme, /## Goblintown Cloud/);
    assert.match(readme, /Stay Local/);
    assert.match(readme, /Use Goblintown Cloud/);
    assert.match(readme, /FIREBASE_/);
    assert.match(readme, /## Building from source/);
    assert.match(readme, /npm run dist:mac/);
    assert.match(readme, /\.github\/workflows\/desktop-release\.yml/);
    assert.match(readme, /npm test/);
    assert.match(readme, /## Research foundations/);
    assert.match(readme, /## Citing/);
    assert.match(readme, /0xbl33p\/goblintown/);

    // Deliberately removed: HTTP API table, app endpoints, CLI command dump,
    // the old owner handle, and the split-parts download ritual.
    assert.doesNotMatch(readme, /## HTTP API/);
    assert.doesNotMatch(readme, /\/api\/onchain/);
    assert.doesNotMatch(readme, /water-bear86/);
    assert.doesNotMatch(readme, /release\/parts/);
    assert.doesNotMatch(readme, /goblintown summon/);
    assert.doesNotMatch(readme, /goblintown scavenge/);
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

  it("documents the beta 0.7 release on the canonical repo", () => {
    assert.match(beta07ReleaseNote, /0xbl33p\/goblintown/);
    assert.match(beta07ReleaseNote, /releases\/tag\/v0\.7\.0-beta\.1/);
    assert.match(beta07ReleaseNote, /Gatekeeper friction/);
    assert.match(beta07ReleaseNote, /SmartScreen warnings/);
    assert.match(beta07ReleaseNote, /Goblintown-0\.7\.0-beta\.1-mac-arm64\.dmg/);
    assert.match(beta07ReleaseNote, /shasum -a 256 -c/);
    assert.doesNotMatch(beta07ReleaseNote, /water-bear86/);
  });

  it("documents the mayor app icon as the distribution icon source", () => {
    assert.match(assetReadme, /mayor-icon\.png/);
    assert.match(assetReadme, /distribution icon source used to generate `build\/icon\.png`, `build\/icon\.icns`, and `build\/icon\.ico`/);
    assert.match(packageJson, /"build\/icon\.png"/);
    assert.match(packageJson, /"build\/icon\.icns"/);
    assert.match(packageJson, /"build\/icon\.ico"/);
    assert.doesNotMatch(packageJson, /"build\/icon\.svg"/);
  });

  it("normalizes the repository owner to 0xbl33p", () => {
    assert.match(packageJson, /github\.com\/0xbl33p\/goblintown/);
    assert.doesNotMatch(packageJson, /github\.com\/0XBL33P\/goblintown/);
  });

  it("marketing site offers real installer downloads and the GUI story", () => {
    assert.match(siteIndex, /assets\/mayor-icon\.png/);
    assert.match(siteIndex, /releases\/download\/v0\.7\.0-beta\.1\/Goblintown-0\.7\.0-beta\.1-mac-arm64\.dmg/);
    assert.match(siteIndex, /Goblintown-0\.7\.0-beta\.1-win-x64\.exe/);
    assert.match(siteIndex, /npm install -g goblintown/);
    assert.match(siteIndex, /Single Goblin \/ Goblintown/);
    assert.match(siteIndex, /goblintown --help/);
    assert.match(siteIndex, /Solana add-on/);
    assert.match(siteIndex, /Thesis engine/);
    assert.match(siteIndex, /Sentiment sources/);

    // The split-parts download ritual and the old CLI command dump are gone.
    assert.doesNotMatch(siteIndex, /water-bear86/);
    assert.doesNotMatch(siteIndex, /release\/parts/);
    assert.doesNotMatch(siteIndex, /\.part-\*/);
    assert.doesNotMatch(siteIndex, /goblintown scavenge/);
    assert.doesNotMatch(siteIndex, /goblintown summon/);
  });
});
