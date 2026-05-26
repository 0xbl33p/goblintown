# README And Docs Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overgrown root README with a serious-weird front page and move detailed operational/reference content into focused docs.

**Architecture:** Keep the root README as the entrypoint and narrative architecture map. Put dry reference material into `docs/` files split by responsibility: install, architecture, modes, extensions, development, and reference. Store real screenshots under `docs/assets/screenshots/` and reference them from README.

**Tech Stack:** Markdown, existing Goblintown TypeScript/Node app, local browser screenshots, existing site assets.

---

### Task 1: Capture Screenshot Assets

**Files:**
- Create directory: `docs/assets/screenshots/`
- Create: `docs/assets/screenshots/goblintown-chat.jpg`
- Create: `docs/assets/screenshots/goblintown-settings.jpg`
- Create: `docs/assets/screenshots/goblintown-rites.jpg`

- [x] Start the local app with `node dist/cli.js serve --port 57777`.
- [x] Open `http://localhost:57777/` in the browser.
- [x] Capture the main chat shell as `docs/assets/screenshots/goblintown-chat.jpg`.
- [x] Open the setup/settings surface and capture it as `docs/assets/screenshots/goblintown-settings.jpg`.
- [x] Open the Rites/Tank surface or closest honest available run view and capture it as `docs/assets/screenshots/goblintown-rites.jpg`.

### Task 2: Rewrite Root README

**Files:**
- Modify: `README.md`

- [x] Replace the current all-in-one manual with a structured README that includes the logo, screenshots, serious-weird product description, installer status, mode comparison, pipeline description, extension/skills overview, quick commands, and docs index.
- [x] Keep direct links to the new docs.
- [x] Avoid claiming the blocked GitHub Release exists.

### Task 3: Create Focused Docs

**Files:**
- Create: `docs/README.md`
- Create: `docs/install/beta-0.7.md`
- Create: `docs/architecture/pipeline.md`
- Create: `docs/architecture/research-foundations.md`
- Create: `docs/modes/single-goblin.md`
- Create: `docs/modes/goblintown-mode.md`
- Create: `docs/extensions/overview.md`
- Create: `docs/extensions/skills.md`
- Create: `docs/features/cloud-country.md`
- Create: `docs/features/research-tools.md`
- Create: `docs/development.md`
- Create: `docs/reference/cli.md`
- Create: `docs/reference/http-api.md`
- Create: `docs/reference/providers.md`
- Create: `docs/reference/storage-layout.md`

- [x] Move detailed install and release fallback content into `docs/install/beta-0.7.md`.
- [x] Move the detailed pipeline into `docs/architecture/pipeline.md`.
- [x] Move mode-specific guidance into `docs/modes/`.
- [x] Move add-on, reward plugin, provider route, and skill instructions into `docs/extensions/`.
- [x] Move command, API, provider, and storage tables into `docs/reference/`.
- [x] Keep the docs playful in framing and dry in the exact instructions.

### Task 4: Verify And Commit

**Files:**
- Verify all changed Markdown files.

- [x] Run the placeholder/release-claim scan over `README.md` and `docs/`.
- [x] Run `find docs/assets/screenshots -maxdepth 1 -type f -print`.
- [x] Run `npm run build`.
- [x] Run `npm test`.
- [x] Run `git status --short`.
- [ ] Commit the docs rewrite.
