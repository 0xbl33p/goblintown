import type { TokenUsage } from "./types.js";

export class BudgetExceededError extends Error {
  constructor(
    public readonly used: number,
    public readonly cap: number,
  ) {
    super(`Budget exceeded: ${used} / ${cap} tokens`);
    this.name = "BudgetExceededError";
  }
}

export class Budget {
  private _used = 0;

  constructor(public readonly cap?: number) {
    if (cap !== undefined && cap < 0) {
      throw new Error("Budget cap cannot be negative");
    }
  }

  get used(): number {
    return this._used;
  }

  get remaining(): number {
    return this.cap === undefined ? Infinity : Math.max(0, this.cap - this._used);
  }

  charge(usage: TokenUsage | undefined): void {
    if (!usage) return;
    this._used += usage.totalTokens;
  }

  enforceOrThrow(): void {
    if (this.cap !== undefined && this._used >= this.cap) {
      throw new BudgetExceededError(this._used, this.cap);
    }
  }
}
