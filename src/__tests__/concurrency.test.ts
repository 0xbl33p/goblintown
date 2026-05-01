import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Semaphore } from "../concurrency.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Semaphore", () => {
  it("rejects capacity < 1", () => {
    assert.throws(() => new Semaphore(0));
    assert.throws(() => new Semaphore(-1));
  });

  it("caps the number of in-flight tasks", async () => {
    const sem = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, () =>
      sem.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await delay(15);
        inFlight--;
      }),
    );
    await Promise.all(tasks);
    assert.equal(peak, 2);
  });

  it("releases on task error", async () => {
    const sem = new Semaphore(1);
    await assert.rejects(
      sem.run(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    // Next acquisition should succeed immediately
    let ran = false;
    await sem.run(async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });
});
