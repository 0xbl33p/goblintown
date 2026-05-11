export function buildCliHelp(creatureKinds: readonly string[]): string {
  return `Goblintown — agent management protocol.

Usage:
  goblintown init
      Initialize a Warren in the current directory.

  goblintown summon <kind> --task "..." [--personality <p>]
      Run a single creature once. Output goes to stdout; loot is stashed.
      Kinds: ${creatureKinds.join(" ")}

  goblintown scavenge --task "..." --scan "<glob>" [--scan "<glob>"]...
      Run a Raccoon over matched files and stash the distilled facts.

  goblintown quest "<task>" [--pack <N>] [--personality <p>] [--format freeform|markdown|json]
      Goblin pack with Troll arbitration. Default pack=3. Lightweight.

  goblintown rite "<task>" [--pack <N>] [--scan <glob>]... [--personality <p>] [--no-fallback]
                          [--budget <tokens>] [--max-output <tokens>]
                          [--cite <riteId>]... [--remember]
                          [--no-specialist] [--specialist-cap <N>] [--debate]
                          [--format freeform|markdown|json]
      Full ceremony: Raccoon → Goblin pack → [Debate round] → Gremlin chaos →
                    Troll review → [Specialist re-rite on failure] →
                    Ogre fallback → Scribe.
      --cite <riteId>:    load that rite's Artifact as prior context.
      --remember:         auto-load up to 3 most-relevant prior Artifacts.
      --no-specialist:    skip the specialist recovery layer (go straight to Ogre).
      --specialist-cap N: max specialist goblins to spawn (default 3).
      --debate:           run an inter-agent debate round after the pack proposes.
      --troll-tools:      enable verifier tool-use during troll review (json/regex/http.head).

  goblintown ancestry <riteId>
      Print the artifact lineage for a rite (parents → this → children).

  goblintown plan "<task>" [--max-nodes <N>] [--max-replan <N>] [--budget <tokens>]
                          [--cite <riteId>]... [--remember] [--format freeform|markdown|json]
      Use the Planner to decompose the task into a DAG of sub-rites and
      execute them in order (Phase 3). Each sub-rite produces its own artifact;
      dependent sub-rites consume them. On a node failure the planner is
      re-invoked (recursive replan, max depth 2 by default).

  goblintown export-trace <runId> [--out <path.json>]
      Export a run as an LLM-MAS Orchestration Trace (academic schema —
      xxzcc/awesome-llm-mas-rl).

  goblintown fold [--threshold <N>] [--min-overlap <K>] [--max-cluster <S>] [--min-age-days <D>]
      Phase 6: fold related older artifacts into higher-level summary
      artifacts (Pigeon-Scribe). Defaults: threshold=30, overlap=2, max=6, age=7d.

  goblintown reset [--all|--hoard|--artifacts|--runs] [--yes]
      Reset the town. Default scope (--all) clears the entire hoard
      (loot, quests, rites, artifacts, inbox, outbox) and the SSE run
      log; preserves warren.json and reward.mjs. Asks for "RESET"
      confirmation unless --yes is passed.
      Narrower scopes:
        --hoard      everything in .goblintown/hoard/
        --artifacts  only .goblintown/hoard/artifacts/
        --runs       only .goblintown/runs/

  goblintown reroll <riteId> [--no-fallback] [--budget <tokens>]
      Re-run an existing rite with identical task / pack / personality / scan.

  goblintown export <riteId> [--out <path.md>]
      Render a Rite as a self-contained markdown document.

  goblintown compare <riteA> <riteB>
      Side-by-side comparison of two rites.

  goblintown audit <riteId>
      Walk a Rite's causal graph; report tokens, drift, longest chain, warnings.

  goblintown graph <riteId|lootId>
      Render the causal graph as ASCII (rite-shaped if it's a rite id,
      ancestry chain if it's a loot id).

  goblintown drift
      Aggregate personality-drift report across all stashed loot.

  goblintown hoard [--kind <k>] [--since <iso|ms>] [--limit <N>] [--rite <id>] [--quest <id>]
      List the contents of the Hoard, optionally filtered.

  goblintown send --to <warren-path> --loot <id> [--audience "..."]
      Pigeon-compress a Loot and deliver it to another Warren's inbox.

  goblintown inbox
      List inbox messages and verify their signatures.

  goblintown outbox
      List outbox records.

  goblintown route
      List per-creature provider routes.
  goblintown route set <slot> --preset <id> [--model <name>] [--base-url <url>] [--api-key-env <ENV>] [--format freeform|markdown|json]
      Route a specific slot (goblin/ogre/troll/.../embedding) to a provider.
  goblintown route clear <slot>|--all
      Remove route overrides.

  goblintown country peer add --name <peer> --url <http://host:port>
  goblintown country peer rm <peer>
  goblintown country peer ls
      Manage Goblin-Country peers in warren.json.
  goblintown country show
      Show current country config (backend/mode/code/discoverability/pending requests).
  goblintown country set [--enabled <true|false>] [--backend <local|firebase>] [--discoverable <true|false>]
      Update country-mode config in warren.json.
  goblintown country discover [--code <A1B2C>] [--server <http://host:port>]
      Query discoverable open countries (3 or fewer members) from a running Goblintown server.
  goblintown country join --country-id <id> --country-code <code> [--target-url <url>] [--server <http://host:port>]
      Send join request to a discovered country via server API.
  goblintown country requests ls [--server <http://host:port>]
  goblintown country requests approve <requestId> [--server <http://host:port>]
  goblintown country requests deny <requestId> [--server <http://host:port>]
      List/resolve pending join requests through server API.
  goblintown country run --task "..." [--peer <peer>]... [--all] [--pack <N>] [--format freeform|markdown|json]
      Dispatch a Rite to peer warrens and wait for completion.

  goblintown serve [--port <N>]
      Start the Hoard web UI. Default port=7777.
      Optional pigeon sprite sheets are loaded from site/assets (walk + peck).

Environment:
  OPENAI_API_KEY              required (except for init / drift / hoard / inbox / outbox / audit / graph / export / compare / ancestry)
  OPENAI_BASE_URL             optional; e.g. https://openrouter.ai/api/v1
  Provider-specific keys      OPENROUTER_API_KEY, GROQ_API_KEY, TOGETHER_API_KEY, MISTRAL_API_KEY,
                              DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY
  GOBLINTOWN_MODEL_GOBLIN     default: gpt-5.4-mini
  GOBLINTOWN_MODEL_OGRE       default: gpt-5.5
  GOBLINTOWN_MODEL_TROLL      default: gpt-5.4-mini
  GOBLINTOWN_MODEL_SCRIBE     default: gpt-5.4-mini  (Pigeon-as-Scribe artifact distillation)
  GOBLINTOWN_EMBEDDING_MODEL  default: text-embedding-3-small  (artifact retrieval, Phase 6)
  GOBLINTOWN_TOOLS_HTTP       set to 1 to enable http.head verifier tool (default disabled)
  GOBLINTOWN_MAX_CONCURRENCY  default: 5 (in-flight API calls)
  GOBLINTOWN_SERVER_URL       default base URL for country discover/join/requests commands
  (also: GREMLIN, RACCOON, PIGEON)

"OpenAI tried to put the goblins back in the box. We built the box for them."
`;
}
