# Single Goblin Mode

Single Goblin mode is the fast path: one worker, one answer, one stored Loot
record. Use it when the task is a normal chat turn or when the honest answer is
"ask the model directly."

## Entry Points

Browser:

- root app at `/`
- HTTP endpoint `POST /api/goblin/single`

CLI:

```bash
goblintown /ask "Write the shortest useful answer"
```

## What It Does

Single Goblin mode:

- normalizes recent chat history;
- caps transcript size;
- fetches public URL context when useful;
- builds a single-Goblin prompt;
- calls the configured Goblin model slot;
- stores the answer as Loot in the Hoard;
- optionally offers to start Goblintown mode for complex work.

It does not run the Planner, pack, Gremlin, Troll, Specialists, Ogre, or
Pigeon-Scribe. That is the point. One answer should not wear a fake committee
badge.

## Prompt Contract

The single-Goblin prompt tells the model:

- answer the latest user message directly;
- use transcript only as context;
- cite fetched URL context when present;
- stay practical and complete;
- offer full Goblintown only when the task warrants it.

Relevant file:

- `src/chat.ts`

## Browser Controls

The chat shell exposes:

- model slot selection: provider default, Goblin slot, Ogre slot;
- personality selection: `chipper`, `nerdy`, `stoic`, `cynical`, `feral`,
  `goblin_mode`;
- response length;
- browser text-to-speech controls;
- a handoff path into Goblintown mode.

## When To Escalate

Escalate from Single Goblin to Goblintown mode when the task needs:

- scanned repository context;
- multiple candidate answers;
- adversarial review;
- verifier tools;
- failure recovery;
- memory Artifacts;
- a planner DAG;
- traceable run history.
