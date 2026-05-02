# Goblintown

A multi-agent orchestration protocol on top of OpenAI. Goblintown turns "ask
the model" into a small fleet of specialized agents that scavenge context,
race against each other on the same task, attack each other's outputs, and
hand the surviving answer back as a signed, content-addressed artifact.

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
| **Goblin** | Worker. Cheap, high-temperature, dispatched in packs. |
| **Gremlin** | Adversarial. Tries to break a candidate output. |
| **Raccoon** | Scavenger. Returns only the facts a task actually needs. |
| **Troll** | Reviewer. Default-rejects. Returns a JSON verdict. |
| **Ogre** | Heavyweight. Deep reasoning, called when the pack fails. |
| **Pigeon** | Carrier. Compresses and routes artifacts between Warrens. |

A unit test pins the roster to the OpenAI ban list, so it can't drift quietly.

## Bestiary

```
   ▄█▄        ▄█▄              ▀▄ ▄▀ ▀▄ ▄▀
   ███        ███                 ▀█▄▄█▄▄█▀
    ▀████████████▀                 █████████
     █  ▀▄  ▄▀  █                  █ ◉   ◉ █
     █   ●  ●   █                  █   ╳   █
     █    ▾▾    █                  █ ╲╱╲╱╲ █
     █▄▄▄▄▄▄▄▄▄▄█                   ▀█████▀
      █▌ █  █ ▐█                      █ █
      ▀▀ ▀  ▀ ▀▀                     ▀▀ ▀▀
        Goblin                        Gremlin


    ▄█▄          ▄█▄          ▄ ▄    ▄ ▄
    ███          ███           █ █    █ █
     ▀████████████▀          ▄████████████▄
     █▌ ●▔     ▔● ▐█         █  ●        ●  █
     █      ▾      █         █     ▾▾▾▾    █
     █▄▄▄▄▄▄▄▄▄▄▄▄█          █  ──────────  █
     █▌█        █▐█          ████████████████
     ▀▀▀        ▀▀▀         █▌                ▐█
        Raccoon              █▌                ▐█
                             ████          ████
                                  Troll


        ▄▄▄▄▄▄▄▄▄▄              ▄██▄
       ████████████             ██  ●█
      ██  ▀▀    ▀▀  ██          █▌    █▶▶▶
      █     ●    ●    █         ██████████
      █        ▽       █        █▀▀▀▀▀▀▀▀█
      █▄  ▼▼▼▼▼▼▼▼  ▄█           ████████
       ████████████                 █ █
      ██████████████                █ █
      ██          ██               ▀▀ ▀▀
            Ogre                    Pigeon
```

`goblintown summon <kind>` prints the banner before each invocation. Suppress with `GOBLINTOWN_NO_BANNER=1`.

## Pipeline (the Rite)

```
  ┌──────────┐   facts   ┌────────────┐  N parallel  ┌──────────┐
  │ Raccoon  │──────────▶│  Goblin    │═════════════▶│ Goblins  │
  │ (optional│           │  pack      │              │  output  │
  │  scan)   │           └────────────┘              └────┬─────┘
  └──────────┘                                            │
                                                          ▼
                                                  ┌─────────────┐
                                                  │   Gremlin   │
                                                  │ chaos pass  │
                                                  └──────┬──────┘
                                                         ▼
                                                  ┌─────────────┐
                                                  │    Troll    │
                                                  │   review    │
                                                  └──────┬──────┘
                                                         │
                                              any pass ──┴── all fail
                                                  │             │
                                                  ▼             ▼
                                            ┌────────┐    ┌──────────┐
                                            │ winner │    │   Ogre   │
                                            │  loot  │    │ fallback │
                                            └────────┘    └──────────┘
```

Every step writes a Loot drop to the Hoard with parent links to its inputs.
A Rite is fully reconstructible from the Hoard alone.

## Concepts

- **Loot** — one agent invocation, content-addressed by `sha256(model || prompt || output)`.
- **Quest** — lightweight: Goblin pack + Troll arbitration.
- **Rite** — full pipeline: Raccoon → pack → Gremlin → Troll → Ogre fallback.
- **Hoard** — file-backed store under `.goblintown/hoard/`.
- **Warren** — per-project root, found by walking up from cwd.
- **Shinies** — reward signal: troll score − cross-creature drift penalty + pass bonus, clamped 0..1.
- **Drift** — cross-creature word frequency. A Goblin output mentioning *raccoons* unprompted is the signal we measure.

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

# full pipeline with a budget cap
goblintown rite "Refactor src/quest.ts to share the troll-review helper" \
  --pack 3 --scan "src/quest.ts" --scan "src/troll-review.ts" \
  --budget 80000 --max-output 4096

# variance comparison
goblintown reroll <riteId>
goblintown compare <riteA> <riteB>

# share / archive
goblintown export <riteId> --out my-rite.md

# observability
goblintown drift
goblintown hoard --kind goblin --since 2026-04-30 --limit 20
goblintown audit <riteId>
goblintown graph <riteId|lootId>
goblintown serve --port 7777    # web UI + SSE rite form

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
  reward.mjs           # optional reward plugin
  hoard/
    loot/<id>.json
    quests/<id>.json
    rites/<id>.json
    inbox/<id>.json
    outbox/<id>.json
  runs/<runId>.json    # SSE-streamed rite-run state
```

## HTTP API

| Method | Path                          | Purpose |
| ---    | ---                           | --- |
| GET    | `/`                           | Hoard overview |
| GET    | `/rite/new`                   | Browser form |
| GET    | `/rite/:id`                   | Rite detail |
| GET    | `/quest/:id`                  | Quest detail |
| GET    | `/loot/:id`                   | Single Loot detail |
| GET    | `/drift`                      | Aggregate drift report |
| GET    | `/runs`                       | List of all SSE runs |
| GET    | `/inbox`, `/outbox`           | Federation message lists |
| POST   | `/api/rite`                   | Start a rite, returns `{ runId }` |
| GET    | `/api/rite/:runId/stream`     | SSE stream of `RiteStep` events |
| GET    | `/api/runs`                   | JSON list of run records |
| POST   | `/api/inbox`                  | Federation receiver |

## Tests

```bash
npm test
```

Pure-function coverage across drift, reward, Hoard content-addressing,
federation signatures (incl. HMAC), audit aggregation, reward plugin loader,
graph rendering, concurrency semaphore, budget tracker, run persistence,
markdown export, and rite comparison. No OpenAI calls.

## License

MIT — see [LICENSE](./LICENSE).
