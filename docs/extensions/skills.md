# Skills In This Repository

Skills are operating manuals for future agent work. They are not runtime tools,
not marketing docs, and not a place to paste vague advice in a little hat.

## Current Convention

This repository currently uses:

```text
.agents/skills/<skill-name>/SKILL.md
```

The existing concrete skill is:

```text
.agents/skills/add-provider-package/SKILL.md
```

The UI and tests point at that path. Do not casually move it to a top-level
`skills/` directory unless the runtime and tests are changed together.

## When To Add A Skill

Add a skill when a repeated development task has:

- multiple files that must change together;
- non-obvious order of operations;
- verification commands that people forget;
- examples or templates worth reusing;
- a real chance that a future agent will improvise badly.

Do not add a skill for one command, one small README note, or a preference that
belongs in ordinary docs.

## Skill Shape

Every skill should have:

```markdown
---
name: useful-short-name
description: Use when ...
---

# Title

## When To Use

## Files To Inspect

## Procedure

## Verification

## Common Failures
```

Use exact paths. Name commands. Include expected outputs when practical. If the
skill says "add tests", name the test file and test command.

## Provider Package Skill

Use the existing provider package skill when adding a real provider adapter:

```bash
npx skills add https://github.com/vercel/ai --skill add-provider-package
```

Then follow:

```text
.agents/skills/add-provider-package/SKILL.md
```

That guide covers package structure, TypeScript configs, build setup, model
classes, README, tests, examples, docs, and release references.

## What Belongs Elsewhere

| Need | Put it here |
| --- | --- |
| User-facing behavior | `docs/` |
| CLI/API reference | `docs/reference/` |
| Product concepts | `README.md` or `docs/architecture/` |
| Runtime add-on code | `src/addons.ts`, `src/tools.ts` |
| Local project state | `.goblintown/` |
| Agent workflow recipe | `.agents/skills/<name>/SKILL.md` |

The clean rule: docs explain Goblintown to users. Skills teach future agents how
to safely change Goblintown.
