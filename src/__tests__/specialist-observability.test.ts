import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const riteSource = readFileSync(join(repoRoot, "src", "rite.ts"), "utf8");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");
const cliSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");

describe("specialist recovery observability", () => {
  it("emits visible events when specialist clustering returns nothing or fails", () => {
    assert.match(riteSource, /kind: "specialist:cluster:empty"/);
    assert.match(riteSource, /kind: "specialist:cluster:error"/);
    assert.match(riteSource, /onStep\(\{\s*kind: "specialist:cluster:error"/);
    assert.doesNotMatch(riteSource, /catch\s*\{\s*\/\/ recovery is best-effort; fall through to ogre\s*\}/);
  });

  it("renders specialist empty and error states in Tank and CLI output", () => {
    assert.match(serverSource, /case "specialist:cluster:empty"/);
    assert.match(serverSource, /case "specialist:cluster:error"/);
    assert.match(cliSource, /case "specialist:cluster:empty"/);
    assert.match(cliSource, /case "specialist:cluster:error"/);
  });
});
