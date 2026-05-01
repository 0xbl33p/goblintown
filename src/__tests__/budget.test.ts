import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Budget, BudgetExceededError } from "../budget.js";

function usage(total: number) {
  return {
    promptTokens: Math.floor(total / 2),
    completionTokens: Math.ceil(total / 2),
    totalTokens: total,
    model: "test",
  };
}

describe("Budget", () => {
  it("an unbounded budget never throws", () => {
    const b = new Budget();
    b.charge(usage(10_000));
    b.enforceOrThrow();
    assert.equal(b.remaining, Infinity);
  });

  it("rejects negative caps", () => {
    assert.throws(() => new Budget(-1));
  });

  it("throws BudgetExceededError after usage meets the cap", () => {
    const b = new Budget(100);
    b.charge(usage(60));
    b.enforceOrThrow(); // still under
    b.charge(usage(50));
    assert.throws(() => b.enforceOrThrow(), BudgetExceededError);
    assert.equal(b.used, 110);
    assert.equal(b.remaining, 0);
  });

  it("ignores undefined usage on charge", () => {
    const b = new Budget(10);
    b.charge(undefined);
    assert.equal(b.used, 0);
  });
});
