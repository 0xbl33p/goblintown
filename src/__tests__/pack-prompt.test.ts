import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { packVariant } from "../pack-prompt.js";

describe("packVariant", () => {
  it("returns the bare task when packSize is 1", () => {
    assert.equal(packVariant("do thing", 0, 1), "do thing");
  });

  it("returns the bare task when packSize is 0 or negative", () => {
    assert.equal(packVariant("do thing", 0, 0), "do thing");
    assert.equal(packVariant("do thing", 0, -1), "do thing");
  });

  it("appends a distinct hint per index when packSize > 1", () => {
    const a = packVariant("task", 0, 3);
    const b = packVariant("task", 1, 3);
    const c = packVariant("task", 2, 3);
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
    for (const v of [a, b, c]) assert.match(v, /Goblin \d+ of 3/);
  });

  it("wraps around when index exceeds the hint pool", () => {
    const a = packVariant("task", 0, 100);
    const b = packVariant("task", 9, 100);
    // both reference the same hint pool; with index 9 we wrap
    assert.match(a, /Goblin 1 of 100/);
    assert.match(b, /Goblin 10 of 100/);
  });

  it("returns the bare task for non-finite packSize", () => {
    assert.equal(packVariant("task", 0, NaN), "task");
    assert.equal(packVariant("task", 0, Infinity), "task");
  });

  it("throws on a negative or non-integer index when packSize > 1", () => {
    assert.throws(() => packVariant("task", -1, 3), RangeError);
    assert.throws(() => packVariant("task", 0.5, 3), RangeError);
    assert.throws(() => packVariant("task", NaN, 3), RangeError);
  });
});
