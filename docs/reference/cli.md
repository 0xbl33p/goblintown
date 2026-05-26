# CLI Reference

The CLI is the boring door into the strange house. It is useful for automation,
local development, and checking what the browser UI is doing underneath.

## Basics

```bash
goblintown init
goblintown serve --port 7777
goblintown cloud
```

## Goblin Mode Slash Commands

```bash
goblintown /ask "Write the shortest useful answer"
goblintown /town "Plan and implement the feature"
goblintown /tank "Debug this with the visual Tank"
goblintown /context ingest "./old-conversations"
goblintown /context search "desktop app tank"
goblintown /history
```

## Single Creatures

```bash
goblintown summon raccoon --task "Summarize package.json" --personality stoic
goblintown summon gremlin --task "Attack this regex: /^\\d+$/"
```

## Context

```bash
goblintown scavenge --task "What does the build system do?" \
  --scan "package.json" --scan "tsconfig.json" --scan "src/**/*.ts"

goblintown context ingest ./notes --limit 40
goblintown context search "rollback paths"
goblintown context scan chats --source codex --limit 20
goblintown context import chats --source chatgpt --path ./conversations.json --all
goblintown context vectorize --missing-only
```

## Pack And Rite

```bash
goblintown quest "Write a SQL join: users to last 5 orders" --pack 3

goblintown rite "Refactor src/quest.ts to share the troll-review helper" \
  --pack 3 --scan "src/quest.ts" --scan "src/troll-review.ts" \
  --debate --troll-tools --remember \
  --budget 80000 --max-output 4096 --format markdown

goblintown rite "..." --no-specialist
goblintown rite "..." --specialist-cap 2
```

## Planning

```bash
goblintown plan "Design and implement a small REST API for a todo list" \
  --max-nodes 6 --max-replan 2 --format json
```

## Memory And Graphs

```bash
goblintown ancestry <riteId>
goblintown fold --threshold 30
goblintown reroll <riteId>
goblintown compare <riteA> <riteB>
goblintown export <riteId> --out my-rite.md
goblintown export-trace <runId> --out trace.json
goblintown drift
goblintown hoard --kind goblin --since 2026-04-30 --limit 20
goblintown audit <riteId>
goblintown graph <riteId|lootId>
```

## Providers

```bash
goblintown route
goblintown route set goblin --preset ollama --model gemma3:27b
goblintown route set ogre --preset openai --model gpt-5.5
goblintown route clear goblin
```

## Add-ons, Thesis, Sentiment

```bash
goblintown addon ls
goblintown addon enable solana
goblintown addon solana <address>
goblintown addon solana tx <signature>

goblintown thesis "Jito" --solana <address> --remember

goblintown sentiment sources
goblintown sentiment market
goblintown sentiment project "Jito"
goblintown sentiment key set coingecko --value <secret>
goblintown sentiment key clear coingecko
```

## Federation And Country

```bash
goblintown send --to ../other-warren --loot <id>
goblintown send --to https://other:7777 --loot <id>
goblintown inbox
goblintown outbox

goblintown country peer add --name alpha --url http://localhost:7777
goblintown country peer add --name beta --url http://localhost:8888
goblintown country peer ls
goblintown country show
goblintown country set --enabled true --backend local --discoverable true
goblintown country discover
goblintown country discover --code A7K2Q
goblintown country join --country-id <id> --country-code <code> --target-url <url>
goblintown country requests ls
goblintown country requests approve <requestId>
goblintown country run --task "Audit this migration plan" --all --pack 2
```

## Environment

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Default hosted provider key. |
| `OPENAI_BASE_URL` | OpenAI-compatible base URL override. |
| `OPENROUTER_API_KEY` | OpenRouter key. |
| `GROQ_API_KEY` | Groq key. |
| `TOGETHER_API_KEY` | Together AI key. |
| `MISTRAL_API_KEY` | Mistral key. |
| `DEEPSEEK_API_KEY` | DeepSeek key. |
| `ANTHROPIC_API_KEY` | Anthropic key. |
| `GEMINI_API_KEY` | Gemini key. |
| `GOBLINTOWN_MODEL_GOBLIN` | Goblin model override. |
| `GOBLINTOWN_MODEL_OGRE` | Ogre model override. |
| `GOBLINTOWN_MODEL_TROLL` | Troll model override. |
| `GOBLINTOWN_MODEL_SCRIBE` | Pigeon-Scribe model override. |
| `GOBLINTOWN_EMBEDDING_MODEL` | Artifact embedding model. |
| `GOBLINTOWN_TOOLS_HTTP` | Set `1` to enable `http.head`. |
| `GOBLINTOWN_TOOLS_SOLANA` | Set `1` to enable Solana tools without editing `warren.json`. |
| `GOBLINTOWN_SOLANA_RPC_URL` | Solana RPC endpoint. |
| `GOBLINTOWN_MAX_CONCURRENCY` | In-flight model call cap. |
| `GOBLINTOWN_SERVER_URL` | Default country server URL. |
