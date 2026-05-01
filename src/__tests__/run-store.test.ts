import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRunDir,
  loadAllRuns,
  loadRun,
  saveRun,
  type RunRecord,
} from "../run-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "goblintown-run-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function rec(runId: string, done = false): RunRecord {
  return {
    runId,
    task: "do thing",
    packSize: 3,
    scanGlobs: [],
    events: [],
    done,
    startedAt: Date.now(),
  };
}

describe("run-store", () => {
  it("ensureRunDir creates the directory and is idempotent", async () => {
    const path = await ensureRunDir(dir);
    assert.match(path, /goblintown[\\/]+runs$/);
    const again = await ensureRunDir(dir);
    assert.equal(path, again);
  });

  it("save / load a single run round-trips", async () => {
    const path = await ensureRunDir(dir);
    const r = rec("abc");
    r.events.push({ seq: 0, kind: "step", data: { hello: "world" } });
    await saveRun(path, r);
    const got = await loadRun(path, "abc");
    assert.ok(got);
    assert.equal(got!.runId, "abc");
    assert.equal(got!.events.length, 1);
  });

  it("loadAllRuns returns every persisted record", async () => {
    const path = await ensureRunDir(dir);
    await saveRun(path, rec("r1", true));
    await saveRun(path, rec("r2"));
    await saveRun(path, rec("r3", true));
    const all = await loadAllRuns(path);
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((r) => r.runId).sort(), ["r1", "r2", "r3"]);
  });

  it("loadRun returns null for unknown ids", async () => {
    const path = await ensureRunDir(dir);
    assert.equal(await loadRun(path, "missing"), null);
  });
});
