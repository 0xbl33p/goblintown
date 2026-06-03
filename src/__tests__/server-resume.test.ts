import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { resumePayloadForRun } from "../server.js";
import { buildResumePrompt, type RunRecord } from "../run-store.js";

function rec(runId: string): RunRecord {
  return {
    runId,
    task: "Subjectively answer who was best before Michael Jordan.",
    packSize: 4,
    scanGlobs: [],
    mode: "rite",
    status: "error",
    request: {
      mode: "rite",
      payload: {
        task: "Subjectively answer who was best before Michael Jordan.",
        packSize: 4,
        debate: true,
        trollTools: true,
        noSpecialist: false,
        budgetTokens: 12_000,
        maxOutputTokens: 1_200,
      },
    },
    events: [],
    done: true,
    startedAt: Date.now(),
  };
}

describe("server resume payloads", () => {
  it("recomputes stale nested prompts and downsizes budget-failure retries", () => {
    const first = rec("first");
    first.error = "Budget exceeded: 25014 / 12000 tokens";
    const staleNestedPrompt = buildResumePrompt({
      ...rec("second"),
      task: buildResumePrompt(first),
      error: "Budget exceeded: 25117 / 12000 tokens",
      resumedFromRunId: first.runId,
    });

    const source = rec("third");
    source.task = staleNestedPrompt;
    source.resumePrompt = staleNestedPrompt;
    source.error = "Budget exceeded: 25117 / 12000 tokens";
    source.resumable = true;

    const payload = resumePayloadForRun(source, source.request!.payload);

    assert.match(
      String(payload.task),
      /Original task: Subjectively answer who was best before Michael Jordan\./,
    );
    assert.doesNotMatch(String(payload.task), /Original task: Continue the interrupted/);
    assert.equal(payload.packSize, 1);
    assert.equal(payload.debate, false);
    assert.equal(payload.trollTools, false);
    assert.equal(payload.noSpecialist, true);
    assert.equal(payload.maxOutputTokens, 800);
    assert.equal(payload.budgetTokens, 12_000);
  });
});
