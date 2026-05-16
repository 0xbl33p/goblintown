import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { initWarren, resetWarren } from "../warren.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");

describe("Asteroid Mode", () => {
  it("obliterates persisted local warren memory and recreates a fresh warren", async () => {
    const root = await mkdtemp(join(tmpdir(), "goblintown-asteroid-"));
    try {
      const first = await initWarren(root);
      const goblintownDir = join(root, ".goblintown");
      await writeFile(join(first.hoard.lootDir, "old-loot.json"), "{}", "utf8");
      await mkdir(join(goblintownDir, "runs"), { recursive: true });
      await writeFile(join(goblintownDir, "runs", "old-run.json"), "{}", "utf8");
      await writeFile(join(goblintownDir, "country-identity.json"), "{}", "utf8");
      await writeFile(join(goblintownDir, "provider-secrets.json"), "{}", "utf8");

      const fresh = await resetWarren(root);
      const freshManifest = JSON.parse(readFileSync(fresh.manifestPath, "utf8"));

      assert.equal(existsSync(join(goblintownDir, "runs", "old-run.json")), false);
      assert.equal(existsSync(join(goblintownDir, "country-identity.json")), false);
      assert.equal(existsSync(join(goblintownDir, "provider-secrets.json")), false);
      assert.equal(existsSync(join(fresh.hoard.lootDir, "old-loot.json")), false);
      assert.deepEqual(await readdir(fresh.hoard.lootDir), []);
      assert.equal(freshManifest.name, first.manifest.name);
      assert.notEqual(freshManifest.country.countryId, first.manifest.country?.countryId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("wires the destructive tank reset behind Asteroid Mode confirmations", () => {
    assert.match(serverSource, /id="resume-dismiss"[^>]*>Asteroid Mode<\/button>/);
    assert.match(serverSource, /id="btn-asteroid"[\s\S]*Asteroid Mode[\s\S]*<\/button>/);
    assert.match(serverSource, /id="asteroid-overlay"/);
    assert.match(serverSource, /id="asteroid-confirm"/);
    assert.match(serverSource, /Are you sure you want to delete your cloud data aswell/);
    assert.match(serverSource, /Yes, Nuke it/);
    assert.match(serverSource, /Just Destroy the Town/);
    assert.match(serverSource, />Cancel<\/button>/);
    assert.match(serverSource, /\/vendor\/matter-js\/matter\.min\.js/);
    assert.match(serverSource, /app\.post\("\/api\/asteroid"/);
    assert.match(serverSource, /confirm !== "ASTEROID"/);
    assert.match(serverSource, /function openAsteroidMode/);
    assert.match(serverSource, /async function nukeCloudAccountData/);
    assert.match(serverSource, /membershipState: "deleted"/);
    assert.match(serverSource, /Deleted account/);
    assert.match(serverSource, /localStorage\.removeItem\(key\)/);
  });
});
