# Goblintown Mode

Goblintown mode is the full town: multi-agent work with context, review,
recovery, memory, and resumable run state.

## Entry Points

CLI:

```bash
goblintown rite "Audit this migration plan" --pack 3 --remember --debate --troll-tools
goblintown plan "Design the feature and split it into buildable slices" --max-nodes 6
```

Browser:

- root app at `/`
- `/tank`
- `POST /api/rite`
- `POST /api/plan`
- `GET /api/rite/:runId/stream`

MCP:

- `goblintown_tank` launches or reuses the local Tank in AI-autopilot mode and
  returns the URL. Codex should call it first when the plugin is selected.
- `goblintown_rite` and `goblintown_plan` default to harness execution. The
  sidecar configures the rite/plan and the connected harness spends its own
  model tokens.
- Use `executionMode: "local_provider"` only when the user wants the local Tank
  and configured provider to execute the model calls.

## Rite Mode

A Rite runs the pipeline directly against one task. Useful flags:

```bash
--pack <N>
--scan <glob>
--personality <name>
--cite <riteId>
--remember
--debate
--troll-tools
--no-specialist
--specialist-cap <N>
--budget <tokens>
--max-output <tokens>
--format freeform|markdown|json
```

## Plan Mode

Plan mode asks the Planner to decompose a task into a DAG of sub-Rites. Each
node writes its own Artifact; dependent nodes receive parent Artifacts as
context.

```bash
goblintown plan "Build a small authenticated API with tests" \
  --max-nodes 6 \
  --max-replan 2 \
  --remember \
  --format markdown
```

## Tank And Run State

Runs are written to `.goblintown/runs/<runId>.json`. The browser stream can
replay history, attach `/tank?run=<runId>` to an existing run, and mark
in-flight runs interrupted after server restart.

The UI keeps work surfaces close:

- chats;
- Rites;
- provider settings;
- local/cloud mode;
- add-ons;
- onchain lookup;
- country collaboration;
- mail;
- reset controls.

The point is not spectacle. The point is that a run has visible state, causality,
and an answer that can be inspected after the moment passes.
