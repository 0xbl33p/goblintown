# Simple Goblin Chat Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dense default Tank overview with a simple Goblin-skinned chat shell that separates Chats and Rites in the left sidebar and renders all useful surfaces inline.

**Architecture:** Keep the existing `src/server.ts` single-page app routes and APIs, but introduce a new shell structure/classes inside `renderHome()`. Existing chat, voice, rite, provider, and run endpoints remain available. Assets live under `site/assets` and are served by the existing `/assets` static route.

**Tech Stack:** TypeScript, Express-rendered HTML/CSS/JS, Node test runner, existing Goblintown run-store and voice config modules.

---

### Task 1: Commit Design Checkpoint

**Files:**
- Create: `docs/superpowers/specs/2026-05-25-simple-goblin-chat-shell-design.md`
- Create: `docs/superpowers/plans/2026-05-25-simple-goblin-chat-shell.md`

- [ ] **Step 1: Verify docs are tracked**

Run: `git status --short -- docs/superpowers/specs/2026-05-25-simple-goblin-chat-shell-design.md docs/superpowers/plans/2026-05-25-simple-goblin-chat-shell.md`

Expected: both files appear with `??`.

- [ ] **Step 2: Commit**

Run:

```bash
git add docs/superpowers/specs/2026-05-25-simple-goblin-chat-shell-design.md docs/superpowers/plans/2026-05-25-simple-goblin-chat-shell.md
git commit -m "Document simple Goblin chat shell design"
git push origin codex/desktop-installers
```

Expected: commit and push succeed.

### Task 2: Add Voice And Settings Assets

**Files:**
- Create: `site/assets/fullgoblinchat.svg`
- Create: `site/assets/sttgoblinchat.svg`
- Create: `site/assets/ttsonlygoblinchat.svg`
- Create: `site/assets/settingsclosed.svg`
- Create: `site/assets/settingsopen.svg`
- Modify: `src/__tests__/tank-app.test.ts`

- [ ] **Step 1: Write failing asset tests**

Add assertions in `src/__tests__/tank-app.test.ts` that the five SVG files exist in `site/assets`, and that the root HTML references `/assets/fullgoblinchat.svg`, `/assets/sttgoblinchat.svg`, `/assets/ttsonlygoblinchat.svg`, `/assets/settingsclosed.svg`, and `/assets/settingsopen.svg`.

- [ ] **Step 2: Run red test**

Run: `npm run build && node --test dist/__tests__/tank-app.test.js`

Expected: failure because the assets and references are not present.

- [ ] **Step 3: Copy assets and reference them in shell markup**

Copy the supplied attachment SVGs into `site/assets`. Add shell references in `src/server.ts` for the voice and settings icons.

- [ ] **Step 4: Run green test and commit**

Run: `npm run build && node --test dist/__tests__/tank-app.test.js`

Expected: pass.

Commit:

```bash
git add site/assets/fullgoblinchat.svg site/assets/sttgoblinchat.svg site/assets/ttsonlygoblinchat.svg site/assets/settingsclosed.svg site/assets/settingsopen.svg src/__tests__/tank-app.test.ts src/server.ts
git commit -m "Add Goblin shell voice and settings assets"
git push origin codex/desktop-installers
```

### Task 3: Replace Root Shell Layout

**Files:**
- Modify: `src/server.ts`
- Modify: `src/__tests__/chat.test.ts`
- Modify: `src/__tests__/tank-app.test.ts`

- [ ] **Step 1: Write failing layout tests**

Update tests to require:
- `class="goblin-shell"`
- `class="goblin-sidebar"`
- visible `Chats` and `Rites` sections
- no visible `Max tokens` composer control
- settings closed icon references `/assets/settingsclosed.svg`
- settings open card references `/assets/settingsopen.svg`
- voice menu labels `Chat Live`, `Speak Only`, `Listen Only`
- stylized send button `id="root-chat-send"` with arrow text

