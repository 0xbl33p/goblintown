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
    assert.match(serverSource, /goblin-explosion\.png/);
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

  it("ships bundled and prepared tank sprite sheets", () => {
    assert.equal(existsSync(join(repoRoot, "site", "assets", "gremlin-idle.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "ogre-idle.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "raccoon-sleep.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "raccoon-get-up.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "raccoon-scurry.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "troll-idle.png")), true);
    assert.equal(existsSync(join(repoRoot, "site", "assets", "goblin-explosion.png")), true);
    for (const filename of goblinActionSheets.map((sheet) => sheet.filename)) {
      assert.equal(existsSync(join(repoRoot, "site", "assets", filename)), true);
    }
    assert.equal(existsSync(join(repoRoot, "site", "assets", "gtowntextmark.png")), true);
  });

  it("ships Goblintown goblin action sheets with expected frame strips", () => {
    for (const sheet of goblinActionSheets) {
      const dimensions = readPngDimensions(join(repoRoot, "site", "assets", sheet.filename));
      assert.deepEqual(dimensions, { width: sheet.width, height: sheet.height });
    }
  });

  it("wires Goblintown goblin action sheets into the live Tank renderer", () => {
    assert.match(serverSource, /const GOBLIN_VARIANT_WEIGHTS = \[/);
    assert.match(serverSource, /variant: "green"[\s\S]*?variant: "fire"[\s\S]*?variant: "spear"[\s\S]*?variant: "sceptre"/);
    assert.match(serverSource, /const GOBLIN_ACTION_SHEETS = \{/);
    for (const sheet of goblinActionSheets) {
      assert.match(serverSource, new RegExp(sheet.filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(serverSource, /function pickGoblinVariant/);
    assert.match(serverSource, /function playGoblinAction/);
    assert.match(serverSource, /function holdGoblinStanding/);
    assert.match(serverSource, /function goHomeGoblinSlot/);
    assert.match(serverSource, /function goHomeAllGoblins/);
    assert.match(serverSource, /const visible = Math\.max\(1, Math\.floor\(packSize \|\| 1\)\)/);
    assert.doesNotMatch(serverSource, /Math\.min\(packSize,\s*3\)/);
    assert.match(serverSource, /renderGoblinSlots\(step\.size\)/);
    assert.match(serverSource, /playGoblinAction\(slot, "come-out"/);
    assert.match(serverSource, /playGoblinAction\(slot, "argue"/);
    assert.match(serverSource, /playGoblinAction\(slot, "defend"/);
    assert.match(serverSource, /goHomeGoblinSlot\(slot/);
    assert.match(serverSource, /function positionBubbleAboveTarget/);
    assert.match(serverSource, /function bubbleCandidatesForTarget/);
    assert.match(serverSource, /left: cx - bw \/ 2/);
  });

  it("shows specialist recovery by exploding and inverting the existing goblin pack", () => {
    const dimensions = readPngDimensions(join(repoRoot, "site", "assets", "goblin-explosion.png"));
    assert.deepEqual(dimensions, { width: 630, height: 500 });
    assert.match(serverSource, /id="goblin-explosion"/);
    assert.match(serverSource, /const GOBLIN_EXPLOSION_SHEET = \{/);
    assert.match(serverSource, /src: "\/assets\/goblin-explosion\.png"/);
    assert.match(serverSource, /\.goblin-wrap\[data-specialist="true"\] \.goblin-sprite \{[\s\S]*?filter: invert\(1\)/);
    assert.match(serverSource, /function playGoblinSpecialistTransition/);
    assert.match(serverSource, /function specialistSlotForIndex/);
    assert.match(serverSource, /specialistByIndex\[step\.index\] = specialistSlotForIndex\(step\.index\)/);
    assert.doesNotMatch(serverSource, /renderSpecialistSlots\(step\.clusters\.length\)/);
  });

  it("keeps goblins present through verdicts and sends them home at rite completion", () => {
    const verdictBlock = serverSource.match(/case "review:verdict": \{[\s\S]*?break;\n    \}/);
    assert.ok(verdictBlock);
    assert.doesNotMatch(verdictBlock[0], /goHomeGoblinSlot/);

    const doneBlock = serverSource.match(/case "rite:done":[\s\S]*?break;/);
    assert.ok(doneBlock);
    assert.match(doneBlock[0], /goHomeAllGoblins\(1200\)/);
  });

  it("wakes and scurries the raccoon when prior artifacts are recalled", () => {
    assert.match(serverSource, /function cueRaccoonWork\(options\)/);
    assert.match(serverSource, /function cueRaccoonScurryAfterWake/);
    assert.match(serverSource, /setState\("c-raccoon","active"\);[\s\S]*?cueRaccoonScurryAfterWake/);

    const artifactBlock = serverSource.match(/case "artifacts:loaded":[\s\S]*?break;/);
    assert.ok(artifactBlock);
    assert.match(artifactBlock[0], /cueRaccoonWork\(\{ scurry: !replay \}\)/);

    const scavengeStartBlock = serverSource.match(/case "scavenge:start":[\s\S]*?break;/);
    assert.ok(scavengeStartBlock);
    assert.match(scavengeStartBlock[0], /cueRaccoonWork\(\)/);

    const scavengeDoneBlock = serverSource.match(/case "scavenge:done":[\s\S]*?break;/);
    assert.ok(scavengeDoneBlock);
    assert.match(scavengeDoneBlock[0], /cueRaccoonScurryAfterWake\(\)/);
  });

  it("makes the pigeon peck visible after idle and scribe activity", () => {
    const peckConfig = serverSource.match(/const PIGEON_PECK_CONFIG = \{[\s\S]*?\n\};/);
    assert.ok(peckConfig);
    assert.match(peckConfig[0], /firstMinIntervalMs: 1_500/);
    assert.match(peckConfig[0], /firstMaxIntervalMs: 4_000/);
    assert.match(peckConfig[0], /minIntervalMs: 14_000/);
    assert.match(peckConfig[0], /maxIntervalMs: 35_000/);

    assert.match(serverSource, /function queuePigeonPeckSoon\(delayMs\)/);
    assert.match(serverSource, /pigeonSpriteState\.peckLoopsLeft = 2/);

    const scribeDoneBlock = serverSource.match(/case "scribe:done":[\s\S]*?break;/);
    assert.ok(scribeDoneBlock);
    assert.match(scribeDoneBlock[0], /setState\("c-pigeon","idle"\)/);
    assert.match(scribeDoneBlock[0], /queuePigeonPeckSoon\(350\)/);
  });

  it("clears all Tank text boxes before goblins go home", () => {
    assert.match(serverSource, /function clearAllTextBubbles/);
    const goHomeSlot = serverSource.match(/function goHomeGoblinSlot\(slot, delayMs\) \{[\s\S]*?\n\}/);
    assert.ok(goHomeSlot);
    assert.match(goHomeSlot[0], /clearAllTextBubbles\(\)[\s\S]*?playGoblinAction\(slot, "go-home"/);

    const goHomeAll = serverSource.match(/function goHomeAllGoblins\(delayMs\) \{[\s\S]*?\n\}/);
    assert.ok(goHomeAll);
    assert.match(goHomeAll[0], /clearAllTextBubbles\(\)[\s\S]*?goHomeGoblinSlot/);
  });

  it("keeps Tank speech and thinking bubbles translucent and overlap-aware", () => {
    assert.match(serverSource, /--bubble-bg: rgba\(20,\s*32,\s*26,\s*0\.78\)/);
    assert.match(serverSource, /\.think-bubble \{[\s\S]*?background: rgba\(20,\s*32,\s*26,\s*0\.78\)/);
    assert.match(serverSource, /const MAX_BUBBLES = 6/);
    assert.match(serverSource, /function rectsOverlap/);
    assert.match(serverSource, /function getBubbleLayoutItems/);
    assert.match(serverSource, /function placeBubbleAvoidingOverlap/);
    assert.match(serverSource, /function layoutBubbleLayer/);
    assert.match(serverSource, /window\.addEventListener\("resize", layoutBubbleLayer\)/);
    assert.match(serverSource, /layoutBubbleLayer\(\)/);
    assert.doesNotMatch(serverSource, /const MAX_BUBBLES = 3/);
  });

  it("positions the live goblin pile over the upper-center town field", () => {
    assert.match(serverSource, /\.pos-goblins \{[\s\S]*?position: absolute/);
    assert.match(serverSource, /\.pos-goblins \{[\s\S]*?top: 28%/);
    assert.match(serverSource, /\.pos-goblins \{[\s\S]*?left: 50%/);
    assert.match(serverSource, /\.pos-goblins \{[\s\S]*?transform: translateX\(-50%\)/);
  });
});

const goblinActionSheets = [
  { filename: "goblin-green-argue.png", width: 1536, height: 128 },
  { filename: "goblin-fire-argue.png", width: 1536, height: 128 },
  { filename: "goblin-sceptre-argue.png", width: 1536, height: 128 },
  { filename: "goblin-spear-argue.png", width: 1536, height: 128 },
  { filename: "goblin-green-defend.png", width: 1536, height: 128 },
  { filename: "goblin-fire-defend.png", width: 1536, height: 128 },
  { filename: "goblin-sceptre-defend.png", width: 2816, height: 128 },
  { filename: "goblin-spear-defend.png", width: 1536, height: 128 },
  { filename: "goblin-green-go-home.png", width: 1536, height: 128 },
  { filename: "goblin-fire-go-home.png", width: 1792, height: 128 },
  { filename: "goblin-sceptre-go-home.png", width: 1536, height: 128 },
  { filename: "goblin-spear-go-home.png", width: 1536, height: 128 },
  { filename: "goblin-green-come-out.png", width: 1536, height: 128 },
  { filename: "goblin-fire-come-out.png", width: 1536, height: 128 },
  { filename: "goblin-sceptre-come-out.png", width: 1536, height: 128 },
  { filename: "goblin-spear-come-out.png", width: 1664, height: 128 },
] as const;

function readPngDimensions(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  assert.equal(buf.toString("ascii", 1, 4), "PNG");
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}
