# Simple Goblin Chat Shell Design

## Goal

Make Goblintown feel like a simple chat product first: a Codex/ChatGPT-like shell with a left sidebar for chats and rites, one main surface, and advanced features summoned inline rather than exposed as a dense dashboard.

## Approved Shell

- The default app surface is a Goblin-skinned chat shell using the dark moss palette, parchment text, green action states, and restrained purple/cyan signal accents.
- The left sidebar contains:
  - Goblintown brand
  - New chat
  - New rite
  - Chats list
  - Rites list
  - Settings goblin in the lower corner
- Chats and rites are separate sidebar sections. Selecting either loads it into the main surface.
- There is no persistent right panel. All displayable output, including Tank activity, appears inline in the selected chat or rite.
- The Settings popover belongs inside the sidebar. It is a plain rounded rectangle with no notch/tail.
- The closed Settings state uses `settingsclosed.svg`; the open state uses `settingsopen.svg`. The open card appears above the settings goblin.
- Country name, country code, sign-in status, Hoard, full Settings, and the rotating joke appear only in the open Settings popover.

## Composer

- The composer stays compact and chat-like.
- Personality is plain text, not a boxed control. On hover it shows a small inverted caret; clicking opens a lightweight personality menu.
- Voice uses the provided SVG state icons, not a text button:
  - `fullgoblinchat.svg` = Chat Live
  - `ttsonlygoblinchat.svg` = Speak Only
  - `sttgoblinchat.svg` = Listen Only
- Hovering the active voice icon shows the active label above it.
- Clicking the voice icon opens a lightweight menu: icon plus text, no option boxes, hover/active highlight only.
- Send is a stylized circular up-arrow action beside the voice icon.
- Max tokens is removed from the visible composer.

## Rites And Runs

- Rites in the sidebar open a readable rite/run surface in the main pane.
- The selected rite view must show the full discussion/transcript, not only truncated snippets.
- Live Tank visuals appear inline in the rite view while the rite is running.
- Export/resume controls can remain in the rite header.

## Setup

- Setup is not visible in the main app sidebar because it should run before the user reaches the shell.
- The walkthrough starts by collecting AI API keys, then asks about voice, context APIs, Solana tools, town LLM routing, and GoblinCountry collaboration one at a time.
- LLM config choices are OpenAI, DeepSeek, LM Studio, Ollama, Anthropic, or Add New. Add New should discover/configure the API in a later implementation slice.

## Implementation Notes

- Work in small commits to avoid merge conflicts.
- Prefer additive shell CSS/classes over deleting backend endpoints.
- Keep old endpoints available while replacing the default UI.
- The approved mockup reference is `.superpowers/brainstorm/43705-1779729023/content/goblin-style-shell-v15.html`, with the settings icon mapping corrected.