- [ ] **Step 2: Run red test**

Run: `npm run build && node --test dist/__tests__/chat.test.js dist/__tests__/tank-app.test.js`

Expected: failure on missing new shell markers.

- [ ] **Step 3: Implement shell markup and CSS**

Change `renderHome()` markup and CSS in `src/server.ts` to match the approved shell:
- two-column shell
- left sidebar with New chat/New rite, Chats, Rites
- settings goblin stack in the sidebar
- main pane with chat/rite content
- composer with plain personality text, SVG voice control, and circular send

- [ ] **Step 4: Run green test and commit**

Run: `npm run build && node --test dist/__tests__/chat.test.js dist/__tests__/tank-app.test.js`

Expected: pass.

Commit:

```bash
git add src/server.ts src/__tests__/chat.test.ts src/__tests__/tank-app.test.ts
git commit -m "Simplify root UI into Goblin chat shell"
git push origin codex/desktop-installers
```

### Task 4: Full Run Transcript View

**Files:**
- Modify: `src/server.ts`
- Modify: `src/__tests__/run-store.test.ts` or `src/__tests__/tank-app.test.ts`

- [ ] **Step 1: Write failing test**

Add a test that a run record with multiple text-bearing events is rendered into a full transcript surface without `slice(0, ...)` truncation for discussion content.

- [ ] **Step 2: Run red test**

Run: `npm run build && node --test dist/__tests__/tank-app.test.js`

Expected: failure because the full transcript view is missing.

- [ ] **Step 3: Implement inline rite transcript renderer**

Add a renderer that maps run events to readable transcript entries in the main pane. Keep short labels but preserve full text content in expandable/preformatted blocks.

- [ ] **Step 4: Run green test and commit**

Run: `npm run build && node --test dist/__tests__/tank-app.test.js`

Expected: pass.

Commit:

```bash
git add src/server.ts src/__tests__/tank-app.test.ts
git commit -m "Show full rite transcripts in the shell"
git push origin codex/desktop-installers
```

### Task 5: Setup Walkthrough Skeleton

**Files:**
- Modify: `src/server.ts`
- Create or modify: `src/__tests__/setup-walkthrough.test.ts`
- Modify: `package.json` test list if a new test file is created

- [ ] **Step 1: Write failing walkthrough test**

Assert root HTML or `/api/onboarding` exposes the ordered setup questions:
1. AI API keys
2. TTS/voice mode
3. Context APIs
4. Solana Tools
5. different LLM APIs for Town
6. GoblinCountry sign-in with generated name/code

- [ ] **Step 2: Run red test**

Run: `npm run build && node --test dist/__tests__/setup-walkthrough.test.js`

Expected: failure because the walkthrough skeleton is missing.

- [ ] **Step 3: Implement setup walkthrough shell**

Add a minimal setup walkthrough renderer/API that can be expanded later. Do not block users with incomplete provider discovery yet.

- [ ] **Step 4: Run full tests and commit**

Run: `npm test`

Expected: all tests pass.

Commit:

```bash
git add src/server.ts src/__tests__/setup-walkthrough.test.ts package.json
git commit -m "Add setup walkthrough skeleton"
git push origin codex/desktop-installers
```

### Task 6: Browser QA

**Files:**
- No source edits unless QA finds defects.

- [ ] **Step 1: Restart local server**

Run:

```bash
lsof -ti tcp:56393 | xargs -r kill
node dist/cli.js serve --port 56393
```

Expected: server listens on `http://localhost:56393`.

- [ ] **Step 2: Browser verify**

Open `http://localhost:56393/` and verify:
- left sidebar renders
- chat composer renders
- voice SVG menu renders
- settings popover stays inside sidebar
- selected rite/run content appears in main surface

- [ ] **Step 3: Final commit if needed**

If QA changes were required, run `npm test`, commit, and push.

