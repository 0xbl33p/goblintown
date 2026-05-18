import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");

describe("tank sprite assets", () => {
  it("wires bundled tank sprites into the tank", () => {
    assert.match(serverSource, /id="c-gremlin-sprite"/);
    assert.match(serverSource, /id="c-ogre-sprite"/);
    assert.match(serverSource, /id="c-raccoon-sprite"/);
    assert.match(serverSource, /id="c-troll-sprite"/);
    assert.match(serverSource, /gremlin-idle\.png/);
    assert.match(serverSource, /ogre-idle\.png/);
    assert.match(serverSource, /raccoon-sleep\.png/);
    assert.match(serverSource, /raccoon-get-up\.png/);
    assert.match(serverSource, /raccoon-scurry\.png/);
    assert.match(serverSource, /troll-idle\.png/);
    assert.match(serverSource, /gtowntextmark\.png/);
    assert.match(serverSource, /class="tank-logo-mark"/);
    assert.match(serverSource, /\.tank-logo-mark/);
    assert.match(serverSource, /\.tank-logo-mark \{[\s\S]*?top: 50%/);
    assert.match(serverSource, /\.tank-logo-mark \{[\s\S]*?transform: translate\(-50%, -50%\)/);
    assert.match(serverSource, /@keyframes logo-float/);
    assert.match(serverSource, /bootIdleCreatureSprite/);
    assert.match(serverSource, /frameOrder: \[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13/);
    assert.match(serverSource, /frameOrder: \[0, 8, 16, 24, 1, 9, 17, 25/);
    const gremlinConfig = serverSource.match(/src: "\/assets\/gremlin-idle\.png"[\s\S]*?fps: 6/);
    assert.ok(gremlinConfig);
    assert.doesNotMatch(gremlinConfig[0], /frameOrder: \[[^\]]*\b19\b[^\]]*\]/);
    assert.match(serverSource, /src: "\/assets\/gremlin-idle\.png"[\s\S]*?fps: 6/);
    assert.match(serverSource, /src: "\/assets\/ogre-idle\.png"[\s\S]*?fps: 6/);
    assert.match(serverSource, /src: "\/assets\/raccoon-sleep\.png"[\s\S]*?cols: 16/);
    assert.match(serverSource, /src: "\/assets\/raccoon-sleep\.png"[\s\S]*?rows: 1/);
    assert.match(serverSource, /src: "\/assets\/raccoon-sleep\.png"[\s\S]*?totalFrames: 16/);
    assert.match(serverSource, /src: "\/assets\/raccoon-sleep\.png"[\s\S]*?fps: 5/);
    assert.match(serverSource, /getUpSrc: "\/assets\/raccoon-get-up\.png"/);
    assert.match(serverSource, /scurrySrc: "\/assets\/raccoon-scurry\.png"/);
    assert.match(serverSource, /getUpFrames: 23/);
    assert.match(serverSource, /scurryFrames: 10/);
    assert.match(serverSource, /function playRaccoonTransition/);
    assert.match(serverSource, /function playRaccoonScurry/);
    assert.match(serverSource, /raccoonSpriteState\.facing/);
    assert.match(serverSource, /src: "\/assets\/troll-idle\.png"[\s\S]*?cols: 24/);
    assert.match(serverSource, /src: "\/assets\/troll-idle\.png"[\s\S]*?rows: 1/);
    assert.match(serverSource, /src: "\/assets\/troll-idle\.png"[\s\S]*?totalFrames: 24/);
    assert.match(serverSource, /src: "\/assets\/troll-idle\.png"[\s\S]*?fps: 6/);
    assert.match(serverSource, /src: "\/assets\/troll-idle\.png"[\s\S]*?dedupeFrames: false/);
    assert.match(serverSource, /\.creature\.ogre-animated\[data-state="cave"\] \{ opacity: 1;/);
    assert.match(serverSource, /\.creature\.raccoon-animated\[data-state="idle"\] \.idle-sprite/);
    assert.match(serverSource, /\.creature\.troll-animated\[data-state="idle"\] \.idle-sprite/);
  });

  it("ships the configured tank sprite sheets", () => {
    assert.equal(existsSync(join(repoRoot, "site", "assets", "gremlin-idle.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "ogre-idle.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "raccoon-sleep.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "raccoon-get-up.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "raccoon-scurry.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "troll-idle.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "gtowntextmark.png")), true);
  });
});
