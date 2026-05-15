import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunEvent,
  ensureRunDir,
  loadAllRuns,
  loadRun,
  markRunInterrupted,
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

  it("compacts repeated thinking events before persisting", async () => {
    const path = await ensureRunDir(dir);
    const r = rec("compact");

    appendRunEvent(r, "step", {
      kind: "thinking",
      slot: "goblin#0",
      text: "first draft",
    });
    appendRunEvent(r, "step", {
      kind: "thinking",
      slot: "goblin#0",
      text: "x".repeat(12_000),
    });
    appendRunEvent(r, "step", {
      kind: "pack:goblin",
      index: 0,
      lootId: "loot-1",
    });

    await saveRun(path, r);
    const got = await loadRun(path, "compact");

    assert.ok(got);
    const thinking = got!.events.filter((e) => {
      const data = e.data as { kind?: string };
      return e.kind === "step" && data.kind === "thinking";
    });
    assert.equal(thinking.length, 1);
    assert.equal(got!.events.length, 2);
    assert.equal(got!.nextSeq, 3);
    assert.ok(
      ((thinking[0].data as { text: string }).text.length) < 8_500,
      "stored thinking text should be capped",
    );
  });

  it("tracks a resumable checkpoint from emitted events", async () => {
    const path = await ensureRunDir(dir);
    const r = rec("checkpoint");
    r.status = "running";

    appendRunEvent(r, "step", { kind: "pack:start", size: 2 });
    appendRunEvent(r, "step", {
      kind: "pack:goblin",
      index: 0,
      lootId: "loot-1",
    });
    appendRunEvent(r, "step", {
      kind: "scribe:done",
      artifactId: "artifact-1",
      riteId: "rite-1",
    });

    await saveRun(path, r);
    const got = await loadRun(path, "checkpoint");

    assert.ok(got);
    assert.equal(got!.checkpoint?.phase, "scribe:done");
    assert.deepEqual(got!.checkpoint?.lootIds, ["loot-1"]);
    assert.deepEqual(got!.checkpoint?.artifactIds, ["artifact-1"]);
    assert.equal(got!.checkpoint?.lastEventSeq, 2);
  });

  it("marks unfinished runs as interrupted and resumable", () => {
    const r = rec("interrupted");
    r.status = "running";
    appendRunEvent(r, "step", { kind: "review:start" });

    markRunInterrupted(r, 123_456);

    assert.equal(r.done, true);
    assert.equal(r.status, "interrupted");
    assert.equal(r.resumable, true);
    assert.equal(r.finishedAt, 123_456);
    assert.match(r.error ?? "", /interrupted/);
    assert.match(r.resumePrompt ?? "", /Continue the interrupted rite run/);
    assert.match(r.resumePrompt ?? "", /review:start/);
  });
});
