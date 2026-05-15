import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");

describe("provider manager UI", () => {
  it("exposes menagerie route controls for per-creature provider overrides", () => {
    assert.match(serverSource, /id="provider-routes"/);
    assert.match(serverSource, /menagerie routes/i);
    assert.match(serverSource, /data-route-slot/);
  });

  it("keeps route controls inside a scrollable tank popover", () => {
    assert.match(serverSource, /class="provider-scroll"/);
    assert.match(serverSource, /\.provider-scroll \{[\s\S]*overflow-y: scroll;/);
    assert.match(serverSource, /\.provider-scroll \{[\s\S]*scrollbar-gutter: stable;/);
    assert.match(serverSource, /\.provider-popover, \.provider-popover \* \{ box-sizing: border-box; \}/);
    assert.match(serverSource, /class="provider-advanced provider-routes-panel"/);
    assert.match(serverSource, /\.provider-popover\.open \{ display: flex; \}/);
    assert.match(serverSource, /\.provider-route-list \{[\s\S]*max-height:/);
    assert.match(serverSource, /\.provider-route-list \{[\s\S]*overflow-y: scroll;/);
    assert.match(serverSource, /\.provider-route-list \{[\s\S]*linear-gradient\(to left/);
    assert.match(serverSource, /\.provider-route-list \{[\s\S]*box-shadow: inset -14px 0 0/);
  });
});
