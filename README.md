# Goblintown

A multi-agent orchestration protocol on top of OpenAI. Goblintown turns "ask
the model" into a planning agent with memory and self-correction: a small
fleet of specialized creatures that decompose tasks into a DAG, scavenge
context, race against each other, debate, attack each other's outputs,
spawn focused specialists when the pack fails, and hand the surviving
answer back as a signed, content-addressed artifact that future rites can
build on.

## Background

In April 2026, OpenAI published [*Where the goblins came from*](https://openai.com/index/where-the-goblins-came-from/),
explaining how a reward signal trained for a "Nerdy" personality leaked
across all of GPT-5.5's outputs and produced a noticeable surge in creature
metaphors. Codex shipped with a hardcoded ban list — *goblins, gremlins,
raccoons, trolls, ogres, pigeons*.

This project takes that ban list as a roster.

## Roster

| Creature | Job |
| --- | --- |
| **Goblin** | Worker. Cheap, high-temperature, dispatched in packs. Each pack member gets a different personality; an optional debate round lets them revise after seeing each other's proposals. |
| **Gremlin** | Adversarial. Tries to break each candidate output (per-goblin chaos pass). |
| **Raccoon** | Scavenger. Returns only the facts a task actually needs. Also loads relevant prior **Artifacts** when memory is enabled. |
| **Troll** | Reviewer. Default-rejects. Returns a JSON verdict. May invoke verifier tools (`json.parse`, `regex.match`, `http.head`) before scoring. |
| **Ogre** | Heavyweight. Deep reasoning, called only when the pack and the **Specialists** both fail. |
| **Pigeon** | Carrier and **Scribe**. Compresses and routes artifacts between Warrens (federation), and distills each completed Rite into a typed Artifact (memory). |
| **Specialist Goblin** | A focused recovery worker spawned when the pack fails Troll review. Each one targets a single dominant failure mode identified by clustering the gremlin's critiques. |

A unit test pins the roster to the OpenAI ban list, so it can't drift quietly.
The Specialist is a Goblin variant — same kind, focused system prompt — so the
ban-list invariant still holds.

## Bestiary

<table>
<tr>
<td valign="top" align="center">

```
   ▄█▄        ▄█▄
   ███        ███
    ▀████████████▀
     █  ▀▄  ▄▀  █
     █   ●  ●   █
     █    ▾▾    █
     █▄▄▄▄▄▄▄▄▄▄█
      █▌ █  █ ▐█
      ▀▀ ▀  ▀ ▀▀
```

**Goblin**
</td>
<td valign="top" align="center">

```
   ▀▄ ▄▀ ▀▄ ▄▀
     ▀█▄▄█▄▄█▀
      █████████
      █ ◉   ◉ █
      █   ╳   █
      █ ╲╱╲╱╲ █
       ▀█████▀
         █ █
        ▀▀ ▀▀
```

**Gremlin**
</td>
<td valign="top" align="center">

```
    ▄█▄          ▄█▄
    ███          ███
     ▀████████████▀
     █▌ ●▔     ▔● ▐█
     █      ▾      █
     █▄▄▄▄▄▄▄▄▄▄▄▄█
     █▌█        █▐█
     ▀▀▀        ▀▀▀
```

**Raccoon**
</td>
</tr>
<tr>
<td valign="top" align="center">

```
       ▄ ▄    ▄ ▄
       █ █    █ █
     ▄████████████▄
     █  ●        ●  █
     █     ▾▾▾▾    █
     █  ──────────  █
     ████████████████
    █▌                ▐█
    █▌                ▐█
    ████          ████
```

**Troll**
</td>
<td valign="top" align="center">

```
        ▄▄▄▄▄▄▄▄▄▄
       ████████████
      ██  ▀▀    ▀▀  ██
      █     ●    ●    █
      █        ▽       █
      █▄  ▼▼▼▼▼▼▼▼  ▄█
       ████████████
      ██████████████
      ██          ██
      ██          ██
```

**Ogre**
</td>
<td valign="top" align="center">

```
       ▄██▄
      ██  ●█
      █▌    █▶▶▶
      ██████████
      █▀▀▀▀▀▀▀▀█
       ████████
          █ █
          █ █
         ▀▀ ▀▀
```

**Pigeon**
</td>
</tr>
</table>

`goblintown summon <kind>` prints the banner before each invocation. Suppress with `GOBLINTOWN_NO_BANNER=1`.

## Pipeline (the Rite)

```
  optional ─────────────────────────────────────────────────────
  ┌──────────┐                                                 │
  │ Planner  │ DAG of sub-rites, recursive replan on failure   │
  └────┬─────┘                                                 │
       ▼                                                       │
  ┌──────────┐  facts +   ┌────────────┐  N parallel ┌──────────┐
  │ Raccoon  │  prior    ▶│  Goblin    │═════════════▶│ Goblins  │
  │ + memory │  artifacts │  pack      │  (per-goblin │  output  │
  └──────────┘            │ (varied   │  personality) └────┬─────┘
                          │  pers'ty) │                    │
                          └────────────┘                   │
                                  optional debate round    │
                                  (peers see peers'        │
                                   outputs, revise) ◀──────┘
                                          │
                                          ▼
                                  ┌─────────────┐
                                  │   Gremlin   │  per-goblin
                                  │ chaos pass  │  adversarial attack
                                  └──────┬──────┘
                                         ▼
                                  ┌─────────────┐  optional
                                  │    Troll    │  verifier tool-use
                                  │   review    │  (json/regex/http)
                                  └──────┬──────┘
                                         │
                              any pass ──┴── all fail
                                  │              │
                                  │              ▼
                                  │      ┌───────────────┐
                                  │      │ Cluster fails │  identify dominant
                                  │      │ (1 LLM call)  │  failure modes
                                  │      └───────┬───────┘
                                  │              ▼
                                  │      ┌───────────────┐
                                  │      │ Specialists   │  1-3 focused
                                  │      │ + re-judge    │  recovery workers
                                  │      └───────┬───────┘
                                  │              │
                                  │      passed/  │
                                  │      improved over seed
                                  │              ▼
                                  │      ┌────────────┐
                                  │      │   Ogre     │  last resort
                                  │      │  fallback  │  (heavyweight)
                                  │      └─────┬──────┘
                                  │            │
                                  ▼            ▼
                                 winner ◀──────┘
                                    │
                                    ▼
                              ┌─────────────┐
                              │  Pigeon —   │  distills the rite into
                              │   Scribe    │  a typed Artifact (memory)
                              └─────────────┘
```

Every step writes a Loot drop to the Hoard with parent links to its inputs.
A Rite is fully reconstructible from the Hoard alone. The Pigeon-Scribe also
emits a typed **Artifact** (claims, evidence, open questions, next steps)
that future rites can cite.

## Concepts

- **Loot** — one agent invocation, content-addressed by `sha256(model || prompt || output)`.
- **Quest** — lightweight: Goblin pack + Troll arbitration.
- **Rite** — full pipeline: Raccoon → pack → (debate?) → Gremlin → Troll → Specialists → Ogre fallback → Scribe.
- **Hoard** — file-backed store under `.goblintown/hoard/`.
- **Warren** — per-project root, found by walking up from cwd.
- **Shinies** — reward signal: troll score − cross-creature drift penalty + pass bonus, clamped 0..1.
- **Drift** — cross-creature word frequency. A Goblin output mentioning *raccoons* unprompted is the signal we measure.
- **Artifact** — a typed JSON summary of a completed Rite: claims, evidence, open questions, next steps, parent-artifact links. Stored under `.goblintown/hoard/artifacts/`. Future rites can cite a prior artifact (`--cite <riteId>`) or auto-load relevant ones (`--remember`).
- **Plan** — a DAG of sub-rites the Planner emits for complex tasks. Each node carries its own `packSize`, `personality`, and `inputs` (parent nodes whose artifacts feed in). Topologically executed; on a node failure the Planner can be re-invoked with the failure context (recursive replan, max depth 2).
- **FailureCluster** — a dominant failure mode (e.g. "null-handling", "off-by-one") identified across a failed pack via a single clustering LLM call. Each cluster spawns one Specialist Goblin focused on that mode.
- **Trace** — the full run history. Exportable to the [LLM-MAS Orchestration Trace schema](https://github.com/xxzcc/awesome-llm-mas-rl/blob/main/trace-schema/trace_schema.json) via `goblintown export-trace <runId>` for compatibility with academic tooling.

## Install

```bash
npm install
npm run build
```

`OPENAI_API_KEY` must be set for any command that calls a creature.

## Usage

```bash
goblintown init

# one-shots — output streams as it arrives
goblintown summon raccoon --task "Summarize package.json" --personality stoic
goblintown summon gremlin --task "Attack this regex: /^\d+$/"

# scavenge a corpus
goblintown scavenge --task "What does the build system do?" \
  --scan "package.json" --scan "tsconfig.json" --scan "src/**/*.ts"

# pack dispatch (lightweight)
goblintown quest "Write a SQL join: users to last 5 orders" --pack 3

# full pipeline with all the trimmings
goblintown rite "Refactor src/quest.ts to share the troll-review helper" \
  --pack 3 --scan "src/quest.ts" --scan "src/troll-review.ts" \
  --debate --troll-tools --remember \
  --budget 80000 --max-output 4096

# memory: cite a prior rite or auto-load relevant artifacts
goblintown rite "Extend the migration plan with rollback paths" \
  --cite 4f2a-abc12345 --remember
goblintown ancestry <riteId>             # parents → this → children
goblintown fold --threshold 30           # compress older artifacts

# planning: decompose a complex task into a DAG of sub-rites
goblintown plan "Design and implement a small REST API for a todo list, \
  with auth, persistence, and tests" --max-nodes 6 --max-replan 2

# specialist recovery is on by default; disable / cap with:
goblintown rite "..." --no-specialist
goblintown rite "..." --specialist-cap 2

# variance comparison
goblintown reroll <riteId>
goblintown compare <riteA> <riteB>

# share / archive
goblintown export <riteId> --out my-rite.md
goblintown export-trace <runId> --out trace.json    # academic LLM-MAS schema

# observability
goblintown drift
goblintown hoard --kind goblin --since 2026-04-30 --limit 20
goblintown audit <riteId>
goblintown graph <riteId|lootId>     # now includes artifact lineage
goblintown serve --port 7777        # tank UI + SSE + plan/rite forms

# federation
goblintown send --to ../other-warren    --loot <id>
goblintown send --to https://other:7777 --loot <id>
goblintown inbox
goblintown outbox
```

## Models

Defaults: Goblin / Gremlin / Raccoon / Troll / Pigeon on `gpt-5.4-mini`,
Ogre on `gpt-5.5`. Override per creature with environment variables:

- `GOBLINTOWN_MODEL_GOBLIN`
- `GOBLINTOWN_MODEL_GREMLIN`
- `GOBLINTOWN_MODEL_RACCOON`
- `GOBLINTOWN_MODEL_TROLL`
- `GOBLINTOWN_MODEL_OGRE`
- `GOBLINTOWN_MODEL_PIGEON`

`GOBLINTOWN_MAX_CONCURRENCY` (default 5) bounds in-flight OpenAI calls.

## OpenRouter and other providers

Goblintown talks to OpenAI by default, but the underlying client is just the
`openai` SDK pointed at a base URL. Anything that exposes an OpenAI-compatible
API works — set `OPENAI_BASE_URL` and use the matching `OPENAI_API_KEY`.

### OpenRouter

```bash
export OPENAI_API_KEY="sk-or-v1-..."
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"

# Optional analytics headers shown on https://openrouter.ai/activity
export OPENROUTER_REFERER="https://github.com/yourname/yourproject"
export OPENROUTER_TITLE="Goblintown"
```

That's enough to run with the default models. When `OPENAI_BASE_URL` points
at OpenRouter, any `GOBLINTOWN_MODEL_*` value without a `/` is auto-namespaced
to `openai/`, so the built-in defaults (`gpt-5.4-mini` for the pack, `gpt-5.5`
for the Ogre) become `openai/gpt-5.4-mini` / `openai/gpt-5.5` automatically.

Override per creature to mix providers — already-prefixed names are passed
through untouched:

```bash
export GOBLINTOWN_MODEL_GOBLIN="anthropic/claude-haiku-4.5"
export GOBLINTOWN_MODEL_GREMLIN="anthropic/claude-haiku-4.5"
export GOBLINTOWN_MODEL_RACCOON="google/gemini-2.5-flash"
export GOBLINTOWN_MODEL_TROLL="openai/gpt-4o-mini"
export GOBLINTOWN_MODEL_OGRE="anthropic/claude-sonnet-4.6"
export GOBLINTOWN_MODEL_PIGEON="openai/gpt-4o-mini"
```

This is the main reason to use OpenRouter: each creature can run on a
different vendor without managing multiple API keys.

### Other OpenAI-compatible endpoints

```bash
# Groq
export OPENAI_BASE_URL="https://api.groq.com/openai/v1"

# Together AI
export OPENAI_BASE_URL="https://api.together.xyz/v1"

# Local Ollama (any non-empty key works)
export OPENAI_API_KEY="ollama"
export OPENAI_BASE_URL="http://localhost:11434/v1"

# LM Studio
export OPENAI_BASE_URL="http://localhost:1234/v1"
```

### Reasoning models

`gpt-5*`, `o*`, `deepseek-r*`, and any model whose name ends in `-thinking`
are detected automatically and switched to `max_completion_tokens` with no
`temperature` parameter. The detection strips an OpenRouter `vendor/` prefix,
so `openai/o3-mini` is handled the same as `o3-mini`.

## Reward plugins

Drop a `.goblintown/reward.mjs` in your Warren to override the default scoring:

```js
export default function (loot, verdict) {
  return verdict.passed ? 0.8 + (1 - loot.drift.driftRate) * 0.2 : verdict.score * 0.5;
}
```

The result is clamped to `[0, 1]`.

## Federation

`goblintown send` writes to another Warren's inbox over the filesystem
(`--to <path>`) or HTTP (`--to https://...`). Messages carry a content
signature; if both Warrens set `peerSecret` in their manifests, an HMAC tag
is also required.

## Browser-driven rites (SSE)

`goblintown serve` exposes `/rite/new` — an HTML form that POSTs to
`/api/rite` and subscribes to `/api/rite/<runId>/stream` for live progress.
Run state is persisted to `.goblintown/runs/<runId>.json`, so the SSE
history replays after a server restart; in-flight rites are marked
interrupted on boot.

## Layout

```
.goblintown/
  warren.json
  reward.mjs                # optional reward plugin
  hoard/
    loot/<id>.json
    quests/<id>.json
    rites/<id>.json
    artifacts/<id>.json     # Phase 1 typed artifacts (Pigeon-Scribe)
    inbox/<id>.json
    outbox/<id>.json
  runs/<runId>.json         # SSE-streamed run state (rite or plan)
```

## HTTP API

| Method | Path                              | Purpose |
| ---    | ---                               | --- |
| GET    | `/`                               | The Tank — live diorama UI; takes `?run=<runId>` to attach to an existing run |
| GET    | `/rite/new`                       | Plain HTML rite form (legacy) |
| GET    | `/rite/:id`                       | Rite detail page (now includes artifact lineage) |
| GET    | `/quest/:id`                      | Quest detail |
| GET    | `/loot/:id`                       | Single Loot detail |
| GET    | `/drift`                          | Aggregate drift report |
| GET    | `/runs`                           | List of all SSE runs (each runId links back to the Tank) |
| GET    | `/inbox`, `/outbox`               | Federation message lists |
| POST   | `/api/rite`                       | Start a rite, returns `{ runId }` |
| POST   | `/api/plan`                       | Start a planner-driven multi-step run, returns `{ runId }` |
| GET    | `/api/rite/:runId/stream`         | SSE stream of `RiteStep` + plan events; emits `replay-end` after history |
| GET    | `/api/runs`                       | JSON list of run records |
| GET    | `/api/runs/:runId`                | JSON single run record |
| GET    | `/api/loot/:id`                   | JSON loot |
| GET    | `/api/artifact/:id`               | JSON artifact |
| GET    | `/api/rite/:id/artifact`          | JSON artifact for a given rite |
| GET    | `/api/artifacts?limit=N`          | JSON list of artifacts (most recent first) |
| GET    | `/api/warren/stats`               | `{ loot, rites, drift }` for the tier indicator |
| GET    | `/api/trace/:runId`               | Run as an LLM-MAS Orchestration Trace |
| POST   | `/api/inbox`                      | Federation receiver |

## Tests

```bash
npm test
```

184 tests, no OpenAI calls. Pure-function coverage across drift, reward,
Hoard content-addressing, federation signatures (incl. HMAC), audit
aggregation, reward plugin loader, graph rendering, concurrency semaphore,
budget tracker, run persistence, markdown export, rite comparison, plus the
newer subsystems: artifact retrieval and JSON parsing, specialist failure
clustering, planner DAG validation and topological order, debate prompt
construction, verifier tool dispatch, embeddings ranking math (cosine, RRF
fusion), context-folding clustering, and trace-export schema mapping.

## Phases

Goblintown shipped in six phases on top of the original race-and-judge
pipeline. Each one composes with the others and is independently testable.

| # | Capability | What it adds | Opt-in flag |
| --- | --- | --- | --- |
| 1 | **Memory** (typed Artifacts) | Pigeon-Scribe distills every Rite into a structured JSON artifact (claims, evidence, open questions, next steps). Future rites cite or auto-load relevant artifacts. | `--cite <riteId>`, `--remember` |
| 1.5 | **Trace export** | Exports any run to the academic LLM-MAS Orchestration Trace schema (10 event types, 8 edge types, topology classification). | `goblintown export-trace` |
| 2 | **Specialist recovery** | When the goblin pack all-fails Troll review, cluster the failure modes (1 LLM call), spawn 1-3 focused Specialist Goblins that take the best seed and surgically fix one mode each, then re-judge. Only escalates to the Ogre if specialists also fail. | on by default; disable with `--no-specialist` |
| 3 | **Planning** (DAG of sub-rites) | Planner emits a typed DAG; topological executor runs each node as a sub-rite, feeding parent artifacts forward; recursive replan on node failure (max depth 2). Each node carries its own `packSize` and `personality` (dynamic spawning). | `goblintown plan "<task>"`, `▶ PLAN` button |
| 4 | **Inter-agent debate** | After the initial pack proposes, run one debate round where each goblin sees the others' outputs and may revise. Replaces the originals so downstream stages judge the post-debate version. Closes the O3 (communication) gap from the LLM-MAS-RL survey. | `--debate` |
| 5 | **Verifier-as-reward** (Troll tools) | Optional tool-use round during Troll review: built-in `json.parse`, `regex.match`, and (network-gated) `http.head`. Tool results are fed back to the verdict prompt for stronger ground-truth signal. | `--troll-tools` |
| 6 | **Polish** | OpenAI-embeddings-based artifact retrieval with reciprocal-rank-fusion fallback to keywords; context-folding (`goblintown fold`) merges related older artifacts into higher-level summaries; `audit` and `graph` walk the artifact lineage across rites. | (transparent) |

The Tank (`goblintown serve`) renders all of this as a tamagotchi-style live
village: each creature has a home (cave, perch, bridge, dump pile,
workshop), tokens stream into per-creature thinking bubbles, the DAG panel
lights up node-by-node during a plan, and the result panel slides up at
the end with the actual winning output.

## Research foundations

Goblintown is an engineering project, not a research paper, but the design
of Phases 1–6 is opinionated by what's working in current LLM multi-agent
systems work. We deliberately stay in the **prompted, training-free** slice
of the literature so everything runs with just an OpenAI-compatible API key.

The following references were the most direct influences on the architecture.

[1] **OpenAI**, *Where the goblins came from* (April 2026). The roster
(goblin / gremlin / raccoon / troll / ogre / pigeon) is taken straight from
the hardcoded ban list described in this postmortem.
<https://openai.com/index/where-the-goblins-came-from/>

[2] **Nielsen, S., Cetin, E., Schwendeman, P., Sun, Q., Xu, J., Tang, Y.**
*Learning to Orchestrate Agents in Natural Language with the Conductor.*
arXiv:2512.04388 (2025). The Conductor is RL-trained, but its ideas of
*dynamic topology selection* and *recursive-self-as-worker* are stolen here
as prompted heuristics inside the Planner (Phase 3) and the recursive
replan loop in `plan-executor.ts`.

[3] **Zhou, & Chan.** *ADEMA: Knowledge-State Orchestration for
Long-Horizon Synthesis.* arXiv:2604.25849 (2026). Goblintown's typed
Artifact (Phase 1) is a direct adaptation of ADEMA's "epistemic
bookkeeping": every rite emits structured claims, evidence, open
questions, and next steps that the next rite consumes.

[4] **Saeidi, et al.** *FAMA: Failure-Aware Meta-Agentic Framework.*
arXiv:2604.25135 (2026). The Specialist re-rite layer (Phase 2) follows
FAMA's pattern of analyzing failure trajectories and spawning a minimal
specialist that targets the dominant error, rather than rolling a fresh
pack or jumping straight to a heavyweight model.

[5] **Parmar.** *MCP Workflow Engine: Separating Intelligence from
Execution.* arXiv:2605.00827 (2026). The plan-then-execute split (Phase 3)
— a single LLM emits a declarative DAG, then a deterministic engine walks
it — comes from this paper. We use prompting where MCP-Workflow uses a
formal protocol, but the shape is the same.

[6] **Zou, J., et al.** *Latent Collaboration in Multi-Agent Systems.*
arXiv:2511.20639 (2025). The optional debate round (Phase 4) is inspired
by this training-free latent-space-communication result; we surface it as
an explicit prompted exchange where each goblin sees its peers' outputs
before revising. This was the only debate paper in our survey that
reported a meaningful gain without any fine-tuning.

[7] **Peng, Z., et al.** *CriticLean: Critic-Guided Reinforcement Learning
for Mathematical Formalization.* arXiv:2507.06181 (2025). The
verifier-as-reward pattern in the Troll's tool-use round (Phase 5) — using
a deterministic verifier to ground a critic's score — comes from
CriticLean's RL setup, applied here as plain tool-calling.

[8] **xxzcc.** *Awesome LLM-MAS RL — Curated paper list, paper-pool
artifact, and trace schema for Reinforcement Learning over LLM-based
Multi-Agent Systems through Orchestration Traces.*
<https://github.com/xxzcc/awesome-llm-mas-rl> (May 2026). The survey's
**five orchestration sub-decisions** (spawn / delegate / communicate /
aggregate / stop) were the diagnostic that surfaced goblintown's biggest
gap: agents weren't communicating with each other. That directly motivated
Phase 4 (debate). The repo's **JSON Schema for orchestration traces** is
adopted as goblintown's `goblintown export-trace` output format (Phase
1.5), so traces are interoperable with any tooling built around it.

### Out of scope (deliberately)

The bulk of the LLM-MAS-RL literature uses post-training methods (MAGRPO,
MARFT, MAPoRL, Dr. MAS, SHARP, DEPART, MarsRL, MALT, MARSHAL, SPIRAL, …).
These produce stronger orchestrators in benchmark settings but require
GPUs, datasets, and RL infrastructure. Goblintown is built for engineers
shipping multi-agent features on existing API endpoints, so we cite these
methods as inspiration where their ideas survive the prompting-only
constraint, and skip them otherwise.

## Citing goblintown

If you reference this project in academic work, please cite the repository
directly. Suggested BibTeX:

```bibtex
@software{goblintown,
  author  = {0XBL33P},
  title   = {Goblintown: a planning multi-agent orchestration protocol on top of OpenAI},
  year    = {2026},
  url     = {https://github.com/0XBL33P/goblintown}
}
```

## License

MIT — see [LICENSE](./LICENSE).
