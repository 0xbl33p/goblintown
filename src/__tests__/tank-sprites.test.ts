import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");

describe("tank sprite assets", () => {
  it("wires optional gremlin and ogre idle sprites into the tank", () => {
    assert.match(serverSource, /id="c-gremlin-sprite"/);
    assert.match(serverSource, /id="c-ogre-sprite"/);
    assert.match(serverSource, /gremlin-idle\.png/);
    assert.match(serverSource, /ogre-idle\.png/);
    assert.match(serverSource, /bootIdleCreatureSprite/);
    assert.match(serverSource, /frameOrder: \[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13/);
    assert.match(serverSource, /frameOrder: \[0, 8, 16, 24, 1, 9, 17, 25/);
    const gremlinConfig = serverSource.match(/src: "\/assets\/gremlin-idle\.png"[\s\S]*?fps: 6/);
    assert.ok(gremlinConfig);
    assert.doesNotMatch(gremlinConfig[0], /frameOrder: \[[^\]]*\b19\b[^\]]*\]/);
    assert.match(serverSource, /src: "\/assets\/gremlin-idle\.png"[\s\S]*?fps: 6/);
    assert.match(serverSource, /src: "\/assets\/ogre-idle\.png"[\s\S]*?fps: 6/);
    assert.match(serverSource, /\.creature\.ogre-animated\[data-state="cave"\] \{ opacity: 1;/);
  });

  it("ships the configured idle sprite sheets", () => {
    assert.equal(existsSync(join(repoRoot, "site", "assets", "gremlin-idle.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "ogre-idle.png")), true);
  });
});
