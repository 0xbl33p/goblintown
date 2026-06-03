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
const sitePrivacy = readFileSync(join(repoRoot, "site", "privacy.html"), "utf8");
const siteTerms = readFileSync(join(repoRoot, "site", "terms.html"), "utf8");
const desktopReleaseWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "desktop-release.yml"), "utf8");
const beta07ReleaseNote = readFileSync(join(repoRoot, "docs", "releases", "0.7.0-beta.1.md"), "utf8");
const distributionsDoc = readFileSync(join(repoRoot, "docs", "distributions.md"), "utf8");
const cliReference = readFileSync(join(repoRoot, "docs", "reference", "cli.md"), "utf8");
const chatGptAppReadme = readFileSync(join(repoRoot, "apps", "chatgpt", "README.md"), "utf8");
const chatGptAppJson = readFileSync(join(repoRoot, "apps", "chatgpt", "app.json"), "utf8");
const assetReadme = readFileSync(join(repoRoot, "site", "assets", "README.md"), "utf8");
const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");
const vercelJson = readFileSync(join(repoRoot, "vercel.json"), "utf8");
const vercelApiIndex = readFileSync(join(repoRoot, "api", "index.js"), "utf8");
const vercelSource = readFileSync(join(repoRoot, "src", "vercel.ts"), "utf8");
const chatGptSubmission = readFileSync(join(repoRoot, "chatgpt-app-submission.json"), "utf8");

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
    assert.match(cliHelpSource, /goblintown mcp/);
    assert.match(cliHelpSource, /local stdio MCP sidecar/);
    assert.match(cliHelpSource, /Codex-local global Warren/);
    assert.match(cliHelpSource, /goblintown chatgpt install/);
    assert.match(cliHelpSource, /npx -y goblintown@latest chatgpt install/);
    assert.match(cliHelpSource, /Streamable\s+HTTP MCP endpoint at \/mcp/);
    assert.match(cliHelpSource, /ChatGPT\s+Developer\s+Mode/);
    assert.match(cliHelpSource, /GOBLINTOWN_CHATGPT_ALLOWED_HOSTS/);
    assert.match(cliHelpSource, /goblintown plugin install/);
    assert.match(cliHelpSource, /composer \+ menu/);

    // cli.ts still dispatches and implements the cloud command.
    assert.match(cliSource, /case "cloud":/);
    assert.match(cliSource, /case "mcp":/);
    assert.match(cliSource, /case "chatgpt":/);
    assert.match(cliSource, /case "plugin":/);
    assert.match(cliSource, /async function cmdChatGpt/);
    assert.match(cliSource, /async function cmdPlugin/);
    assert.match(cliSource, /async function cmdCloud/);
    assert.match(cliSource, /goblintown-88fd6/);
    assert.match(cliSource, /Use Goblintown Cloud/);
  });

  it("README leads with front-end adapter positioning, real download links, and no HTTP endpoints", () => {
    assert.match(readme, /<img src="site\/assets\/gtownlogo\.svg"/);
    assert.match(readme, /agent-first, model-augmentable orchestration tool compatible\s+with most front ends/);
    assert.match(readme, /Codex is the first front-end adapter/);
    assert.match(readme, /## Download/);
    assert.match(readme, /Goblintown Codex Plugin\s+\| 1\.0/);
    assert.match(readme, /Goblintown Desktop\s+\| Beta 0\.1/);
    assert.match(readme, /Goblintown ChatGPT App\s+\| 1\.0\s+\| Dev preview/);
    assert.match(readme, /Goblintown Hermes App/);
    assert.match(readme, /ChatGPT App 1\.0/);
    assert.match(readme, /Streamable HTTP MCP endpoint at `\/mcp`/);
    assert.match(readme, /npx -y goblintown@latest chatgpt install/);
    assert.match(readme, /creates a quick\s+HTTPS tunnel/);
    assert.match(readme, /goblintown chatgpt serve/);
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

  it("documents Desktop Beta 0.1 on the canonical repo while preserving legacy asset names", () => {
    assert.match(distributionsDoc, /agent-first, model-augmentable orchestration tool compatible\s+with most front ends/);
    assert.match(distributionsDoc, /Each front-end adapter owns installation/);
    assert.match(distributionsDoc, /Goblintown Codex Plugin\s+\| 1\.0/);
    assert.match(distributionsDoc, /Goblintown Desktop\s+\| Beta 0\.1/);
    assert.match(distributionsDoc, /Goblintown ChatGPT App\s+\| 1\.0\s+\| Dev preview/);
    assert.match(distributionsDoc, /Streamable HTTP `\/mcp`/);
    assert.match(distributionsDoc, /ui:\/\/goblintown\/tank-v2\.html/);
    assert.match(distributionsDoc, /chatgpt install/);
    assert.match(distributionsDoc, /https:\/\/goblintown-mcp\.vercel\.app\/mcp/);
    assert.match(distributionsDoc, /Vercel/);
    assert.match(distributionsDoc, /without attempting to\s+open `localhost:7777`/);
    assert.match(distributionsDoc, /Goblintown Hermes App/);
    assert.match(distributionsDoc, /Goblintown Opencode App/);
    assert.match(distributionsDoc, /Goblintown OpenGPT App/);
    assert.match(distributionsDoc, /Goblintown Claude Code App/);
    assert.match(beta07ReleaseNote, /0xbl33p\/goblintown/);
    assert.match(beta07ReleaseNote, /Desktop Beta 0\.1/);
    assert.match(beta07ReleaseNote, /releases\/tag\/v0\.7\.0-beta\.1/);
    assert.match(beta07ReleaseNote, /Gatekeeper friction/);
    assert.match(beta07ReleaseNote, /SmartScreen warnings/);
    assert.match(beta07ReleaseNote, /Goblintown-0\.7\.0-beta\.1-mac-arm64\.dmg/);
    assert.match(beta07ReleaseNote, /shasum -a 256 -c/);
    assert.doesNotMatch(beta07ReleaseNote, /water-bear86/);
  });

  it("documents the ChatGPT App 1.0 dev preview package", () => {
    assert.match(chatGptAppReadme, /# Goblintown ChatGPT App 1\.0/);
    assert.match(chatGptAppReadme, /dev preview/);
    assert.match(chatGptAppReadme, /Streamable HTTP MCP endpoint/);
    assert.match(chatGptAppReadme, /`\/mcp`/);
    assert.match(chatGptAppReadme, /npx -y goblintown@latest chatgpt install/);
    assert.match(chatGptAppReadme, /quick HTTPS tunnel/);
    assert.match(chatGptAppReadme, /ui:\/\/goblintown\/tank-v2\.html/);
    assert.match(chatGptAppReadme, /ChatGPT Developer Mode/);
    assert.match(chatGptAppReadme, /npm run verify:chatgpt/);
    assert.match(chatGptAppReadme, /--connect-url/);
    assert.match(chatGptAppReadme, /npm run ensure:chatgpt/);
    assert.match(chatGptAppReadme, /## Deploy on Vercel/);
    assert.match(chatGptAppReadme, /hosted Vercel shape/);
    assert.match(chatGptAppReadme, /does not\s+advertise local Single Goblin/);
    assert.match(chatGptAppReadme, /rejects\s+`executionMode: "local_provider"`/);
    assert.match(chatGptAppReadme, /real Goblintown board/);
    assert.match(chatGptAppReadme, /no OpenAI API key is required/);
    assert.match(chatGptAppReadme, /npm run verify:vercel/);
    assert.match(chatGptAppReadme, /https:\/\/goblintown-mcp\.vercel\.app\/mcp/);
    assert.match(chatGptAppReadme, /\[mcp_servers\.goblintown_hosted\]/);
    assert.match(chatGptAppReadme, /--public-base-url/);
    assert.match(chatGptAppReadme, /GOBLINTOWN_CHATGPT_ALLOWED_HOSTS/);
    assert.match(chatGptAppReadme, /Privacy Policy: https:\/\/goblintown-mcp\.vercel\.app\/privacy\.html/);
    assert.match(chatGptAppReadme, /Terms of Service: https:\/\/goblintown-mcp\.vercel\.app\/terms\.html/);
    assert.match(chatGptAppJson, /"productionMcpUrl": "https:\/\/goblintown-mcp\.vercel\.app\/mcp"/);
    assert.match(chatGptAppJson, /"websiteUrl": "https:\/\/goblintown-mcp\.vercel\.app"/);
    assert.match(chatGptAppJson, /"privacyPolicyUrl": "https:\/\/goblintown-mcp\.vercel\.app\/privacy\.html"/);
    assert.match(chatGptAppJson, /"termsOfServiceUrl": "https:\/\/goblintown-mcp\.vercel\.app\/terms\.html"/);
    assert.match(vercelJson, /"buildCommand": "npm run build"/);
    assert.match(vercelJson, /"destination": "\/api"/);
    assert.match(vercelApiIndex, /..\/dist\/vercel\.js/);
    assert.match(vercelSource, /createGoblintownChatGptExpressApp/);
    assert.match(vercelSource, /hostedMode: true/);
    assert.match(packageJson, /"verify:vercel": "node scripts\/verify-vercel-entry\.mjs"/);
    assert.match(chatGptSubmission, /existing board loop/);
    assert.match(chatGptSubmission, /does not require an OpenAI API key/);
    assert.match(chatGptSubmission, /"goblintown_rite"/);
    assert.doesNotMatch(chatGptSubmission, /"goblintown_chat"/);
    assert.match(cliReference, /goblintown chatgpt install/);
    assert.match(cliReference, /goblintown chatgpt serve --port 8787/);
    assert.match(cliReference, /Streamable\s+HTTP MCP endpoint at `\/mcp`/);
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
    assert.match(siteIndex, /agent-first, model-augmentable orchestration tool compatible with most front ends/);
    assert.match(siteIndex, /Each package adapts that orchestration layer to\s+a different front end/);
    assert.match(siteIndex, /Codex Plugin 1\.0/);
    assert.match(siteIndex, /Desktop Beta 0\.1/);
    assert.match(siteIndex, /ChatGPT App 1\.0/);
    assert.match(siteIndex, /ChatGPT App 1\.0\s+dev preview/);
    assert.match(siteIndex, /Streamable HTTP MCP endpoint at <code>\/mcp<\/code>/);
    assert.match(siteIndex, /npx -y goblintown@latest chatgpt install/);
    assert.match(siteIndex, /releases\/download\/v0\.7\.0-beta\.1\/Goblintown-0\.7\.0-beta\.1-mac-arm64\.dmg/);
    assert.match(siteIndex, /Goblintown-0\.7\.0-beta\.1-win-x64\.exe/);
    assert.match(siteIndex, /npm install -g goblintown/);
    assert.match(siteIndex, /Single Goblin \/ Goblintown/);
    assert.match(siteIndex, /goblintown --help/);
    assert.match(siteIndex, /Solana add-on/);
    assert.match(siteIndex, /Thesis engine/);
    assert.match(siteIndex, /Sentiment sources/);
    assert.match(siteIndex, /href="privacy\.html">privacy/);
    assert.match(siteIndex, /href="terms\.html">terms/);
    assert.match(sitePrivacy, /Goblintown does not sell personal data/);
    assert.match(sitePrivacy, /ChatGPT App dev preview/);
    assert.match(sitePrivacy, /Private local files are not uploaded by Goblintown unless you ask/);
    assert.match(siteTerms, /No Professional Advice/);
    assert.match(siteTerms, /Local-provider execution can spend your configured provider tokens or credits/);
    assert.match(packageJson, /"site\/\*\.html"/);

    // The split-parts download ritual and the old CLI command dump are gone.
    assert.doesNotMatch(siteIndex, /water-bear86/);
    assert.doesNotMatch(siteIndex, /release\/parts/);
    assert.doesNotMatch(siteIndex, /\.part-\*/);
    assert.doesNotMatch(siteIndex, /goblintown scavenge/);
    assert.doesNotMatch(siteIndex, /goblintown summon/);
  });
});
