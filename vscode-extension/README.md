# Goblintown for VS Code

Run [Goblintown](https://github.com/0xbl33p/goblintown) rites against your code without leaving the editor.

## Commands

- **Goblintown: Summon Creature on Selection** — pick a creature, append the editor selection as context, stream output to the Goblintown panel.
- **Goblintown: Quest on Selection** — Goblin pack + Troll arbitration on the selection.
- **Goblintown: Rite on Active File** — full pipeline (Raccoon → pack → Gremlin → Troll → Ogre fallback) with the active file as scan input.
- **Goblintown: Open Hoard (web UI)** — opens `http://localhost:<serverPort>/` in your browser.

## Requirements

- The `goblintown` CLI on your PATH (or set `goblintown.cliPath`).
- A Warren in the workspace (`goblintown init`).
- `OPENAI_API_KEY` available to the CLI.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `goblintown.cliPath` | `goblintown` | Path to the CLI. |
| `goblintown.packSize` | 3 | Goblins per quest/rite. |
| `goblintown.personality` | `nerdy` | One of: nerdy, cynical, chipper, stoic, feral. |
| `goblintown.serverPort` | 7777 | Port for `goblintown serve`. |

## Build

```sh
cd vscode-extension
npm install
npm run compile
```

Use F5 in VS Code to launch an Extension Development Host.

## License

MIT
