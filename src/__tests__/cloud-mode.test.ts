import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");

describe("cloud mode", () => {
  it("bundles the shared Goblintown Firebase project while preserving env overrides", () => {
    assert.match(serverSource, /DEFAULT_FIREBASE_CLIENT_CONFIG/);
    assert.match(serverSource, /goblintown-88fd6/);
    assert.match(serverSource, /AIzaSyD2px9fRoSh6bwOBDIk2dGioYbxROQ6Leo/);
    assert.match(serverSource, /trimmedEnv\("FIREBASE_API_KEY"\) \?\? DEFAULT_FIREBASE_CLIENT_CONFIG\.apiKey/);
    assert.match(serverSource, /trimmedEnv\("FIREBASE_AUTH_DOMAIN"\) \?\? DEFAULT_FIREBASE_CLIENT_CONFIG\.authDomain/);
    assert.match(serverSource, /enabled: true/);
  });

  it("asks for a local-or-cloud choice before Firebase initializes", () => {
    assert.match(serverSource, /cloudModeStorageKey = "goblintown\.cloudMode\.v1"/);
    assert.match(serverSource, /function isCloudModeEnabled/);
    assert.match(serverSource, /function setCloudModeChoice/);
    assert.match(serverSource, /function bootFirebaseIfCloudMode/);
    assert.match(serverSource, /if \(!isCloudModeEnabled\(\)\) return;[\s\S]*const boot = ensureFirebaseReady\(\)/);
    assert.match(serverSource, /bootFirebaseIfCloudMode\(\);/);
    assert.doesNotMatch(serverSource, /void ensureFirebaseReady\(\)\.catch/);
    assert.match(serverSource, /id="onboard-local-mode"/);
    assert.match(serverSource, /id="onboard-cloud-mode"/);
    assert.match(serverSource, /Stay Local/);
    assert.match(serverSource, /Use Goblintown Cloud/);
  });

  it("exposes cloud mode controls in the Account menu", () => {
    assert.match(serverSource, /id="cloud-mode-status"/);
    assert.match(serverSource, /id="cloud-local-mode"/);
    assert.match(serverSource, /id="cloud-enable-mode"/);
    assert.match(serverSource, /Cloud Mode/);
    assert.match(serverSource, /authGoogleBtn\.disabled = !cloudOn \|\| !enabled/);
    assert.match(serverSource, /countryBackendSelect\.disabled = !isCloudModeEnabled\(\)/);
  });
});
