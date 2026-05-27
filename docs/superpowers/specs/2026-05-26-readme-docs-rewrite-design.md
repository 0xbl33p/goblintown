# README And Docs Rewrite Design

## Goal

Rewrite Goblintown's public documentation so the front README becomes a serious, weird, screenshot-backed introduction to the product and architecture, while detailed reference material moves into focused docs that read like a playful product manual carrying very dry technical content.

## Voice

- README: serious and weird. It should feel like a real local-first systems project with a ritualized creature vocabulary, not a startup landing page and not an accidental encyclopedia.
- Docs: playful product manual. Keep the knobs, caveats, CLI flags, file layouts, APIs, and extension rules dry and explicit, but let headings and short framing copy keep the reader awake.

## Documentation Shape

The README should remain substantial, but it should stop being the only manual. It will include:

- Logo/banner and screenshots.
- What Goblintown is.
- Current beta installer links and caveats.
- Single Goblin mode versus full Goblintown/Rite mode.
- A readable but detailed pipeline walkthrough.
- Extension and skills overview.
- Quick commands and links into docs.

The docs tree should hold the deeper reference material:

- `docs/README.md`: docs index.
- `docs/install/beta-0.7.md`: current installer reality, temporary hosts, split-parts fallback, unsigned app caveats.
- `docs/architecture/pipeline.md`: Planner, Raccoon, Goblin pack, debate, Gremlin, Troll, Specialists, Ogre, Pigeon-Scribe, artifacts, traces.
- `docs/architecture/research-foundations.md`: why the staged pipeline exists.
- `docs/modes/single-goblin.md`: single worker chat mode, slash command semantics, chat API behavior.
- `docs/modes/goblintown-mode.md`: full Rite mode, planning, Tank run surface, resumability.
- `docs/extensions/overview.md`: add-ons, verifier tools, reward plugins, provider routing, and current extension boundaries.
- `docs/extensions/skills.md`: how `.agents/skills/` is used in this repository, with the existing `add-provider-package` skill as the concrete pattern.
- `docs/features/cloud-country.md`: cloud, country, friends, mail, and reset behavior.
- `docs/features/research-tools.md`: thesis, sentiment, and Solana add-on behavior.
- `docs/development.md`: build, test, serve, package.
- `docs/reference/cli.md`: command reference.
- `docs/reference/http-api.md`: HTTP API reference.
- `docs/reference/providers.md`: provider routing and local inference.
- `docs/reference/storage-layout.md`: `.goblintown/` runtime layout.

## Screenshots

Screenshots should be real captures from the local app, not synthetic marketing art. Store them under `docs/assets/screenshots/` and reference them from the README. The minimum set is:

- Main single-Goblin chat shell.
- Settings/provider setup surface.
- Full Goblintown/Rite or Tank run surface.

If a live run cannot be made without API keys, capture the available UI state honestly and use existing visual assets only as supporting imagery.

## Current Repository Constraints

- The real repo is `/Users/angus/goblintown/repo/goblintown`.
- The root README currently carries product copy, install instructions, architecture, API reference, CLI reference, provider reference, release notes, and research notes in one file.
- The current skills convention is `.agents/skills/<skill-name>/SKILL.md`; the repository does not currently have a clean top-level `/skills` runtime contract.
- The existing concrete skill is `.agents/skills/add-provider-package/SKILL.md`.
- Current installer publishing is constrained by GitHub tag rules. Full installers exist locally; public release fallback is split assets on `release/v0.7.0-beta.1`, plus temporary upload notes in ignored `release/TEMP_UPLOADS.md`.

## Verification

- Markdown links should point at real files.
- README should reference screenshots that exist.
- Documentation should not claim a GitHub Release exists for `v0.7.0-beta.1` while tag creation remains blocked.
- Run at least `npm run build` after the docs changes because README is included in packaged desktop files and the TypeScript build is a cheap regression signal.
