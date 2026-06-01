<p align="center">
  <img src="site/assets/gtownlogo.svg" alt="Goblintown" width="820">
</p>

# Goblintown

Goblintown is an agent-first, model-augmentable orchestration tool compatible
with most front ends. The same core can mount behind Codex today, the shipped
desktop beta shell, the ChatGPT App dev preview, and later host adapters that
need a Tank, local memory, provider setup, imports, live run inspection, and
auditable artifacts. Start with a single fast answer, then summon the full
**town** when the work needs planning, memory, tools, debate, critique, and
saved artifacts.

Model-augmentable means the front end can carry the model work with its own
tokens by default, while the local Tank and configured provider can execute only
when the user explicitly chooses that path.

The core is a planning multi-agent orchestrator: **Single Goblin** mode
is one worker and one answer; **Goblintown** mode turns the prompt into a small
fleet of specialized creatures that decompose the task into a DAG, scavenge
context, race and debate, attack each other's outputs, spawn focused specialists
when the pack fails, and hand back a signed, content-addressed artifact that
future runs can build on.

Current distribution lines:

| Distribution | Version | Status | Front end / adapter |
| --- | --- | --- | --- |
| Goblintown Codex Plugin | 1.0 | Current | Codex composer plugin, skill, local stdio MCP, AI-autopilot Tank |
| Goblintown Desktop | Beta 0.1 | Shipped | Desktop shell for macOS DMG, Windows installer, Linux AppImage |
| Goblintown ChatGPT App | 1.0 | Dev preview | ChatGPT Apps SDK MCP adapter, Streamable HTTP endpoint, Tank widget resource |

Next front-end adapters should get their own lane and name:

- Goblintown Hermes App
- Goblintown Opencode App
- Goblintown OpenGPT App
- Goblintown Claude Code App

Other harnesses should follow the same pattern when they need the Tank.

## Download

**Desktop Beta 0.1.** One-click installers, no build step. The app
launches into the sidecar control room and walks you through provider setup,
imports, local memory, and optional features.

