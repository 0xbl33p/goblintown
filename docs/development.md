# Development

This repo is a TypeScript CLI, local HTTP server, browser UI, and Electron
desktop package in one mildly overgrown jacket.

## Setup

```bash
npm install
npm run build
npm test
```

Run the local browser UI:

```bash
npm run serve -- --port 7777
```

Run the desktop shell:

```bash
npm run desktop
```

## Packaging

Desktop package commands:

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
npm run dist:desktop
```

Release readiness:

```bash
npm run release:ready
```

That readiness script validates the beta artifact set, SHA256 sums, and signing
credentials. If it fails because certificates are missing, believe it.

## Tests

The main suite is:

```bash
npm test
```

For docs-only work, build first and run the docs help test:

```bash
npm run build
node --test dist/__tests__/docs-help.test.js
```

## Useful Source Map

| Area | Files |
| --- | --- |
| CLI routing | `src/cli.ts`, `src/cli-help.ts` |
| Browser UI/API | `src/server.ts`, `site/assets/` |
| Single Goblin chat | `src/chat.ts` |
| Rite pipeline | `src/rite.ts`, `src/quest.ts`, `src/troll-review.ts` |
| Planning | `src/planner.ts`, `src/plan-executor.ts` |
| Memory | `src/hoard.ts`, `src/artifact.ts`, `src/context-ingest.ts` |
| Providers | `src/providers.ts`, `src/openai-client.ts` |
| Add-ons/tools | `src/addons.ts`, `src/tools.ts`, `src/solana.ts` |
| Desktop | `src/desktop.ts`, `build/`, `package.json` |
