import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { BANNERS, bannerFor } from "../banners.js";
import { CREATURE_KINDS } from "../types.js";

describe("banners", () => {
  it("has a banner for every creature kind", () => {
    for (const k of CREATURE_KINDS) {
      assert.ok(BANNERS[k], `missing banner for ${k}`);
      assert.ok(BANNERS[k].length > 20, `banner for ${k} is too short`);
    }
  });

  it("bannerFor returns a non-empty string", () => {
    for (const k of CREATURE_KINDS) {
      const b = bannerFor(k);
      assert.equal(typeof b, "string");
      assert.ok(b.includes("█") || b.includes("▀") || b.includes("▄"));
    }
  });
});