| Platform | Installer |
| --- | --- |
| macOS (Apple Silicon) | [Goblintown-0.7.0-beta.1-mac-arm64.dmg](https://github.com/0xbl33p/goblintown/releases/download/v0.7.0-beta.1/Goblintown-0.7.0-beta.1-mac-arm64.dmg) |
| macOS (Intel) | [Goblintown-0.7.0-beta.1-mac-x64.dmg](https://github.com/0xbl33p/goblintown/releases/download/v0.7.0-beta.1/Goblintown-0.7.0-beta.1-mac-x64.dmg) |
| Windows (x64) | [Goblintown-0.7.0-beta.1-win-x64.exe](https://github.com/0xbl33p/goblintown/releases/download/v0.7.0-beta.1/Goblintown-0.7.0-beta.1-win-x64.exe) |
| Windows (ARM64) | [Goblintown-0.7.0-beta.1-win-arm64.exe](https://github.com/0xbl33p/goblintown/releases/download/v0.7.0-beta.1/Goblintown-0.7.0-beta.1-win-arm64.exe) |
| Linux (x86_64) | [Goblintown-0.7.0-beta.1-linux-x86_64.AppImage](https://github.com/0xbl33p/goblintown/releases/download/v0.7.0-beta.1/Goblintown-0.7.0-beta.1-linux-x86_64.AppImage) |
| Linux (ARM64) | [Goblintown-0.7.0-beta.1-linux-arm64.AppImage](https://github.com/0xbl33p/goblintown/releases/download/v0.7.0-beta.1/Goblintown-0.7.0-beta.1-linux-arm64.AppImage) |

macOS: open the DMG, drag Goblintown to Applications, launch. Windows: run the
installer (Start Menu + Desktop shortcuts are created). Linux: mark the AppImage
executable and run it. Desktop Beta 0.1 currently uses the historical
`v0.7.0-beta.1` release tag and asset filenames; all downloads are on the
[v0.7.0-beta.1 release](https://github.com/0xbl33p/goblintown/releases/tag/v0.7.0-beta.1);
verify with the published `SHA256SUMS.txt`.

> These beta packages are not yet code-signed. macOS may require right-click →
> Open or a Privacy & Security approval; Windows may show a SmartScreen "More
> info → Run anyway" prompt. Signed and notarized builds will replace them.

**npm.** If you'd rather run from the command line or embed Goblintown in your
own tooling:

```bash
npm install -g goblintown
goblintown serve        # opens the GUI at http://localhost:7777/
```

**Codex Plugin 1.0.** Codex is the first front-end adapter for the orchestration
core. To let Codex call Goblintown directly, use the simple installer:

```bash
npx -y goblintown@latest install
```

`install` creates or finds a Warren, installs Goblintown Codex Plugin 1.0 into
`~/plugins/goblintown`, adds it to `~/.agents/plugins/marketplace.json`, runs
`codex plugin add goblintown@personal`, installs the `goblintown-sidecar` skill,
registers the local MCP server, and starts the Tank in AI-autopilot mode at
`http://localhost:7777`. Restart Codex after plugin, skill, or MCP installs so
the composer `+` menu and local tools reload.

For granular setup or troubleshooting, the installer is equivalent to:

```bash
npx -y goblintown@latest plugin install
npx -y goblintown@latest skill install
npx -y goblintown@latest mcp --install-codex
npx -y goblintown@latest mcp --doctor
```

`--install-codex` adds or updates the local Codex Desktop config and leaves a
backup when it changes an existing file. The TOML block it manages is:

```toml
[mcp_servers.goblintown]
command = "npx"
args = ["-y", "goblintown@latest", "mcp"]
```

For MCP clients that expect JSON, the equivalent local stdio config is:

```json
{
  "mcpServers": {
    "goblintown": {
      "command": "npx",
      "args": ["-y", "goblintown@latest", "mcp"]
    }
  }
}
```

`mcp --doctor` reports `ok: true` when the package can be used as an MCP
sidecar. Project Warrens still win: if the current folder or one of its parents
has `.goblintown/warren.json`, Goblintown operates there. If no project Warren
is found, the MCP uses or creates a Codex-local global Warren at
`${CODEX_HOME:-$HOME/.codex}/goblintown`, so Codex can run rites from any
thread. Run `goblintown init` inside a project when you want the rite, Hoard,
and provider settings to stay project-bound.

The sidecar exposes `goblintown_tank` to launch or reuse the local Tank in
AI-autopilot mode, `goblintown_chat` for Single Goblin, `goblintown_rite` to
configure the full pack for the current harness, `goblintown_plan` to configure
planner DAG work, `goblintown_provider` for model-route inspection, and
`goblintown_doctor` for setup checks. When the plugin is selected from Codex,
the agent should call `goblintown_tank` first so the user lands in the Tank
right away. Rite and plan tools default to harness execution so Codex or another
connected client spends its own model tokens; pass
`executionMode: "local_provider"` only when you want the local Tank and
configured provider to run the model calls. It runs on the user's machine;
imported chats and Hoard artifacts stay local unless you choose to move them.

**ChatGPT App 1.0.** The ChatGPT adapter is a dev preview for ChatGPT Developer
Mode. It serves a Streamable HTTP MCP endpoint at `/mcp`, advertises the same
tool semantics as Codex Plugin 1.0, and includes a Tank widget resource at
`ui://goblintown/tank.html`.

```bash
npx -y goblintown@latest chatgpt install
```

That one command starts the adapter, opens the walkthrough page, creates a quick
HTTPS tunnel for ChatGPT, and prints the `/mcp` URL to paste into ChatGPT
Developer Mode. Keep the terminal open while using the app.

For local development:

```bash
npm run chatgpt
# or:
goblintown chatgpt serve --port 8787 --public-base-url https://your-tunnel.example
```

Use the public HTTPS `/mcp` URL in ChatGPT Developer Mode. Rite and plan tools
still configure work for the ChatGPT harness by default; choose
`executionMode: "local_provider"` only when you want local provider spend. The
adapter package lives in `apps/chatgpt/`.

## Background

In April 2026, OpenAI published [*Where the goblins came from*](https://openai.com/index/where-the-goblins-came-from/),
explaining how a reward signal trained for a "Nerdy" personality leaked across
all of GPT-5.5's outputs and produced a noticeable surge in creature metaphors.
Codex shipped with a hardcoded ban list — *goblins, gremlins, raccoons, trolls,
ogres, pigeons*.

This project takes that ban list as a roster.

## Roster

| Creature | Job |
| --- | --- |
| **Goblin** | Worker. Cheap, high-temperature, dispatched in packs. Each pack member gets a different personality; an optional debate round lets them revise after seeing each other's proposals. |
| **Gremlin** | Adversarial. Tries to break each candidate output (per-goblin chaos pass). |
| **Raccoon** | Scavenger. Returns only the facts a task actually needs. Also loads relevant prior **Artifacts** when memory is enabled. |
| **Troll** | Reviewer. Default-rejects. Returns a JSON verdict. May invoke verifier tools (`json.parse`, `regex.match`, `http.head`, and enabled add-on tools) before scoring. |
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
emits a typed **Artifact** (claims, evidence, open questions, next steps) that
future rites can cite.

## Concepts

- **Loot** — one agent invocation, content-addressed by `sha256(model || prompt || output)`.
- **Quest** — lightweight: Goblin pack + Troll arbitration.
- **Rite** — full pipeline: Raccoon → pack → (debate?) → Gremlin → Troll → Specialists → Ogre fallback → Scribe.
- **Hoard** — file-backed store under `.goblintown/hoard/`.
- **Warren** — per-project root, found by walking up from cwd.
- **Shinies** — reward signal: troll score − cross-creature drift penalty + pass bonus, clamped 0..1.
- **Drift** — cross-creature word frequency. A Goblin output mentioning *raccoons* unprompted is the signal we measure.
- **Artifact** — a typed JSON summary of a completed Rite: claims, evidence, open questions, next steps, parent-artifact links. Stored under `.goblintown/hoard/artifacts/`. Future rites can cite a prior artifact or auto-load relevant ones.
- **Plan** — a DAG of sub-rites the Planner emits for complex tasks. Topologically executed; on a node failure the Planner can be re-invoked with the failure context (recursive replan, max depth 2).
- **Trace** — the full run history, exportable to the [LLM-MAS Orchestration Trace schema](https://github.com/xxzcc/awesome-llm-mas-rl) for compatibility with academic tooling.

## Using Goblintown

The desktop app (and `goblintown serve`) opens **Goblin Mode** at `/`: one
prompt, a **Single Goblin / Goblintown** mode switch, and a Tank checkbox.

- **Single Goblin** runs one worker for one answer — fast chat.
- **Goblintown** turns the prompt into a planner DAG with the full pack, memory,
  and self-correction, streaming progress as it goes.
- The **Tank** is a tamagotchi-style live diorama at `/tank`: each creature has
  a home, tokens stream into per-creature thinking bubbles, the DAG panel lights
  up node-by-node during a plan, and the result panel slides up with the winning
  output. Sprites are the default presentation, with emoji fallback when an asset
  is missing.

Everything else lives behind **Settings**: API provider and per-creature model
routing, voice, imported context, group chats / country collaboration, mail,
add-ons, onchain lookup, sentiment sources, cloud sign-in, and reset.

Run state is persisted to `.goblintown/runs/<runId>.json`, so an interrupted run
can be resumed from the Tank's recovery prompt after a restart.

### First run

On first launch, Goblin Mode asks two things: which **AI provider** should power
chat, and whether this Warren should **Stay Local** or **Use Goblintown Cloud**.
Both can be changed later from **Settings**.

Set a provider API key for any creature call. You can set it in your shell, or
save it from **Settings → API Provider** in the app. Local Ollama uses a
harmless dummy key if none is set; LM Studio needs `LM_API_TOKEN` only when its
server authentication is enabled.

### Command line

The same package still ships a CLI for development and automation — `goblintown
serve`, `init`, `rite`, `plan`, `quest`, `thesis`, `context`, `route`, and more.
It is no longer the primary surface; run `goblintown --help` for the full list.

## What Ships In Desktop Beta 0.1

| Area | What it does |
| --- | --- |
| **Chat-first desktop app** | Full Tank shell with sidebar navigation, single-Goblin chat, read-only web fetch for linked pages, browser text-to-speech, guided Rite entry, model controls, and first-run provider preference. |
| **Tank runtime** | Live creature diorama, default sprite sheets, centered wordmark, result panel, resumable runs, and reset. |
| **Memory** | Pigeon-Scribe distills every Rite into a typed Artifact (claims, evidence, open questions, next steps, parent links). Local context ingestion imports old conversations/projects; Chat Hoard Import Mode imports Codex and ChatGPT chats as pre-vectorized root/chunk memory. |
| **Planning** | Planner emits a typed DAG; the executor runs each node as a sub-rite, feeds artifacts forward, and replans after node failures. |
| **Specialist recovery** | Failed packs are clustered by dominant failure mode, then 1-3 focused Specialist Goblins repair the best seed before Ogre escalation. |
| **Debate** | Goblins can see peer proposals and revise once before Gremlin/Troll review. |
| **Verifier tools** | Troll can invoke `json.parse`, `regex.match`, gated `http.head`, and enabled add-on tools before scoring. |
| **Add-ons** | Optional local tool packs. The bundled Solana add-on contributes read-only onchain investigator tools — address profiles, activity, parsed transactions, token data, balances, and RPC health. No keys, signing, or transaction submission. |
| **Thesis engine** | Quality-and-advantage memos for any project, team, product, protocol, or decision. Solana flags add read-only onchain diligence. Not a buy/sell recommendation. |
| **Sentiment** | Free/no-key Alternative.me and GDELT baselines plus optional CoinGecko, Dune, Neynar, Santiment, CryptoPanic, and LunarCrush connectors, with keys stored locally. |
| **Provider routing** | OpenAI, OpenRouter, Ollama, LM Studio, Groq, Together, Mistral, DeepSeek, Anthropic, Gemini, and custom OpenAI-compatible endpoints, with per-creature routes. |
| **Goblintown Cloud** | Optional Firebase-backed SSO, friend codes, discovery, mail, and country metadata. |
| **Federation & Country** | Filesystem/HTTP artifact delivery, friend requests, direct messages, country discovery, join approvals, and team role assignment. |
| **Trace & audit** | Run export to LLM-MAS trace schema, artifact lineage graphing, audit, compare, reroll, context search, and context folding. |

## Providers, local inference, and output formats

Goblintown talks to OpenAI by default, but the underlying client is just the
`openai` SDK pointed at a base URL — anything that exposes an OpenAI-compatible
API works. Choose a provider from **Settings → API Provider**; non-secret
settings are saved to `.goblintown/warren.json`, and API keys are never written
there.

| Preset | Base URL | Key env var |
| --- | --- | --- |
| OpenAI | default SDK URL | `OPENAI_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| Ollama | `http://localhost:11434/v1` | `OLLAMA_API_KEY` (optional; dummy key if unset) |
| LM Studio | `http://localhost:1234/v1` | `LM_API_TOKEN` |
| Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| Together AI | `https://api.together.ai/v1` | `TOGETHER_API_KEY` |
| Mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| Anthropic | `https://api.anthropic.com/v1/` | `ANTHROPIC_API_KEY` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `GEMINI_API_KEY` |
| Custom | user supplied | user supplied |

Defaults: Goblin / Gremlin / Raccoon / Troll / Pigeon run on `gpt-5.4-mini`, Ogre
on `gpt-5.5`. Per-creature provider routes let you mix backends — e.g. cheap
local goblins with a hosted ogre. Output format can be `freeform`, `markdown`,
or `json`. `gpt-5*`, `o*`, `deepseek-r*`, and `-thinking` models are detected
and switched to reasoning-model parameters automatically.

## Goblintown Cloud

Goblintown is download-and-run friendly and local by default. **Stay Local**
keeps memory, runs, provider secrets, and reset state on the machine. **Use
Goblintown Cloud** signs in through the bundled Firebase project and turns on
shared features — SSO, friend codes, discovery, mail, and country metadata —
while local rite/run files still remain in `.goblintown/`. Normal users do not
need Firebase keys; forks can override them via `FIREBASE_*` env vars.

## Building from source

```bash
git clone https://github.com/0xbl33p/goblintown.git
cd goblintown
npm install
npm run build
npm run serve -- --port 7777
```

Build desktop installers (output goes to the gitignored `release/`):

```bash
npm run dist:mac      # macOS arm64 DMG
npm run dist:win      # Windows x64 one-click NSIS installer
npm run dist:linux    # Linux x64 AppImage
npm run dist:desktop  # all three targets
```

Public release builds are produced by `.github/workflows/desktop-release.yml`,
which runs the test suite, builds all platforms, signs macOS (Developer ID +
notarization) and Windows (Authenticode) when the signing secrets are present,
and uploads the installers to the GitHub Release.

## Tests

```bash
npm test
```

The suite runs as pure functions with no OpenAI calls, covering drift, reward,
Hoard content-addressing, federation signatures, audit, planner DAG validation,
debate prompt construction, verifier tool dispatch, add-ons, Solana read-only
lookups, thesis and sentiment construction, embeddings ranking, context folding,
provider routing, output formatting, cloud mode, sprite assets, trace export,
and the GUI/Settings wiring.

## Research foundations

Goblintown is an engineering project, not a research paper, but the
orchestration design is opinionated by what's working in current LLM multi-agent
systems. We deliberately stay in the **prompted, training-free** slice of the
literature so everything runs with just an OpenAI-compatible API key.

[1] **OpenAI**, *Where the goblins came from* (April 2026). The roster is taken
straight from the hardcoded ban list described in this postmortem.
<https://openai.com/index/where-the-goblins-came-from/>

[2] **Nielsen, S., et al.** *Learning to Orchestrate Agents in Natural Language
with the Conductor.* arXiv:2512.04388 (2025). *Dynamic topology selection* and
*recursive-self-as-worker* are borrowed as prompted heuristics in the Planner.

[3] **Zhou, & Chan.** *ADEMA: Knowledge-State Orchestration for Long-Horizon
Synthesis.* arXiv:2604.25849 (2026). The typed Artifact memory adapts ADEMA's
"epistemic bookkeeping."

[4] **Saeidi, et al.** *FAMA: Failure-Aware Meta-Agentic Framework.*
arXiv:2604.25135 (2026). The Specialist re-rite layer follows FAMA's pattern of
spawning a minimal specialist that targets the dominant error.

[5] **Parmar.** *MCP Workflow Engine: Separating Intelligence from Execution.*
arXiv:2605.00827 (2026). The plan-then-execute split comes from this paper.

[6] **Zou, J., et al.** *Latent Collaboration in Multi-Agent Systems.*
arXiv:2511.20639 (2025). The optional debate round is inspired by this
training-free latent-communication result.

[7] **Peng, Z., et al.** *CriticLean: Critic-Guided Reinforcement Learning for
Mathematical Formalization.* arXiv:2507.06181 (2025). The verifier-as-reward
pattern in the Troll's tool-use round comes from here.

[8] **xxzcc.** *Awesome LLM-MAS RL.* <https://github.com/xxzcc/awesome-llm-mas-rl>
(May 2026). The survey's five orchestration sub-decisions (spawn / delegate /
communicate / aggregate / stop) motivated the debate round, and its JSON trace
schema is adopted as Goblintown's `export-trace` output format.

## Citing

```bibtex
@software{goblintown,
  author  = {0XBL33P},
  title   = {Goblintown: a planning multi-agent orchestration protocol on top of OpenAI},
  year    = {2026},
  url     = {https://github.com/0xbl33p/goblintown}
}
```

## License

MIT — see [LICENSE](./LICENSE).
