import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  commandToCliArgs,
  commandToRunRequest,
  parseGoblinCommand,
} from "../slash-commands.js";

describe("Goblin Mode slash commands", () => {
  it("treats plain text as the selected default mode", () => {
    const parsed = parseGoblinCommand("summarize this repository", {
      mode: "single",
      tank: false,
    });

    assert.equal(parsed.kind, "run");
    assert.equal(parsed.mode, "single");
    assert.equal(parsed.task, "summarize this repository");
    assert.equal(parsed.tank, false);
  });

  it("parses quoted /ask tasks as Single Goblin runs", () => {
    const parsed = parseGoblinCommand('/ask "write the shortest useful answer" --tank', {
      mode: "town",
      tank: true,
    });

    assert.equal(parsed.kind, "ask");
    assert.equal(parsed.mode, "single");
    assert.equal(parsed.task, "write the shortest useful answer");
    assert.equal(parsed.tank, false);
  });

  it("parses /town as Goblintown mode and preserves tank intent", () => {
    const parsed = parseGoblinCommand('/town --tank "ship a desktop app wrapper"', {
      mode: "single",
      tank: false,
    });

    assert.equal(parsed.kind, "town");
    assert.equal(parsed.mode, "town");
    assert.equal(parsed.task, "ship a desktop app wrapper");
    assert.equal(parsed.tank, true);
  });

  it("builds server run requests for single and town commands", () => {
    assert.deepEqual(
      commandToRunRequest(parseGoblinCommand("/ask fix docs")),
      {
        endpoint: "/api/goblin/single",
        payload: { task: "fix docs", remember: true, outputFormat: "markdown" },
        mode: "single",
        tank: false,
      },
    );

    assert.deepEqual(
      commandToRunRequest(parseGoblinCommand("/town --tank fix docs")),
      {
        endpoint: "/api/plan",
        payload: {
          task: "fix docs",
          maxNodes: 6,
          maxReplan: 2,
          remember: true,
          outputFormat: "markdown",
        },
        mode: "town",
        tank: true,
      },
    );
  });

  it("maps slash commands to existing CLI commands", () => {
    assert.deepEqual(commandToCliArgs(parseGoblinCommand("/ask hello")), [
      "summon",
      "goblin",
      "--task",
      "hello",
      "--format",
      "markdown",
    ]);
    assert.deepEqual(commandToCliArgs(parseGoblinCommand("/town --tank hello")), [
      "plan",
      "hello",
      "--remember",
      "--format",
      "markdown",
    ]);
  });

  it("parses context ingest and search commands without forcing an AI run", () => {
    const ingest = parseGoblinCommand('/context ingest "./old conversations" --limit 12');
    assert.equal(ingest.kind, "context");
    assert.equal(ingest.task, 'ingest ./old conversations --limit 12');
    assert.deepEqual(ingest.args, ["ingest", "./old conversations", "--limit", "12"]);

    const search = parseGoblinCommand('/context search "desktop app tank"');
    assert.equal(search.kind, "context");
    assert.equal(search.task, "search desktop app tank");
    assert.deepEqual(search.args, ["search", "desktop app tank"]);
  });
});
