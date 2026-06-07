import { strict as assert } from "node:assert";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  GOBLINTOWN_CODEX_PLUGIN_NAME,
  installGoblintownCodexPlugin,
} from "../plugin-install.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginSource = join(repoRoot, "plugins", "goblintown");

describe("Goblintown Codex plugin", () => {
  it("ships a Codex plugin manifest with MCP, skill, and UI metadata", async () => {
    const manifest = JSON.parse(
      await readFile(join(pluginSource, ".codex-plugin", "plugin.json"), "utf8"),
    ) as {
      name?: string;
      version?: string;
      author?: Record<string, unknown>;
      mcpServers?: string;
      skills?: string;
      interface?: Record<string, unknown>;
    };
    const mcp = JSON.parse(await readFile(join(pluginSource, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    const skill = await readFile(
      join(pluginSource, "skills", "goblintown-sidecar", "SKILL.md"),
      "utf8",
    );

    assert.equal(manifest.name, GOBLINTOWN_CODEX_PLUGIN_NAME);
    assert.equal(manifest.version, "1.0.0");
    assert.equal(manifest.mcpServers, "./.mcp.json");
    assert.equal(manifest.skills, "./skills/");
    assert.deepEqual(manifest.author, {
      name: "0xbl33p, and Angus Durrie",
      url: "https://github.com/0xbl33p",
    });
    assert.equal(manifest.interface?.displayName, "Goblintown");
    assert.match(
      JSON.stringify(manifest),
      /agent-first, model-augmentable orchestration tool compatible with most front ends/,
    );
    assert.equal(manifest.interface?.developerName, "0xbl33p, and Angus Durrie");
    assert.equal(manifest.interface?.category, "Developer Tools");
    assert.equal(manifest.interface?.shortDescription, "Goblintown Codex Plugin 1.0");
    assert.equal(manifest.interface?.websiteURL, "https://goblintown-mcp.vercel.app");
    assert.equal(
      manifest.interface?.privacyPolicyURL,
      "https://goblintown-mcp.vercel.app/privacy.html",
    );
    assert.equal(
      manifest.interface?.termsOfServiceURL,
      "https://goblintown-mcp.vercel.app/terms.html",
    );
    assert.equal(manifest.interface?.composerIcon, "./assets/mayor-icon-small.png");
    assert.equal(manifest.interface?.logo, "./assets/mayor-icon.png");
    const defaultPrompt = manifest.interface?.defaultPrompt;
    assert.ok(Array.isArray(defaultPrompt) && defaultPrompt.includes("Open the Goblintown Tank"));
    assert.deepEqual(mcp.mcpServers?.goblintown?.args, [
      "-y",
      "goblintown@latest",
      "mcp",
    ]);
    assert.match(skill, /^---\nname: goblintown-sidecar\n/m);
    assert.match(skill, /agent-first, model-augmentable orchestration tool compatible with most front\s+ends/);
    assert.match(skill, /goblintown_tank/);
    assert.match(skill, /npx -y goblintown@latest install/);
    assert.match(skill, /goblintown plugin install/);
    assert.match(skill, /Privacy Policy: https:\/\/goblintown-mcp\.vercel\.app\/privacy\.html/);
    assert.match(skill, /Terms of Service: https:\/\/goblintown-mcp\.vercel\.app\/terms\.html/);
  });

  it("installs the plugin and personal marketplace entry idempotently", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "goblintown-plugin-install-"));
    try {
      const targetDir = join(tmp, "plugins", "goblintown");
      const marketplacePath = join(tmp, ".agents", "plugins", "marketplace.json");

      const first = await installGoblintownCodexPlugin({
        sourceDir: pluginSource,
        targetDir,
        marketplacePath,
        installInCodex: false,
      });
      assert.equal(first.ok, true);
      assert.equal(first.changed, true);
      assert.equal(first.marketplace.changed, true);
      assert.equal(first.restartRequired, true);
      assert.equal(first.viewUrl.includes("codex://plugins/goblintown"), true);

      const installedManifest = await readFile(
        join(targetDir, ".codex-plugin", "plugin.json"),
        "utf8",
      );
      assert.match(installedManifest, /"name": "goblintown"/);

      const marketplace = JSON.parse(await readFile(marketplacePath, "utf8")) as {
        name?: string;
        interface?: { displayName?: string };
        plugins?: Array<{
          name?: string;
          source?: { source?: string; path?: string };
          policy?: { installation?: string; authentication?: string };
          category?: string;
        }>;
      };
      assert.equal(marketplace.name, "personal");
      assert.equal(marketplace.interface?.displayName, "Personal");
      assert.deepEqual(marketplace.plugins, [
        {
          name: "goblintown",
          source: { source: "local", path: "./plugins/goblintown" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Developer Tools",
        },
      ]);

      const second = await installGoblintownCodexPlugin({
        sourceDir: pluginSource,
        targetDir,
        marketplacePath,
        installInCodex: false,
      });
      assert.equal(second.ok, true);
      assert.equal(second.changed, false);
      assert.equal(second.marketplace.changed, false);

      const marketplaceAgain = JSON.parse(await readFile(marketplacePath, "utf8")) as {
        plugins?: Array<{ name?: string }>;
      };
      assert.equal(
        marketplaceAgain.plugins?.filter((plugin) => plugin.name === "goblintown").length,
        1,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("installs the marketplace entry into Codex so it can appear in the composer menu", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "goblintown-plugin-codex-add-"));
    try {
      const targetDir = join(tmp, "plugins", "goblintown");
      const marketplacePath = join(tmp, ".agents", "plugins", "marketplace.json");
      const callsPath = join(tmp, "codex-calls.json");
      const fakeCodex = join(tmp, "codex");
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env node",
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)));`,
          "process.stdout.write('fake codex add ok\\n');",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      const result = await installGoblintownCodexPlugin({
        sourceDir: pluginSource,
        targetDir,
        marketplacePath,
        codexCliPath: fakeCodex,
      });

      assert.equal(result.ok, true);
      assert.equal(result.codex.ok, true);
      assert.equal(result.codex.selector, "goblintown@personal");
      assert.deepEqual(JSON.parse(await readFile(callsPath, "utf8")), [
        "plugin",
        "add",
        "goblintown@personal",
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
