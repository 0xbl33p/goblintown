# The Rite Pipeline

The Rite is Goblintown's full multi-agent path. It is a sequence of small,
named responsibilities rather than one large "agent" that does whatever the
prompt implies this week.

## Flow

```text
Planner, optional
  emits a DAG of sub-Rites
  replans after node failure

Raccoon
  scans files and prior Artifacts
  returns only task-relevant facts

Goblin pack
  drafts N candidate answers in parallel
  varies prompts and personalities

Debate, optional
  lets Goblins inspect peer drafts
  asks for one revision round

Gremlin
  attacks each candidate
  produces failure pressure

Troll
  reviews candidates
  can call verifier tools
  default posture is rejection

Specialists
  spawn only when the pack fails
  each repairs one clustered failure mode

Ogre
  heavyweight fallback
  called only when cheaper recovery fails

Pigeon-Scribe
  distills the completed Rite into a typed Artifact
```

## Core Terms

| Term | Meaning |
| --- | --- |
| Loot | One model/tool invocation, stored with prompt, output, model, usage, drift, and parent links. |
| Quest | Lightweight Goblin pack plus Troll arbitration. |
| Rite | Full pipeline: Raccoon, pack, optional debate, Gremlin, Troll, Specialists, Ogre, Scribe. |
| Artifact | Typed memory summary of a completed Rite: claims, evidence, open questions, next steps, keywords, parent links. |
| Hoard | Local file-backed store under `.goblintown/hoard/`. |
| Warren | A project root with `.goblintown/` state. |
| Plan | DAG of sub-Rites emitted by the Planner. |
| FailureCluster | A dominant failure mode found across failed Goblin candidates and Gremlin attacks. |
| Trace | Exported run record compatible with the LLM-MAS orchestration trace schema. |

## Planner

The Planner turns a complex task into a DAG. Each node is a sub-Rite with a
narrow task, optional inputs, a pack size, and a suggested personality. The
executor walks the DAG topologically. Dependent nodes receive Artifacts from
their parents.

On node failure, the Planner can be invoked again with failure context and the
partial plan. Replanning is capped so the town does not chew its own tail.

Relevant files:

- `src/planner.ts`
- `src/plan-executor.ts`

## Raccoon

The Raccoon is the context scavenger. It scans requested globs and produces a
compact facts block rather than dumping entire files into every prompt. When
memory is enabled, prior Artifacts are rendered as context before the pack
writes.

Relevant files:

- `src/scavenge.ts`
- `src/context-ingest.ts`
- `src/artifact.ts`

## Goblin Pack

The pack drafts answers in parallel. Each Goblin receives a prompt variant, and
the pack can vary personality across `nerdy`, `cynical`, `chipper`, `stoic`,
`feral`, and `goblin_mode`.

The pack is not consensus. It is variance. The Troll decides whether any
candidate survives.

Relevant files:

- `src/rite.ts`
- `src/quest.ts`
- `src/pack-prompt.ts`
- `src/creatures.ts`

## Debate

Debate is opt-in with `--debate`. After the first pack draft, each Goblin can
see peer outputs and revise once before Gremlin/Troll review. This is not a
chat room. It is a single structured revision pass.

Relevant file:

- `src/debate.ts`

## Gremlin

The Gremlin attacks each candidate. Its job is to reveal failure modes, not to
produce the final answer. The Gremlin's critique is later useful for clustering
Specialist recovery.

Relevant file:

- `src/chaos.ts`

## Troll

The Troll reviews candidate answers and emits structured verdicts. It can run
pure LLM review, or when `--troll-tools` is enabled it can call verifier tools
before scoring.

Built-in tools include:

- `json.parse`
- `regex.match`
- `http.head`, gated by `GOBLINTOWN_TOOLS_HTTP=1`
- `web.fetch` for public URL context in chat

Add-ons can contribute more tools. The bundled Solana add-on is read-only.

Relevant files:

- `src/troll-review.ts`
- `src/tools.ts`
- `src/addons.ts`

## Specialists

If every candidate fails Troll review, Goblintown clusters the dominant failure
modes and spawns one to three Specialist Goblins. Each Specialist receives one
focused repair target and the best failed seed.

Specialists are still Goblins. They keep the roster invariant while narrowing
the prompt.

Relevant file:

- `src/specialist.ts`

## Ogre

The Ogre is the expensive fallback. It runs only when the pack and Specialist
layer cannot produce an acceptable answer. The Ogre is not the default because
defaulting to the heavyweight model destroys the point of orchestration.

Relevant file:

- `src/fallback.ts`

## Pigeon-Scribe

The Pigeon-Scribe writes the durable memory object. A completed Rite can be
reconstructed from Loot, but the Artifact is what future Rites can actually use:
claims, evidence, open questions, next steps, keywords, and parent links.

Relevant files:

- `src/artifact.ts`
- `src/hoard.ts`

## Observability

Useful commands:

```bash
goblintown audit <riteId>
goblintown graph <riteId|lootId>
goblintown export <riteId> --out rite.md
goblintown export-trace <runId> --out trace.json
goblintown drift
```

Run state is persisted under `.goblintown/runs/<runId>.json`, so the browser UI
can replay history after restart and mark interrupted work honestly.
