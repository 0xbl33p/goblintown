# AI-First Tank Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the full Tank the primary AI-first surface, with a familiar chat layout, sidebar navigation, full-Tank rite execution, and no compact Tank path.

**Architecture:** Keep existing Tank server routes and run streaming intact. Rework the Tank root HTML/CSS/inline script so chat is the default interaction layer above the full Tank, while Settings remains the canonical home for provider and feature configuration.

**Tech Stack:** TypeScript, Express-rendered HTML, inline browser JavaScript, Node test runner source assertions, Browser plugin visual verification.

---

### Task 1: Pin The Primary Tank Shell Contract

**Files:**
- Modify: `src/__tests__/chat.test.ts`
- Modify: `src/__tests__/goblin-mode-ui.test.ts`

- [ ] **Step 1: Write failing source tests**

Add tests asserting that `/` renders the full Tank shell by default, the old compact `tank-box` mini Tank is absent from Goblin Mode, the Tank chat surface has a left sidebar with New Chat, New Rite, API Configs, Rites, Chats, and Settings, and the composer has Send, Voice, model/personality controls, Shift+Enter newline behavior, and Cmd/Ctrl+Enter send behavior.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `npm run build && node --test dist/__tests__/chat.test.js dist/__tests__/goblin-mode-ui.test.js`

Expected: FAIL on missing sidebar/chat contract and remaining compact Tank references.

### Task 2: Rework Root Routing And Full Tank Layout

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Route `/` to the full Tank app**

Change the root route to render `tankHtml(...)` or make `goblinModeHtml(...)` redirect to the full Tank experience. Keep `/tank` as an alias.

- [ ] **Step 2: Add the left sidebar**

Add a persistent `aside` in the Tank markup with buttons/dropdowns for New Chat, New Rite, API Configs, Rites, Chats, and Settings. All controls need `title` attributes and accessible labels where the visible text is not enough.

- [ ] **Step 3: Promote chat transcript above composer**

Keep the existing root chat mode, but make the transcript area the main top content and the composer the bottom anchor. Preserve the existing single-Goblin `/api/chat` submit path.

- [ ] **Step 4: Remove compact Tank behavior**

Delete the compact `tank-box` UI and stop offering a mini Tank toggle. Any rite/plan starts should switch to full Tank mode and use existing SSE Tank visuals.

### Task 3: Chat Composer Behavior And Controls

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add keyboard behavior**

Wire Shift+Enter to remain a textarea newline and Cmd/Ctrl+Enter to submit the root chat form. Avoid plain Enter sending until the product explicitly chooses that behavior.

- [ ] **Step 2: Add controls**

Place Send, Voice, model selection, personality, and token controls in the composer tray. Controls must have tooltips. The model control should read from existing provider model defaults where possible, and API Configs should open the existing provider popover.

### Task 4: Chat-Guided Rite Start

**Files:**
- Modify: `src/server.ts`
- Modify: relevant source tests under `src/__tests__/`

- [ ] **Step 1: Add New Rite intent state**

Clicking New Rite starts a short guided flow in the chat transcript, asking the user which rite type they want: regular, thesis, crypto/onchain, sentiment, or plan.

- [ ] **Step 2: Ask only necessary follow-ups**

Each selected rite type should collect only required inputs, then call the existing endpoint: regular `/api/rite`, plan `/api/plan`, thesis `/api/thesis`, sentiment/onchain existing tool endpoints.

- [ ] **Step 3: Launch in full Tank**

When a rite starts, leave chat mode and show the full Tank running state.

### Task 5: Verify And Commit

**Files:**
- All changed files.

- [ ] **Step 1: Run focused verification**

Run: `npm run build && node --test dist/__tests__/chat.test.js dist/__tests__/goblin-mode-ui.test.js dist/__tests__/settings-menu.test.js dist/__tests__/provider-ui.test.js`

- [ ] **Step 2: Browser QA**

Reload `http://localhost:7777/`, verify the full Tank primary surface, sidebar, chat transcript, composer keyboard behavior, tooltips, and no compact Tank.

- [ ] **Step 3: Commit**

Commit with a message such as `Rework Tank as AI-first chat surface`.
