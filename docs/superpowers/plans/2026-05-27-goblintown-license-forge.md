# Goblintown License Forge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate Firebase-hosted Goblintown Driver's License Forge where public wallet users burn `$GOBLINTOWN`, pay only the mint/ops reserve, and receive tradable Metaplex Core license NFTs with Warren loot-based rarity modifiers.

**Architecture:** Add a nested `apps/license-forge` Firebase web app with a React/Vite frontend, Firebase Functions v2 backend, shared deterministic forge modules, Firestore/Storage rules, and a small signed Warren loot endpoint in the existing local Goblintown server. The public path verifies Token-2022 burns before generation and minting; the admin path uses the same Firebase Auth UID allowlist.

**Tech Stack:** TypeScript, React, Vite, Vitest, Firebase Hosting, Firestore, Firebase Storage, Firebase Functions v2, Firebase Admin SDK, Solana Web3.js, SPL Token Token-2022, Sharp, Metaplex Core/Umi.

---

## References

- Design spec: `docs/superpowers/specs/2026-05-27-goblintown-license-forge-design.md`
- Current local API docs: `docs/reference/http-api.md`
- Metaplex Core asset creation: https://www.metaplex.com/docs/core/create-asset
- Metaplex Core collection creation: https://www.metaplex.com/docs/smart-contracts/core/collections/create
- Metaplex Core royalties plugin: https://www.metaplex.com/docs/core/plugins/royalties
- Metaplex DAS API overview: https://www.metaplex.com/docs/dev-tools/das-api

## File Structure

Create a new nested Firebase app:

- `apps/license-forge/package.json`: app-local scripts and dependencies.
- `apps/license-forge/tsconfig.json`: shared browser test TypeScript config.
- `apps/license-forge/vite.config.ts`: Vite and Vitest config.
- `apps/license-forge/index.html`: frontend entry.
- `apps/license-forge/firebase.json`: Hosting, Functions, Firestore, and Storage config for this app directory.
- `apps/license-forge/.firebaserc.example`: documents the shared Goblintown project target without forcing local Firebase state.
- `apps/license-forge/firestore.rules`: public reads, Function-owned writes, admin reads.
- `apps/license-forge/storage.rules`: public reads for generated license assets and admin-only trait uploads.
- `apps/license-forge/src/main.tsx`: React entry.
- `apps/license-forge/src/App.tsx`: app composition and state machine.
- `apps/license-forge/src/styles.css`: cursed municipal UI system.
- `apps/license-forge/shared/config.ts`: public constants and Firebase config helpers.
- `apps/license-forge/shared/pricing.ts`: pricing and quote math.
- `apps/license-forge/shared/traits.ts`: trait schema, seeded RNG, rarity boost, and roll engine.
- `apps/license-forge/shared/licenseMetadata.ts`: marketplace metadata builder.
- `apps/license-forge/shared/solanaForge.ts`: frontend Token-2022 burn/payment transaction builder and shared verification types.
- `apps/license-forge/shared/lootClaim.ts`: signed Warren loot claim types and canonical payload.
- `apps/license-forge/src/components/*.tsx`: wallet, auth, offer, preview, logs, result, and admin components.
- `apps/license-forge/src/__tests__/*.test.ts`: browser/shared module tests.
- `apps/license-forge/functions/package.json`: Functions dependencies and scripts.
- `apps/license-forge/functions/tsconfig.json`: Functions TypeScript config.
- `apps/license-forge/functions/src/index.ts`: HTTP router exported as a v2 Function.
- `apps/license-forge/functions/src/admin.ts`: Firebase Admin app, Firestore, Storage, and auth helpers.
- `apps/license-forge/functions/src/prices.ts`: external price fetchers and testable price-source wrapper.
- `apps/license-forge/functions/src/quotes.ts`: quote creation and validation.
- `apps/license-forge/functions/src/solanaVerify.ts`: finalized transaction verification.
- `apps/license-forge/functions/src/compositor.ts`: Sharp license PNG compositor.
- `apps/license-forge/functions/src/metadata.ts`: metadata storage and license record assembly.
- `apps/license-forge/functions/src/metaplexCore.ts`: Core collection and asset mint adapter.
- `apps/license-forge/functions/src/lootClaims.ts`: Firebase-authenticated loot claim verification.
- `apps/license-forge/functions/src/adminRoutes.ts`: UID allowlisted offer, trait, and admin mint endpoints.
- `apps/license-forge/functions/src/__tests__/*.test.ts`: Functions unit tests.
- `apps/license-forge/functions/assets/starter-traits/manifest.json`: starter trait pack.
- `apps/license-forge/functions/assets/starter-traits/*.svg`: simple starter layer assets used by tests and local preview.
- `docs/features/license-forge.md`: operator and product docs.

Modify the existing local app for Warren loot signing:

- `src/forge-loot-claim.ts`: canonical local claim builder/signature verifier.
- `src/server.ts`: add local claim endpoint and CORS preflight for trusted forge origins.
- `src/__tests__/forge-loot-claim.test.ts`: local claim tests.
- `docs/reference/http-api.md`: document the local claim endpoint.
- `package.json`: include the new root test in the existing explicit test command.

## Task 0: Create The Implementation Worktree

**Files:**
- No file edits in this task.

- [ ] **Step 1: Create an isolated worktree**

Run from the existing repo:

```bash
git worktree add /Users/angus/goblintown/worktrees/license-forge -b codex/license-forge
```

Expected: a new clean worktree at `/Users/angus/goblintown/worktrees/license-forge` with branch `codex/license-forge`.

- [ ] **Step 2: Verify the worktree**

Run:

```bash
git -C /Users/angus/goblintown/worktrees/license-forge status --short --branch
```

Expected: `## codex/license-forge` and no changed files.

- [ ] **Step 3: Commit checkpoint**

No commit is needed for this task.

## Task 1: Scaffold The Nested Firebase App

**Files:**
- Create: `apps/license-forge/package.json`
- Create: `apps/license-forge/tsconfig.json`
- Create: `apps/license-forge/vite.config.ts`
- Create: `apps/license-forge/index.html`
- Create: `apps/license-forge/firebase.json`
- Create: `apps/license-forge/.firebaserc.example`
- Create: `apps/license-forge/firestore.rules`
- Create: `apps/license-forge/storage.rules`
- Create: `apps/license-forge/src/main.tsx`
- Create: `apps/license-forge/src/App.tsx`
- Create: `apps/license-forge/src/styles.css`
- Create: `apps/license-forge/shared/config.ts`
- Create: `apps/license-forge/src/__tests__/config.test.ts`
- Create: `apps/license-forge/functions/package.json`
- Create: `apps/license-forge/functions/tsconfig.json`
- Create: `apps/license-forge/functions/src/index.ts`
- Create: `apps/license-forge/functions/src/__tests__/health.test.ts`

- [ ] **Step 1: Write the failing frontend config test**

Create `apps/license-forge/src/__tests__/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIREBASE_CLIENT_CONFIG,
  GOBLINTOWN_MINT,
  TOKEN_2022_PROGRAM_ID_STRING,
} from "../../shared/config";

describe("license forge config", () => {
  it("reuses the existing Goblintown Firebase project and Token-2022 mint", () => {
    expect(DEFAULT_FIREBASE_CLIENT_CONFIG.projectId).toBe("goblintown-88fd6");
    expect(GOBLINTOWN_MINT).toBe("DJ15QJxVPFGv6kYhT6LvDGqG9b4aBFWQzavA7dGxpump");
    expect(TOKEN_2022_PROGRAM_ID_STRING).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm test -- --run src/__tests__/config.test.ts
```

Expected: FAIL because `package.json`, Vitest config, and `shared/config.ts` do not exist yet.

- [ ] **Step 3: Add the nested app package**

Create `apps/license-forge/package.json`:

```json
{
  "name": "@goblintown/license-forge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "build": "tsc -p tsconfig.json && vite build",
    "preview": "vite preview --host 127.0.0.1",
    "test": "vitest",
    "test:run": "vitest run",
    "functions:build": "npm --prefix functions run build",
    "functions:test": "npm --prefix functions test",
    "check": "npm run test:run && npm run build && npm run functions:test && npm run functions:build"
  },
  "dependencies": {
    "@firebase/app": "^0.13.0",
    "@firebase/auth": "^1.10.0",
    "@firebase/firestore": "^4.9.0",
    "@solana/spl-token": "^0.4.13",
    "@solana/web3.js": "^1.98.0",
    "firebase": "^11.9.0",
    "lucide-react": "^0.468.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.3.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.5.0",
    "jsdom": "^26.1.0",
    "typescript": "^5.6.0",
    "vite": "^6.3.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 4: Add TypeScript and Vite config**

Create `apps/license-forge/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "shared", "vite.config.ts"]
}
```

Create `apps/license-forge/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [],
  },
});
```

- [ ] **Step 5: Add Firebase project config files**

Create `apps/license-forge/firebase.json`:

```json
{
  "hosting": {
    "public": "dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      { "source": "/api/**", "function": "api" },
      { "source": "**", "destination": "/index.html" }
    ]
  },
  "functions": [
    {
      "source": "functions",
      "codebase": "license-forge",
      "runtime": "nodejs22"
    }
  ],
  "firestore": {
    "rules": "firestore.rules"
  },
  "storage": {
    "rules": "storage.rules"
  }
}
```

Create `apps/license-forge/.firebaserc.example`:

```json
{
  "projects": {
    "default": "goblintown-88fd6"
  }
}
```

Create `apps/license-forge/firestore.rules`:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() {
      return request.auth != null;
    }

    function isAdmin() {
      return signedIn() &&
        exists(/databases/$(database)/documents/adminUsers/$(request.auth.uid));
    }

    match /forgeOffers/{offerId} {
      allow read: if resource.data.public == true && resource.data.enabled == true || isAdmin();
      allow write: if false;
    }

    match /licenses/{licenseId} {
      allow read: if true;
      allow write: if false;
    }

    match /traitPacks/{packId} {
      allow read: if resource.data.public == true || isAdmin();
      allow write: if false;
    }

    match /users/{uid} {
      allow read: if signedIn() && request.auth.uid == uid || isAdmin();
      allow write: if false;

      match /lootClaims/{claimId} {
        allow read: if signedIn() && request.auth.uid == uid || isAdmin();
        allow write: if false;
      }
    }

    match /adminAudit/{eventId} {
      allow read: if isAdmin();
      allow write: if false;
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

Create `apps/license-forge/storage.rules`:

```text
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function signedIn() {
      return request.auth != null;
    }

    function isAdmin() {
      return signedIn() &&
        firestore.exists(/databases/(default)/documents/adminUsers/$(request.auth.uid));
    }

    match /licenses/{network}/{assetId}/{fileName} {
      allow read: if true;
      allow write: if false;
    }

    match /trait-packs/{packId}/{fileName=**} {
      allow read: if true;
      allow write: if isAdmin();
    }

    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

- [ ] **Step 6: Add minimal frontend entry and config**

Create `apps/license-forge/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Goblintown Driver's License Forge</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `apps/license-forge/shared/config.ts`:

```ts
export const GOBLINTOWN_MINT = "DJ15QJxVPFGv6kYhT6LvDGqG9b4aBFWQzavA7dGxpump";
export const TOKEN_2022_PROGRAM_ID_STRING = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export const DEFAULT_FIREBASE_CLIENT_CONFIG = {
  apiKey: "AIzaSyD2px9fRoSh6bwOBDIk2dGioYbxROQ6Leo",
  authDomain: "goblintown-88fd6.firebaseapp.com",
  projectId: "goblintown-88fd6",
  storageBucket: "goblintown-88fd6.firebasestorage.app",
  messagingSenderId: "904412921746",
  appId: "1:904412921746:web:a92c6ba51e292b0d858b4b",
  measurementId: "G-C1TSNGHXYG",
} as const;

export function envOrDefault(name: string, fallback: string): string {
  const value = import.meta.env[name] as string | undefined;
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

export function firebaseClientConfig() {
  return {
    apiKey: envOrDefault("VITE_FIREBASE_API_KEY", DEFAULT_FIREBASE_CLIENT_CONFIG.apiKey),
    authDomain: envOrDefault("VITE_FIREBASE_AUTH_DOMAIN", DEFAULT_FIREBASE_CLIENT_CONFIG.authDomain),
    projectId: envOrDefault("VITE_FIREBASE_PROJECT_ID", DEFAULT_FIREBASE_CLIENT_CONFIG.projectId),
    storageBucket: envOrDefault("VITE_FIREBASE_STORAGE_BUCKET", DEFAULT_FIREBASE_CLIENT_CONFIG.storageBucket),
    messagingSenderId: envOrDefault(
      "VITE_FIREBASE_MESSAGING_SENDER_ID",
      DEFAULT_FIREBASE_CLIENT_CONFIG.messagingSenderId,
    ),
    appId: envOrDefault("VITE_FIREBASE_APP_ID", DEFAULT_FIREBASE_CLIENT_CONFIG.appId),
    measurementId: envOrDefault("VITE_FIREBASE_MEASUREMENT_ID", DEFAULT_FIREBASE_CLIENT_CONFIG.measurementId),
  };
}
```

Create `apps/license-forge/src/App.tsx`:

```tsx
export function App() {
  return (
    <main className="forge-shell">
      <section className="forge-board" aria-label="Goblintown Driver's License Forge">
        <p className="stamp">Department of Cursed Motor Wagons</p>
        <h1>Goblintown Driver's License Forge</h1>
        <p className="notice">VALID FOR ONE TRIP. PAY THE MUNICIPAL BURN. DO NOT LICK THE LAMINATE.</p>
      </section>
    </main>
  );
}
```

Create `apps/license-forge/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

Create `apps/license-forge/src/styles.css`:

```css
:root {
  color: #f7f1c5;
  background: #15110b;
  font-family: "Courier New", ui-monospace, SFMono-Regular, monospace;
}

body {
  margin: 0;
  min-width: 320px;
}

button,
input,
select {
  font: inherit;
}

.forge-shell {
  min-height: 100vh;
  padding: 24px;
  background:
    linear-gradient(90deg, rgba(0, 0, 0, 0.18) 1px, transparent 1px),
    linear-gradient(#20170c, #3c3212 46%, #111407);
  background-size: 8px 8px, auto;
}

.forge-board {
  border: 4px double #dbff63;
  background: rgba(28, 35, 13, 0.92);
  box-shadow: 8px 8px 0 #000;
  margin: 0 auto;
  max-width: 980px;
  padding: 24px;
}

.stamp {
  color: #ffdf44;
  text-transform: uppercase;
}

h1 {
  color: #b6ff4d;
  font-size: clamp(2rem, 6vw, 4.5rem);
  line-height: 0.94;
  margin: 0 0 16px;
}

.notice {
  border: 2px solid #ff5a3d;
  color: #ffd4cb;
  display: inline-block;
  padding: 8px 10px;
}
```

- [ ] **Step 7: Add minimal Functions package and health route**

Create `apps/license-forge/functions/package.json`:

```json
{
  "name": "@goblintown/license-forge-functions",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/functions/src/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test lib/functions/src/__tests__/*.test.js"
  },
  "dependencies": {
    "@google-cloud/storage": "^7.16.0",
    "@metaplex-foundation/mpl-core": "^1.3.0",
    "@metaplex-foundation/umi": "^1.2.0",
    "@metaplex-foundation/umi-bundle-defaults": "^1.2.0",
    "@metaplex-foundation/umi-signer-web3js": "^1.2.0",
    "@solana/spl-token": "^0.4.13",
    "@solana/web3.js": "^1.98.0",
    "cors": "^2.8.5",
    "express": "^4.21.0",
    "firebase-admin": "^13.4.0",
    "firebase-functions": "^6.3.0",
    "sharp": "^0.34.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^22.7.0",
    "typescript": "^5.6.0"
  }
}
```

Create `apps/license-forge/functions/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "lib",
    "rootDir": "..",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*", "../shared/**/*"]
}
```

Create `apps/license-forge/functions/src/index.ts`:

```ts
import express from "express";
import { onRequest } from "firebase-functions/v2/https";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "goblintown-license-forge" });
});

export const api = onRequest({ region: "us-central1", timeoutSeconds: 120, memory: "1GiB" }, app);
```

Create `apps/license-forge/functions/src/__tests__/health.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(join(root, "src", "index.ts"), "utf8");

describe("license forge function surface", () => {
  it("exports an HTTP api function and health route", () => {
    assert.match(source, /export const api = onRequest/);
    assert.match(source, /\/api\/health/);
    assert.match(source, /goblintown-license-forge/);
  });
});
```

- [ ] **Step 8: Install dependencies and verify scaffold**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm install
npm --prefix functions install
npm test -- --run src/__tests__/config.test.ts
npm --prefix functions test
npm run build
```

Expected: all commands pass.

- [ ] **Step 9: Commit**

Run:

```bash
git add apps/license-forge
git commit -m "feat: scaffold license forge firebase app"
```

## Task 2: Implement Configurable Pricing Quotes

**Files:**
- Create: `apps/license-forge/shared/pricing.ts`
- Create: `apps/license-forge/src/__tests__/pricing.test.ts`
- Modify: `apps/license-forge/functions/src/index.ts`
- Create: `apps/license-forge/functions/src/prices.ts`
- Create: `apps/license-forge/functions/src/quotes.ts`
- Create: `apps/license-forge/functions/src/__tests__/pricing.test.ts`

- [ ] **Step 1: Write the failing shared pricing test**

Create `apps/license-forge/src/__tests__/pricing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { quoteOffer } from "../../shared/pricing";

describe("quoteOffer", () => {
  it("subtracts ops reserve and burns the rest of the target value", () => {
    const quote = quoteOffer({
      offer: {
        id: "standard",
        version: 3,
        enabled: true,
        public: true,
        targetUsd: 2.5,
        opsReserveUsd: 0.35,
        minBurnUiAmount: 1,
        maxBurnUiAmount: 100_000,
        royaltyBasisPoints: 500,
        mintMode: "core",
        rarity: { maxBoost: 0.8, boostCurve: 0.22 },
      },
      prices: { goblintownUsd: 0.0001512, solUsd: 170 },
      nowMs: 1_770_000_000_000,
      ttlMs: 180_000,
      treasuryWallet: "Treasury111111111111111111111111111111111",
    });

    expect(quote.targetUsd).toBe(2.5);
    expect(quote.opsReserveUsd).toBe(0.35);
    expect(quote.burnUsd).toBeCloseTo(2.15, 8);
    expect(quote.burnUiAmount).toBeCloseTo(14219.57671957672, 8);
    expect(quote.burnBaseUnits).toBe("14219576720");
    expect(quote.reserveLamports).toBe(2058824);
    expect(quote.royaltyBasisPoints).toBe(500);
    expect(quote.expiresAt).toBe(1_770_000_180_000);
  });

  it("fails closed when token price would exceed the max burn clamp", () => {
    expect(() =>
      quoteOffer({
        offer: {
          id: "standard",
          version: 1,
          enabled: true,
          public: true,
          targetUsd: 2.5,
          opsReserveUsd: 0.1,
          minBurnUiAmount: 1,
          maxBurnUiAmount: 10,
          royaltyBasisPoints: 500,
          mintMode: "core",
          rarity: { maxBoost: 0.8, boostCurve: 0.22 },
        },
        prices: { goblintownUsd: 0.000001, solUsd: 170 },
        nowMs: 1000,
        ttlMs: 60_000,
        treasuryWallet: "Treasury111111111111111111111111111111111",
      }),
    ).toThrow(/outside configured bounds/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm test -- --run src/__tests__/pricing.test.ts
```

Expected: FAIL because `shared/pricing.ts` does not exist.

- [ ] **Step 3: Implement shared pricing**

Create `apps/license-forge/shared/pricing.ts`:

```ts
export type MintMode = "core" | "compressed" | "admin_free" | "offchain_preview";

export interface ForgeOffer {
  id: string;
  version: number;
  enabled: boolean;
  public: boolean;
  targetUsd: number;
  opsReserveUsd: number;
  minBurnUiAmount: number;
  maxBurnUiAmount: number;
  royaltyBasisPoints: number;
  mintMode: MintMode;
  rarity: {
    maxBoost: number;
    boostCurve: number;
  };
}

export interface PriceSnapshotInput {
  goblintownUsd: number;
  solUsd: number;
}

export interface QuoteInput {
  offer: ForgeOffer;
  prices: PriceSnapshotInput;
  nowMs: number;
  ttlMs: number;
  treasuryWallet: string;
}

export interface ForgeQuote {
  quoteIdSeed: string;
  offerId: string;
  offerVersion: number;
  targetUsd: number;
  opsReserveUsd: number;
  burnUsd: number;
  goblintownUsd: number;
  solUsd: number;
  burnUiAmount: number;
  burnBaseUnits: string;
  reserveLamports: number;
  treasuryWallet: string;
  mintMode: MintMode;
  royaltyBasisPoints: number;
  issuedAt: number;
  expiresAt: number;
}

const GOBLINTOWN_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1_000_000_000;

export function quoteOffer(input: QuoteInput): ForgeQuote {
  const { offer, prices, nowMs, ttlMs, treasuryWallet } = input;
  if (!offer.enabled) throw new Error(`Offer ${offer.id} is disabled.`);
  if (offer.targetUsd <= 0) throw new Error("Offer targetUsd must be positive.");
  if (offer.opsReserveUsd < 0 || offer.opsReserveUsd >= offer.targetUsd) {
    throw new Error("Offer opsReserveUsd must be non-negative and below targetUsd.");
  }
  if (prices.goblintownUsd <= 0 || prices.solUsd <= 0) {
    throw new Error("Price snapshot must include positive token and SOL prices.");
  }

  const burnUsd = roundUsd(offer.targetUsd - offer.opsReserveUsd);
  const burnUiAmount = burnUsd / prices.goblintownUsd;
  if (burnUiAmount < offer.minBurnUiAmount || burnUiAmount > offer.maxBurnUiAmount) {
    throw new Error(`Burn amount ${burnUiAmount} is outside configured bounds.`);
  }

  const baseMultiplier = 10 ** GOBLINTOWN_DECIMALS;
  const burnBaseUnits = BigInt(Math.ceil(burnUiAmount * baseMultiplier)).toString();
  const reserveLamports = Math.ceil((offer.opsReserveUsd / prices.solUsd) * LAMPORTS_PER_SOL);
  const issuedAt = nowMs;
  const expiresAt = nowMs + ttlMs;

  return {
    quoteIdSeed: [
      offer.id,
      offer.version,
      issuedAt,
      burnBaseUnits,
      reserveLamports,
      treasuryWallet,
    ].join(":"),
    offerId: offer.id,
    offerVersion: offer.version,
    targetUsd: offer.targetUsd,
    opsReserveUsd: offer.opsReserveUsd,
    burnUsd,
    goblintownUsd: prices.goblintownUsd,
    solUsd: prices.solUsd,
    burnUiAmount,
    burnBaseUnits,
    reserveLamports,
    treasuryWallet,
    mintMode: offer.mintMode,
    royaltyBasisPoints: offer.royaltyBasisPoints,
    issuedAt,
    expiresAt,
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
```

- [ ] **Step 4: Run the shared pricing test**

Run:

```bash
npm test -- --run src/__tests__/pricing.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing Functions price-source test**

Create `apps/license-forge/functions/src/__tests__/pricing.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { fetchDexScreenerTokenPrice, normalizePriceNumber } from "../prices.js";

describe("function pricing helpers", () => {
  it("normalizes positive decimal strings", () => {
    assert.equal(normalizePriceNumber("0.0001512", "token"), 0.0001512);
    assert.throws(() => normalizePriceNumber("0", "token"), /positive/);
    assert.throws(() => normalizePriceNumber("wat", "token"), /valid/);
  });

  it("reads the first DexScreener pair price from a fetch implementation", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ pairs: [{ priceUsd: "0.0001512" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const price = await fetchDexScreenerTokenPrice("Mint111", fetchImpl);
    assert.equal(price, 0.0001512);
  });
});
```

- [ ] **Step 6: Run the Functions pricing test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm --prefix functions test
```

Expected: FAIL because `functions/src/prices.ts` does not exist.

- [ ] **Step 7: Implement Functions price helpers and quote route**

Create `apps/license-forge/functions/src/prices.ts`:

```ts
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function normalizePriceNumber(raw: unknown, label: string): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) throw new Error(`${label} price must be valid.`);
  if (value <= 0) throw new Error(`${label} price must be positive.`);
  return value;
}

export async function fetchDexScreenerTokenPrice(
  mint: string,
  fetchImpl: FetchLike = fetch,
): Promise<number> {
  const res = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
  const body = (await res.json()) as { pairs?: Array<{ priceUsd?: string }> };
  const pair = body.pairs?.find((item) => item.priceUsd);
  if (!pair) throw new Error("DexScreener returned no priced pairs.");
  return normalizePriceNumber(pair.priceUsd, "goblintown");
}

export async function fetchCoinGeckoSolPrice(fetchImpl: FetchLike = fetch): Promise<number> {
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const body = (await res.json()) as { solana?: { usd?: number } };
  return normalizePriceNumber(body.solana?.usd, "SOL");
}
```

Create `apps/license-forge/functions/src/quotes.ts`:

```ts
import { createHash } from "node:crypto";
import type { ForgeOffer, ForgeQuote, PriceSnapshotInput } from "../../shared/pricing.js";
import { quoteOffer } from "../../shared/pricing.js";

export const DEFAULT_STANDARD_OFFER: ForgeOffer = {
  id: "standard",
  version: 1,
  enabled: true,
  public: true,
  targetUsd: 2.5,
  opsReserveUsd: 0.35,
  minBurnUiAmount: 1,
  maxBurnUiAmount: 100_000,
  royaltyBasisPoints: 500,
  mintMode: "core",
  rarity: { maxBoost: 0.8, boostCurve: 0.22 },
};

export function createQuote(params: {
  offer?: ForgeOffer;
  prices: PriceSnapshotInput;
  nowMs: number;
  treasuryWallet: string;
}): ForgeQuote & { quoteId: string } {
  const quote = quoteOffer({
    offer: params.offer ?? DEFAULT_STANDARD_OFFER,
    prices: params.prices,
    nowMs: params.nowMs,
    ttlMs: 180_000,
    treasuryWallet: params.treasuryWallet,
  });
  const quoteId = createHash("sha256").update(quote.quoteIdSeed).digest("hex").slice(0, 32);
  return { ...quote, quoteId };
}
```

Modify `apps/license-forge/functions/src/index.ts` to add a quote route:

```ts
import express from "express";
import { onRequest } from "firebase-functions/v2/https";
import { GOBLINTOWN_MINT } from "../../shared/config.js";
import { createQuote } from "./quotes.js";
import { fetchCoinGeckoSolPrice, fetchDexScreenerTokenPrice } from "./prices.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "goblintown-license-forge" });
});

app.post("/api/quote", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  if (!wallet) {
    res.status(400).json({ error: "wallet is required" });
    return;
  }
  try {
    const treasuryWallet = process.env.FORGE_TREASURY_WALLET ?? "";
    if (!treasuryWallet) throw new Error("FORGE_TREASURY_WALLET is not configured.");
    const [goblintownUsd, solUsd] = await Promise.all([
      fetchDexScreenerTokenPrice(GOBLINTOWN_MINT),
      fetchCoinGeckoSolPrice(),
    ]);
    const quote = createQuote({
      prices: { goblintownUsd, solUsd },
      nowMs: Date.now(),
      treasuryWallet,
    });
    res.json({ ...quote, wallet });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export const api = onRequest({ region: "us-central1", timeoutSeconds: 120, memory: "1GiB" }, app);
```

- [ ] **Step 8: Run pricing checks**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm test -- --run src/__tests__/pricing.test.ts
npm --prefix functions test
npm run functions:build
```

Expected: all pass.

- [ ] **Step 9: Commit**

Run:

```bash
git add apps/license-forge
git commit -m "feat: add forge pricing quotes"
```

## Task 3: Implement Deterministic Trait Engine

**Files:**
- Create: `apps/license-forge/shared/traits.ts`
- Create: `apps/license-forge/src/__tests__/traits.test.ts`
- Create: `apps/license-forge/functions/assets/starter-traits/manifest.json`
- Create: `apps/license-forge/functions/assets/starter-traits/base-head.svg`
- Create: `apps/license-forge/functions/assets/starter-traits/eyes-galaxy.svg`
- Create: `apps/license-forge/functions/assets/starter-traits/mouth-wet-cigarette.svg`
- Create: `apps/license-forge/functions/assets/starter-traits/background-dmv.svg`

- [ ] **Step 1: Write failing trait engine tests**

Create `apps/license-forge/src/__tests__/traits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { calculateLootBoost, rollTraits, type TraitPack } from "../../shared/traits";

const pack: TraitPack = {
  id: "starter",
  version: 1,
  categories: ["eyes", "mouth"],
  traits: [
    {
      id: "eyes-dot",
      name: "Dot Eyes",
      rarity_weight: 100,
      imagePath: "eyes-dot.svg",
      category: "eyes",
      zIndex: 10,
      anchorX: 0,
      anchorY: 0,
      colorOverlayAllowed: false,
      incompatibleTraits: [],
      rare: false,
    },
    {
      id: "eyes-galaxy",
      name: "Eyeballs Made Of Galaxies",
      rarity_weight: 1,
      imagePath: "eyes-galaxy.svg",
      category: "eyes",
      zIndex: 10,
      anchorX: 0,
      anchorY: 0,
      colorOverlayAllowed: false,
      incompatibleTraits: [],
      rare: true,
    },
    {
      id: "mouth-grin",
      name: "Municipal Grin",
      rarity_weight: 100,
      imagePath: "mouth-grin.svg",
      category: "mouth",
      zIndex: 20,
      anchorX: 0,
      anchorY: 0,
      colorOverlayAllowed: false,
      incompatibleTraits: ["eyes-galaxy"],
      rare: false,
    },
    {
      id: "mouth-cigarette",
      name: "Wet Cigarette Mouth",
      rarity_weight: 1,
      imagePath: "mouth-cigarette.svg",
      category: "mouth",
      zIndex: 20,
      anchorX: 0,
      anchorY: 0,
      colorOverlayAllowed: false,
      incompatibleTraits: [],
      rare: true,
    },
  ],
};

describe("trait engine", () => {
  it("calculates a capped logarithmic loot boost", () => {
    expect(calculateLootBoost(0, { maxBoost: 0.8, boostCurve: 0.22 })).toBe(0);
    expect(calculateLootBoost(100, { maxBoost: 0.8, boostCurve: 0.22 })).toBeCloseTo(0.4409, 3);
    expect(calculateLootBoost(1_000_000, { maxBoost: 0.8, boostCurve: 0.22 })).toBe(0.8);
  });

  it("rolls deterministically from the same seed", () => {
    const a = rollTraits({ pack, seed: "wallet:sig:1", lootBoost: 0.2 });
    const b = rollTraits({ pack, seed: "wallet:sig:1", lootBoost: 0.2 });
    expect(a.traits.map((t) => t.id)).toEqual(b.traits.map((t) => t.id));
    expect(a.rarityScore).toBe(b.rarityScore);
  });

  it("does not return incompatible trait combinations", () => {
    for (let i = 0; i < 40; i += 1) {
      const roll = rollTraits({ pack, seed: `seed-${i}`, lootBoost: 0.8 });
      const ids = roll.traits.map((t) => t.id);
      expect(ids.includes("eyes-galaxy") && ids.includes("mouth-grin")).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the trait tests to verify they fail**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm test -- --run src/__tests__/traits.test.ts
```

Expected: FAIL because `shared/traits.ts` does not exist.

- [ ] **Step 3: Implement the trait engine**

Create `apps/license-forge/shared/traits.ts`:

```ts
export type TraitCategory =
  | "eyes"
  | "nose"
  | "ears"
  | "mouth"
  | "hat_hair"
  | "shirt"
  | "extras"
  | "background"
  | "rare_mutations";

export interface TraitEntry {
  id: string;
  name: string;
  rarity_weight: number;
  imagePath: string;
  category: TraitCategory;
  zIndex: number;
  anchorX: number;
  anchorY: number;
  colorOverlayAllowed: boolean;
  incompatibleTraits: string[];
  rare: boolean;
}

export interface TraitPack {
  id: string;
  version: number;
  categories: TraitCategory[];
  traits: TraitEntry[];
}

export interface LootBoostConfig {
  maxBoost: number;
  boostCurve: number;
}

export interface TraitRollResult {
  seed: string;
  traits: TraitEntry[];
  rarityScore: number;
  rareCount: number;
}

export function calculateLootBoost(loot: number, config: LootBoostConfig): number {
  const safeLoot = Math.max(0, Math.floor(loot));
  const raw = Math.log10(safeLoot + 1) * config.boostCurve;
  return Math.max(0, Math.min(config.maxBoost, Number(raw.toFixed(6))));
}

export function rollTraits(input: {
  pack: TraitPack;
  seed: string;
  lootBoost: number;
}): TraitRollResult {
  const rng = seededRng(input.seed);
  const selected: TraitEntry[] = [];
  const selectedIds = new Set<string>();

  for (const category of input.pack.categories) {
    const candidates = input.pack.traits.filter((trait) => trait.category === category);
    if (candidates.length === 0) throw new Error(`Trait category ${category} has no candidates.`);
    let picked: TraitEntry | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = pickWeighted(candidates, rng, input.lootBoost);
      if (isCompatible(candidate, selectedIds)) {
        picked = candidate;
        break;
      }
    }
    if (!picked) {
      picked = candidates.find((candidate) => !candidate.rare && isCompatible(candidate, selectedIds)) ?? candidates[0];
    }
    if (!isCompatible(picked, selectedIds)) {
      throw new Error(`Could not resolve compatible trait for ${category}.`);
    }
    selected.push(picked);
    selectedIds.add(picked.id);
  }

  const sorted = selected.slice().sort((a, b) => a.zIndex - b.zIndex);
  const rareCount = sorted.filter((trait) => trait.rare).length;
  const rarityScore = sorted.reduce((score, trait) => score + (trait.rare ? 1000 : 100 / trait.rarity_weight), 0);
  return { seed: input.seed, traits: sorted, rareCount, rarityScore: Number(rarityScore.toFixed(4)) };
}

function pickWeighted(traits: TraitEntry[], rng: () => number, lootBoost: number): TraitEntry {
  const weighted = traits.map((trait) => ({
    trait,
    weight: trait.rarity_weight * (trait.rare ? 1 + lootBoost : 1),
  }));
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let cursor = rng() * total;
  for (const item of weighted) {
    cursor -= item.weight;
    if (cursor <= 0) return item.trait;
  }
  return weighted[weighted.length - 1].trait;
}

function isCompatible(trait: TraitEntry, selectedIds: Set<string>): boolean {
  if (trait.incompatibleTraits.some((id) => selectedIds.has(id))) return false;
  for (const id of selectedIds) {
    if (trait.incompatibleTraits.includes(id)) return false;
  }
  return true;
}

function seededRng(seed: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- [ ] **Step 4: Add the starter trait pack assets**

Create `apps/license-forge/functions/assets/starter-traits/manifest.json`:

```json
{
  "id": "starter",
  "version": 1,
  "categories": ["background", "eyes", "mouth"],
  "traits": [
    {
      "id": "background-dmv",
      "name": "Condemned DMV Counter",
      "rarity_weight": 100,
      "imagePath": "background-dmv.svg",
      "category": "background",
      "zIndex": 0,
      "anchorX": 0,
      "anchorY": 0,
      "colorOverlayAllowed": false,
      "incompatibleTraits": [],
      "rare": false
    },
    {
      "id": "eyes-galaxy",
      "name": "Eyeballs Made Of Galaxies",
      "rarity_weight": 1,
      "imagePath": "eyes-galaxy.svg",
      "category": "eyes",
      "zIndex": 10,
      "anchorX": 0,
      "anchorY": 0,
      "colorOverlayAllowed": false,
      "incompatibleTraits": [],
      "rare": true
    },
    {
      "id": "mouth-wet-cigarette",
      "name": "Wet Cigarette Mouth",
      "rarity_weight": 1,
      "imagePath": "mouth-wet-cigarette.svg",
      "category": "mouth",
      "zIndex": 20,
      "anchorX": 0,
      "anchorY": 0,
      "colorOverlayAllowed": false,
      "incompatibleTraits": [],
      "rare": true
    }
  ]
}
```

Create the SVG files with simple vector shapes so compositor tests have real assets. Example `apps/license-forge/functions/assets/starter-traits/background-dmv.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760">
  <rect width="1200" height="760" fill="#40351b"/>
  <rect x="40" y="40" width="1120" height="680" fill="#c5c06b" stroke="#17120b" stroke-width="12"/>
  <text x="80" y="120" font-family="monospace" font-size="52" fill="#17120b">GOBLINTOWN DMV</text>
</svg>
```

- [ ] **Step 5: Run trait tests**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm test -- --run src/__tests__/traits.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/license-forge
git commit -m "feat: add deterministic trait engine"
```

## Task 4: Build And Verify Token-2022 Burn Transactions

**Files:**
- Create: `apps/license-forge/shared/solanaForge.ts`
- Create: `apps/license-forge/src/__tests__/solanaForge.test.ts`
- Create: `apps/license-forge/functions/src/solanaVerify.ts`
- Create: `apps/license-forge/functions/src/__tests__/solanaVerify.test.ts`

- [ ] **Step 1: Write failing frontend transaction-builder test**

Create `apps/license-forge/src/__tests__/solanaForge.test.ts`:

```ts
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { buildForgeTransaction } from "../../shared/solanaForge";
import { TOKEN_2022_PROGRAM_ID_STRING } from "../../shared/config";

describe("buildForgeTransaction", () => {
  it("adds Token-2022 burn and SOL reserve transfer instructions", () => {
    const wallet = new PublicKey("11111111111111111111111111111112");
    const tokenAccount = new PublicKey("11111111111111111111111111111113");
    const treasury = new PublicKey("11111111111111111111111111111114");
    const mint = new PublicKey("DJ15QJxVPFGv6kYhT6LvDGqG9b4aBFWQzavA7dGxpump");
    const tx = buildForgeTransaction({
      wallet,
      goblintownTokenAccount: tokenAccount,
      mint,
      treasury,
      burnBaseUnits: "14219576720",
      reserveLamports: 2058824,
      latestBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
    });

    expect(tx.feePayer?.toBase58()).toBe(wallet.toBase58());
    expect(tx.instructions).toHaveLength(2);
    expect(tx.instructions[0].programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID_STRING);
    expect(tx.instructions[1].programId.toBase58()).toBe("11111111111111111111111111111111");
  });
});
```

- [ ] **Step 2: Run the frontend Solana test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm test -- --run src/__tests__/solanaForge.test.ts
```

Expected: FAIL because `shared/solanaForge.ts` does not exist.

- [ ] **Step 3: Implement the transaction builder**

Create `apps/license-forge/shared/solanaForge.ts`:

```ts
import { createBurnCheckedInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

export interface BuildForgeTransactionInput {
  wallet: PublicKey;
  goblintownTokenAccount: PublicKey;
  mint: PublicKey;
  treasury: PublicKey;
  burnBaseUnits: string;
  reserveLamports: number;
  latestBlockhash: string;
}

export function buildForgeTransaction(input: BuildForgeTransactionInput): Transaction {
  const burnAmount = BigInt(input.burnBaseUnits);
  if (burnAmount <= 0n) throw new Error("burnBaseUnits must be positive");
  if (!Number.isSafeInteger(input.reserveLamports) || input.reserveLamports < 0) {
    throw new Error("reserveLamports must be a safe non-negative integer");
  }

  const tx = new Transaction({
    feePayer: input.wallet,
    recentBlockhash: input.latestBlockhash,
  });
  tx.add(
    createBurnCheckedInstruction(
      input.goblintownTokenAccount,
      input.mint,
      input.wallet,
      burnAmount,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  if (input.reserveLamports > 0) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: input.wallet,
        toPubkey: input.treasury,
        lamports: input.reserveLamports,
      }),
    );
  }
  return tx;
}
```

- [ ] **Step 4: Write failing backend transaction verifier test**

Create `apps/license-forge/functions/src/__tests__/solanaVerify.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { verifyParsedForgeTransaction } from "../solanaVerify.js";

describe("verifyParsedForgeTransaction", () => {
  it("accepts a finalized transaction with the expected Token-2022 burn and reserve transfer", () => {
    const result = verifyParsedForgeTransaction({
      wallet: "Wallet1111111111111111111111111111111111",
      mint: "DJ15QJxVPFGv6kYhT6LvDGqG9b4aBFWQzavA7dGxpump",
      treasuryWallet: "Treasury111111111111111111111111111111111",
      burnBaseUnits: "14219576720",
      reserveLamports: 2058824,
      transaction: {
        meta: { err: null },
        transaction: {
          message: {
            accountKeys: [{ pubkey: "Wallet1111111111111111111111111111111111", signer: true }],
            instructions: [
              {
                programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
                parsed: {
                  type: "burnChecked",
                  info: {
                    mint: "DJ15QJxVPFGv6kYhT6LvDGqG9b4aBFWQzavA7dGxpump",
                    owner: "Wallet1111111111111111111111111111111111",
                    tokenAmount: { amount: "14219576720", decimals: 6 },
                  },
                },
              },
              {
                programId: "11111111111111111111111111111111",
                parsed: {
                  type: "transfer",
                  info: {
                    source: "Wallet1111111111111111111111111111111111",
                    destination: "Treasury111111111111111111111111111111111",
                    lamports: 2058824,
                  },
                },
              },
            ],
          },
        },
      },
    });
    assert.equal(result.ok, true);
  });
});
```

- [ ] **Step 5: Run backend verifier test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm --prefix functions test
```

Expected: FAIL because `functions/src/solanaVerify.ts` does not exist.

- [ ] **Step 6: Implement parsed transaction verifier**

Create `apps/license-forge/functions/src/solanaVerify.ts`:

```ts
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface VerifyParsedInput {
  wallet: string;
  mint: string;
  treasuryWallet: string;
  burnBaseUnits: string;
  reserveLamports: number;
  transaction: {
    meta?: { err?: unknown } | null;
    transaction?: {
      message?: {
        accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>;
        instructions?: Array<{
          programId?: string;
          parsed?: {
            type?: string;
            info?: Record<string, unknown>;
          };
        }>;
      };
    };
  };
}

export interface VerifyParsedResult {
  ok: boolean;
  errors: string[];
}

export function verifyParsedForgeTransaction(input: VerifyParsedInput): VerifyParsedResult {
  const errors: string[] = [];
  if (input.transaction.meta?.err) errors.push("transaction failed on chain");
  const message = input.transaction.transaction?.message;
  const signerFound = (message?.accountKeys ?? []).some((key) => {
    if (typeof key === "string") return key === input.wallet;
    return key.pubkey === input.wallet && key.signer === true;
  });
  if (!signerFound) errors.push("wallet did not sign transaction");

  const instructions = message?.instructions ?? [];
  const burnFound = instructions.some((ix) => {
    const info = ix.parsed?.info ?? {};
    const amount = tokenAmount(info);
    return ix.programId === TOKEN_2022_PROGRAM &&
      (ix.parsed?.type === "burnChecked" || ix.parsed?.type === "burn") &&
      info.mint === input.mint &&
      info.owner === input.wallet &&
      amount === input.burnBaseUnits;
  });
  if (!burnFound) errors.push("expected Token-2022 burn was not found");

  const transferFound = input.reserveLamports === 0 || instructions.some((ix) => {
    const info = ix.parsed?.info ?? {};
    return ix.programId === SYSTEM_PROGRAM &&
      ix.parsed?.type === "transfer" &&
      info.source === input.wallet &&
      info.destination === input.treasuryWallet &&
      Number(info.lamports) >= input.reserveLamports;
  });
  if (!transferFound) errors.push("expected ops reserve transfer was not found");

  return { ok: errors.length === 0, errors };
}

function tokenAmount(info: Record<string, unknown>): string | undefined {
  if (typeof info.amount === "string") return info.amount;
  const tokenAmountValue = info.tokenAmount as { amount?: unknown } | undefined;
  return typeof tokenAmountValue?.amount === "string" ? tokenAmountValue.amount : undefined;
}
```

- [ ] **Step 7: Wire verification route skeleton**

Modify `apps/license-forge/functions/src/index.ts` to import `verifyParsedForgeTransaction` and add:

```ts
app.post("/api/forge/verify", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  if (!signature) {
    res.status(400).json({ error: "signature is required" });
    return;
  }
  res.status(501).json({
    error: "chain RPC verification is wired in the next task",
    signature,
  });
});
```

- [ ] **Step 8: Run Solana checks**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm test -- --run src/__tests__/solanaForge.test.ts
npm --prefix functions test
npm run functions:build
```

Expected: all pass.

- [ ] **Step 9: Commit**

Run:

```bash
git add apps/license-forge
git commit -m "feat: add token burn transaction verification"
```

## Task 5: Add Firebase Persistence And Forge Request State

**Files:**
- Create: `apps/license-forge/functions/src/admin.ts`
- Modify: `apps/license-forge/functions/src/index.ts`
- Create: `apps/license-forge/functions/src/forgeRequests.ts`
- Create: `apps/license-forge/functions/src/__tests__/forgeRequests.test.ts`

- [ ] **Step 1: Write failing request state test**

Create `apps/license-forge/functions/src/__tests__/forgeRequests.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildForgeRequestRecord } from "../forgeRequests.js";

describe("buildForgeRequestRecord", () => {
  it("stores deterministic request state from a verified transaction", () => {
    const record = buildForgeRequestRecord({
      quoteId: "quote-1",
      signature: "sig-1",
      wallet: "wallet-1",
      offerId: "standard",
      offerVersion: 1,
      burnBaseUnits: "14219576720",
      reserveLamports: 2058824,
      nowIso: "2026-05-27T00:00:00.000Z",
    });
    assert.equal(record.id, "sig-1");
    assert.equal(record.status, "verified");
    assert.equal(record.seedMaterial, "wallet-1:sig-1:standard:1");
  });
});
```

- [ ] **Step 2: Run request state test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm --prefix functions test
```

Expected: FAIL because `functions/src/forgeRequests.ts` does not exist.

- [ ] **Step 3: Implement request state builder**

Create `apps/license-forge/functions/src/forgeRequests.ts`:

```ts
export interface BuildForgeRequestInput {
  quoteId: string;
  signature: string;
  wallet: string;
  offerId: string;
  offerVersion: number;
  burnBaseUnits: string;
  reserveLamports: number;
  nowIso: string;
}

export interface ForgeRequestRecord {
  id: string;
  quoteId: string;
  signature: string;
  wallet: string;
  offerId: string;
  offerVersion: number;
  burnBaseUnits: string;
  reserveLamports: number;
  seedMaterial: string;
  status: "verified" | "generated" | "minted" | "failed";
  createdAt: string;
  updatedAt: string;
}

export function buildForgeRequestRecord(input: BuildForgeRequestInput): ForgeRequestRecord {
  return {
    id: input.signature,
    quoteId: input.quoteId,
    signature: input.signature,
    wallet: input.wallet,
    offerId: input.offerId,
    offerVersion: input.offerVersion,
    burnBaseUnits: input.burnBaseUnits,
    reserveLamports: input.reserveLamports,
    seedMaterial: `${input.wallet}:${input.signature}:${input.offerId}:${input.offerVersion}`,
    status: "verified",
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };
}
```

- [ ] **Step 4: Add Firebase Admin helpers**

Create `apps/license-forge/functions/src/admin.ts`:

```ts
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

export function adminApp() {
  if (getApps().length > 0) return getApps()[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    return initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  return initializeApp();
}

export function firestore() {
  return getFirestore(adminApp());
}

export function storageBucket() {
  const bucket = process.env.FIREBASE_STORAGE_BUCKET || "goblintown-88fd6.firebasestorage.app";
  return getStorage(adminApp()).bucket(bucket);
}

export async function requireFirebaseUid(authHeader: string | undefined): Promise<string> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  if (!token) throw new Error("Firebase bearer token is required.");
  const decoded = await getAuth(adminApp()).verifyIdToken(token);
  return decoded.uid;
}

export async function requireAdminUid(authHeader: string | undefined): Promise<string> {
  const uid = await requireFirebaseUid(authHeader);
  const allowlist = (process.env.FORGE_ADMIN_UIDS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!allowlist.includes(uid)) throw new Error("Admin access denied.");
  return uid;
}
```

- [ ] **Step 5: Wire quote persistence and idempotent verify state**

Modify the quote route in `apps/license-forge/functions/src/index.ts`:

```ts
import { firestore } from "./admin.js";
```

Inside `app.post("/api/quote"...)`, after `const quote = createQuote(...)`, add:

```ts
await firestore().collection("forgeQuotes").doc(quote.quoteId).set({
  ...quote,
  wallet,
  createdAt: new Date(quote.issuedAt).toISOString(),
}, { merge: false });
```

Modify `/api/forge/verify` to create a recoverable request after the RPC verification code is added in Task 9. For now, keep the status `501`; this task's persistence helper is ready for the integration.

- [ ] **Step 6: Run persistence tests**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm --prefix functions test
npm run functions:build
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add apps/license-forge
git commit -m "feat: add forge request persistence primitives"
```

## Task 6: Add Sharp Compositor And Metadata Builder

**Files:**
- Create: `apps/license-forge/functions/src/compositor.ts`
- Create: `apps/license-forge/functions/src/metadata.ts`
- Create: `apps/license-forge/functions/src/__tests__/compositor.test.ts`
- Create: `apps/license-forge/shared/licenseMetadata.ts`
- Create: `apps/license-forge/src/__tests__/licenseMetadata.test.ts`

- [ ] **Step 1: Write failing metadata test**

Create `apps/license-forge/src/__tests__/licenseMetadata.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildLicenseMetadata } from "../../shared/licenseMetadata";

describe("buildLicenseMetadata", () => {
  it("includes marketplace fields, traits, seed, pricing, and loot boost", () => {
    const metadata = buildLicenseMetadata({
      name: "Goblintown License #000001",
      description: "VALID FOR ONE TRIP through Goblintown municipal nonsense.",
      image: "https://storage.example/license.png",
      externalUrl: "https://goblintown.example/license/1",
      attributes: [
        { trait_type: "eyes", value: "Eyeballs Made Of Galaxies" },
        { trait_type: "rarity_score", value: 1001 },
      ],
      properties: {
        wallet: "wallet",
        seed: "seed",
        offerId: "standard",
        traitPackId: "starter",
        loot: 42,
        lootBoost: 0.357,
        pricingSnapshot: { targetUsd: 2.5 },
      },
    });
    expect(metadata.name).toBe("Goblintown License #000001");
    expect(metadata.attributes).toHaveLength(2);
    expect(metadata.properties.lootBoost).toBe(0.357);
  });
});
```

- [ ] **Step 2: Run metadata test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm test -- --run src/__tests__/licenseMetadata.test.ts
```

Expected: FAIL because `shared/licenseMetadata.ts` does not exist.

- [ ] **Step 3: Implement metadata builder**

Create `apps/license-forge/shared/licenseMetadata.ts`:

```ts
export interface LicenseAttribute {
  trait_type: string;
  value: string | number;
}

export interface LicenseMetadataInput {
  name: string;
  description: string;
  image: string;
  externalUrl: string;
  attributes: LicenseAttribute[];
  properties: Record<string, unknown>;
}

export function buildLicenseMetadata(input: LicenseMetadataInput) {
  return {
    name: input.name,
    description: input.description,
    image: input.image,
    external_url: input.externalUrl,
    attributes: input.attributes,
    properties: {
      category: "image",
      files: [{ uri: input.image, type: "image/png" }],
      ...input.properties,
    },
  };
}
```

- [ ] **Step 4: Write failing compositor test**

Create `apps/license-forge/functions/src/__tests__/compositor.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import sharp from "sharp";
import { composeLicensePng } from "../compositor.js";

describe("composeLicensePng", () => {
  it("emits a non-empty PNG with code-native license text", async () => {
    const png = await composeLicensePng({
      width: 600,
      height: 380,
      layers: [],
      text: {
        goblinName: "MOLDY PERMIT",
        idNumber: "GT-000001",
        issueDate: "2026-05-27",
        expiryDate: "2027-05-27",
        rarityScore: "1001",
        flavor: "VALID FOR ONE TRIP",
      },
    });
    const meta = await sharp(png).metadata();
    assert.equal(meta.format, "png");
    assert.equal(meta.width, 600);
    assert.equal(meta.height, 380);
    assert.ok(png.length > 1000);
  });
});
```

- [ ] **Step 5: Run compositor test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm --prefix functions test
```

Expected: FAIL because `functions/src/compositor.ts` does not exist.

- [ ] **Step 6: Implement Sharp compositor**

Create `apps/license-forge/functions/src/compositor.ts`:

```ts
import sharp from "sharp";

export interface LicenseLayer {
  input: Buffer;
  zIndex: number;
  left: number;
  top: number;
}

export interface ComposeLicenseInput {
  width: number;
  height: number;
  layers: LicenseLayer[];
  text: {
    goblinName: string;
    idNumber: string;
    issueDate: string;
    expiryDate: string;
    rarityScore: string;
    flavor: string;
  };
}

export async function composeLicensePng(input: ComposeLicenseInput): Promise<Buffer> {
  const base = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}">
      <rect width="100%" height="100%" fill="#d4ca72"/>
      <rect x="18" y="18" width="${input.width - 36}" height="${input.height - 36}" fill="#efe589" stroke="#17120b" stroke-width="8"/>
      <rect x="36" y="44" width="${input.width - 72}" height="58" fill="#202915"/>
      <text x="52" y="82" font-family="monospace" font-size="28" font-weight="700" fill="#d9ff60">GOBLINTOWN DRIVER'S LICENSE</text>
      <text x="52" y="145" font-family="monospace" font-size="24" fill="#17120b">${escapeXml(input.text.goblinName)}</text>
      <text x="52" y="190" font-family="monospace" font-size="18" fill="#17120b">ID ${escapeXml(input.text.idNumber)}</text>
      <text x="52" y="224" font-family="monospace" font-size="18" fill="#17120b">ISS ${escapeXml(input.text.issueDate)}</text>
      <text x="52" y="258" font-family="monospace" font-size="18" fill="#17120b">EXP ${escapeXml(input.text.expiryDate)}</text>
      <text x="52" y="292" font-family="monospace" font-size="18" fill="#17120b">RARITY ${escapeXml(input.text.rarityScore)}</text>
      <text x="52" y="${input.height - 42}" font-family="monospace" font-size="20" font-weight="700" fill="#9c1c13">${escapeXml(input.text.flavor)}</text>
    </svg>
  `);

  const composites = input.layers
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((layer) => ({ input: layer.input, left: layer.left, top: layer.top }));

  return sharp(base)
    .composite(composites)
    .png()
    .toBuffer();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
```

- [ ] **Step 7: Run compositor and metadata checks**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm test -- --run src/__tests__/licenseMetadata.test.ts
npm --prefix functions test
npm run functions:build
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add apps/license-forge
git commit -m "feat: add license compositor and metadata"
```

## Task 7: Add Metaplex Core Mint Adapter With 5 Percent Royalties

**Files:**
- Create: `apps/license-forge/functions/src/metaplexCore.ts`
- Create: `apps/license-forge/functions/src/__tests__/metaplexCore.test.ts`
- Modify: `apps/license-forge/functions/src/index.ts`

- [ ] **Step 1: Write failing Core adapter test**

Create `apps/license-forge/functions/src/__tests__/metaplexCore.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildRoyaltyPlugin, normalizeRoyaltyBasisPoints } from "../metaplexCore.js";

describe("Metaplex Core adapter helpers", () => {
  it("normalizes 5 percent royalties as 500 basis points", () => {
    assert.equal(normalizeRoyaltyBasisPoints(500), 500);
    assert.throws(() => normalizeRoyaltyBasisPoints(10_001), /between 0 and 10000/);
  });

  it("builds a Core royalties plugin with no transfer allowlist", () => {
    const plugin = buildRoyaltyPlugin("11111111111111111111111111111112", 500);
    assert.equal(plugin.type, "Royalties");
    assert.equal(plugin.basisPoints, 500);
    assert.deepEqual(plugin.creators, [{ address: "11111111111111111111111111111112", percentage: 100 }]);
    assert.equal(plugin.ruleSet, "None");
  });
});
```

- [ ] **Step 2: Run Core adapter test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm --prefix functions test
```

Expected: FAIL because `functions/src/metaplexCore.ts` does not exist.

- [ ] **Step 3: Implement Core adapter helpers and mint skeleton**

Create `apps/license-forge/functions/src/metaplexCore.ts`:

```ts
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { create, createCollection, fetchCollection, mplCore, ruleSet } from "@metaplex-foundation/mpl-core";
import { generateSigner, publicKey } from "@metaplex-foundation/umi";
import { createSignerFromKeypair } from "@metaplex-foundation/umi-signer-web3js";
import { Keypair } from "@solana/web3.js";

export interface CoreMintInput {
  rpcUrl: string;
  minterKeypairJson: string;
  owner: string;
  name: string;
  uri: string;
  collectionAddress?: string;
}

export function normalizeRoyaltyBasisPoints(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error("royalty basis points must be between 0 and 10000");
  }
  return value;
}

export function buildRoyaltyPlugin(creatorAddress: string, basisPoints: number) {
  return {
    type: "Royalties" as const,
    basisPoints: normalizeRoyaltyBasisPoints(basisPoints),
    creators: [{ address: creatorAddress, percentage: 100 }],
    ruleSet: "None" as const,
  };
}

export async function mintCoreLicense(input: CoreMintInput): Promise<{ assetAddress: string; signature: string }> {
  const umi = createUmi(input.rpcUrl).use(mplCore());
  const secret = Uint8Array.from(JSON.parse(input.minterKeypairJson) as number[]);
  const keypair = Keypair.fromSecretKey(secret);
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey);
  umi.use(createSignerFromKeypair(umi, umiKeypair));

  const asset = generateSigner(umi);
  const args: Parameters<typeof create>[1] = {
    asset,
    name: input.name,
    uri: input.uri,
    owner: publicKey(input.owner),
  };

  if (input.collectionAddress) {
    args.collection = await fetchCollection(umi, publicKey(input.collectionAddress));
  }

  const result = await create(umi, args).sendAndConfirm(umi);
  return {
    assetAddress: asset.publicKey.toString(),
    signature: Buffer.from(result.signature).toString("base64"),
  };
}

export async function createCoreCollectionWithRoyalties(input: {
  rpcUrl: string;
  minterKeypairJson: string;
  name: string;
  uri: string;
  creatorAddress: string;
  royaltyBasisPoints: number;
}): Promise<{ collectionAddress: string; signature: string }> {
  const umi = createUmi(input.rpcUrl).use(mplCore());
  const secret = Uint8Array.from(JSON.parse(input.minterKeypairJson) as number[]);
  const keypair = Keypair.fromSecretKey(secret);
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey);
  umi.use(createSignerFromKeypair(umi, umiKeypair));
  const collection = generateSigner(umi);
  const plugin = buildRoyaltyPlugin(input.creatorAddress, input.royaltyBasisPoints);
  const result = await createCollection(umi, {
    collection,
    name: input.name,
    uri: input.uri,
    plugins: [{
      type: plugin.type,
      basisPoints: plugin.basisPoints,
      creators: [{ address: publicKey(plugin.creators[0].address), percentage: 100 }],
      ruleSet: ruleSet(plugin.ruleSet),
    }],
  }).sendAndConfirm(umi);
  return {
    collectionAddress: collection.publicKey.toString(),
    signature: Buffer.from(result.signature).toString("base64"),
  };
}
```

- [ ] **Step 4: Fix compile issues against installed Metaplex versions**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm run functions:build
```

Expected: if Metaplex type signatures differ from the docs, TypeScript points to the exact adapter lines. Adjust only `functions/src/metaplexCore.ts` so the public `mintCoreLicense` and `createCoreCollectionWithRoyalties` signatures stay stable.

- [ ] **Step 5: Run Core adapter tests**

Run:

```bash
npm --prefix functions test
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/license-forge
git commit -m "feat: add metaplex core mint adapter"
```

## Task 8: Add Warren Loot Claim Sync

**Files:**
- Create: `src/forge-loot-claim.ts`
- Create: `src/__tests__/forge-loot-claim.test.ts`
- Modify: `src/server.ts`
- Modify: `package.json`
- Modify: `docs/reference/http-api.md`
- Create: `apps/license-forge/shared/lootClaim.ts`
- Create: `apps/license-forge/functions/src/lootClaims.ts`
- Create: `apps/license-forge/functions/src/__tests__/lootClaims.test.ts`

- [ ] **Step 1: Write failing local loot claim test**

Create `src/__tests__/forge-loot-claim.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { buildLootClaimPayload, signLootClaim, verifyLootClaim } from "../forge-loot-claim.js";

describe("forge loot claims", () => {
  it("signs and verifies a canonical Warren loot claim", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const payload = buildLootClaimPayload({
      uid: "uid-1",
      wallet: "wallet-1",
      loot: 42,
      warrenName: "Angus Warren",
      issuedAt: "2026-05-27T00:00:00.000Z",
      expiresAt: "2026-05-27T00:05:00.000Z",
      nonce: "nonce-1",
    });
    const signature = signLootClaim(privateKey.export({ type: "pkcs8", format: "pem" }).toString(), payload);
    const ok = verifyLootClaim(
      publicKey.export({ type: "spki", format: "pem" }).toString(),
      payload,
      signature,
    );
    assert.equal(ok, true);
    assert.match(payload, /"loot":42/);
  });
});
```

- [ ] **Step 2: Run local claim test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge
npm run build
node --test dist/__tests__/forge-loot-claim.test.js
```

Expected: FAIL because `src/forge-loot-claim.ts` does not exist.

- [ ] **Step 3: Implement local claim helpers**

Create `src/forge-loot-claim.ts`:

```ts
import { sign, verify } from "node:crypto";

export interface LootClaimPayloadInput {
  uid: string;
  wallet: string;
  loot: number;
  warrenName: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export function buildLootClaimPayload(input: LootClaimPayloadInput): string {
  return JSON.stringify({
    type: "goblintown-forge-loot-claim-v1",
    uid: input.uid,
    wallet: input.wallet,
    loot: Math.max(0, Math.floor(input.loot)),
    warrenName: input.warrenName,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
  });
}

export function signLootClaim(privateKeyPem: string, payload: string): string {
  return sign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64");
}

export function verifyLootClaim(publicKeyPem: string, payload: string, signatureBase64: string): boolean {
  try {
    return verify(null, Buffer.from(payload, "utf8"), publicKeyPem, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Add local API endpoint**

Modify `src/server.ts` imports:

```ts
import { buildLootClaimPayload, signLootClaim } from "./forge-loot-claim.js";
```

Add this route near `/api/warren/stats`:

```ts
  app.options("/api/forge/loot-claim", (req, res) => {
    applyForgeCors(req, res);
    res.status(204).end();
  });
  app.post("/api/forge/loot-claim", async (req, res) => {
    applyForgeCors(req, res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const uid = typeof body.uid === "string" ? body.uid.trim() : "";
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
    if (!uid || !wallet || !nonce) {
      res.status(400).json({ error: "uid, wallet, and nonce are required" });
      return;
    }
    const identity = await ensureCountryIdentity(warren.root);
    const loot = await warren.hoard.allLoot();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 5 * 60_000);
    const payload = buildLootClaimPayload({
      uid,
      wallet,
      loot: loot.length,
      warrenName: warren.manifest.name,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nonce,
    });
    res.json({
      payload,
      signature: signLootClaim(identity.privateKeyPem, payload),
      publicKeyPem: identity.publicKeyPem,
    });
  });
```

Add helper function near other small server helpers:

```ts
function applyForgeCors(req: Request, res: Response): void {
  const origin = req.header("origin") ?? "";
  const allowed = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://goblintown-88fd6.web.app",
    "https://goblintown-88fd6.firebaseapp.com",
  ];
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
```

- [ ] **Step 5: Add function-side claim verification**

Create `apps/license-forge/shared/lootClaim.ts`:

```ts
export interface LootClaimBody {
  payload: string;
  signature: string;
  publicKeyPem: string;
}

export interface ParsedLootClaim {
  type: "goblintown-forge-loot-claim-v1";
  uid: string;
  wallet: string;
  loot: number;
  warrenName: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export function parseLootClaimPayload(payload: string): ParsedLootClaim {
  const parsed = JSON.parse(payload) as ParsedLootClaim;
  if (parsed.type !== "goblintown-forge-loot-claim-v1") throw new Error("unsupported claim type");
  if (!parsed.uid || !parsed.wallet || !parsed.nonce) throw new Error("claim identity fields are required");
  if (!Number.isInteger(parsed.loot) || parsed.loot < 0) throw new Error("claim loot must be a non-negative integer");
  return parsed;
}
```

Create `apps/license-forge/functions/src/lootClaims.ts`:

```ts
import { verify } from "node:crypto";
import { parseLootClaimPayload } from "../../shared/lootClaim.js";

export function verifySignedLootClaim(input: {
  uid: string;
  wallet: string;
  nonce: string;
  payload: string;
  signature: string;
  publicKeyPem: string;
  nowMs: number;
}) {
  const parsed = parseLootClaimPayload(input.payload);
  if (parsed.uid !== input.uid) throw new Error("claim uid mismatch");
  if (parsed.wallet !== input.wallet) throw new Error("claim wallet mismatch");
  if (parsed.nonce !== input.nonce) throw new Error("claim nonce mismatch");
  if (Date.parse(parsed.expiresAt) < input.nowMs) throw new Error("claim expired");
  const ok = verify(
    null,
    Buffer.from(input.payload, "utf8"),
    input.publicKeyPem,
    Buffer.from(input.signature, "base64"),
  );
  if (!ok) throw new Error("claim signature invalid");
  return parsed;
}
```

- [ ] **Step 6: Add tests to package script and docs**

Modify root `package.json` test script by inserting:

```text
dist/__tests__/forge-loot-claim.test.js
```

Add to `docs/reference/http-api.md` table:

```md
| POST | `/api/forge/loot-claim` | Local Warren signs a Firebase uid, wallet, nonce, and loot count for License Forge rarity boost. |
```

- [ ] **Step 7: Run local and app claim checks**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge
npm test
cd apps/license-forge
npm run check
```

Expected: both pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/forge-loot-claim.ts src/server.ts src/__tests__/forge-loot-claim.test.ts package.json docs/reference/http-api.md apps/license-forge
git commit -m "feat: add warren loot claim sync"
```

## Task 9: Implement Full Forge Finalization Pipeline

**Files:**
- Modify: `apps/license-forge/functions/src/index.ts`
- Modify: `apps/license-forge/functions/src/solanaVerify.ts`
- Modify: `apps/license-forge/functions/src/metadata.ts`
- Create: `apps/license-forge/functions/src/finalize.ts`
- Create: `apps/license-forge/functions/src/__tests__/finalize.test.ts`

- [ ] **Step 1: Write failing finalization idempotency test**

Create `apps/license-forge/functions/src/__tests__/finalize.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { deriveLicenseId, nextRequestStatus } from "../finalize.js";

describe("forge finalization helpers", () => {
  it("derives the same license id from the same burn signature", () => {
    assert.equal(deriveLicenseId("sig-abc"), deriveLicenseId("sig-abc"));
    assert.notEqual(deriveLicenseId("sig-abc"), deriveLicenseId("sig-def"));
  });

  it("does not regress an already minted request", () => {
    assert.equal(nextRequestStatus("verified", "generated"), "generated");
    assert.equal(nextRequestStatus("minted", "generated"), "minted");
  });
});
```

- [ ] **Step 2: Run finalization test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm --prefix functions test
```

Expected: FAIL because `functions/src/finalize.ts` does not exist.

- [ ] **Step 3: Implement finalization helpers**

Create `apps/license-forge/functions/src/finalize.ts`:

```ts
import { createHash } from "node:crypto";

export type ForgeStatus = "verified" | "generated" | "minted" | "failed";

const statusRank: Record<ForgeStatus, number> = {
  verified: 1,
  generated: 2,
  minted: 3,
  failed: 0,
};

export function deriveLicenseId(signature: string): string {
  return createHash("sha256").update(`goblintown-license:${signature}`).digest("hex").slice(0, 24);
}

export function nextRequestStatus(current: ForgeStatus, proposed: ForgeStatus): ForgeStatus {
  return statusRank[proposed] > statusRank[current] ? proposed : current;
}
```

- [ ] **Step 4: Implement chain RPC verification**

Extend `functions/src/solanaVerify.ts`:

```ts
import { Connection } from "@solana/web3.js";

export async function fetchParsedFinalizedTransaction(rpcUrl: string, signature: string) {
  const connection = new Connection(rpcUrl, "finalized");
  const tx = await connection.getParsedTransaction(signature, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error("finalized transaction not found");
  return tx;
}
```

Then update `/api/forge/verify` in `functions/src/index.ts` to:

1. Load the quote from `forgeQuotes/{quoteId}`.
2. Fetch the finalized parsed transaction using `fetchParsedFinalizedTransaction`.
3. Run `verifyParsedForgeTransaction`.
4. Store `forgeRequests/{signature}` using `buildForgeRequestRecord`.
5. Return the request record.

Use this route body shape:

```json
{
  "quoteId": "quote id from /api/quote",
  "signature": "wallet submitted transaction signature",
  "wallet": "connected wallet"
}
```

- [ ] **Step 5: Implement `/api/forge/finalize`**

Add route logic in `functions/src/index.ts`:

```ts
app.post("/api/forge/finalize", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!requestId) {
    res.status(400).json({ error: "requestId is required" });
    return;
  }
  res.status(501).json({
    error: "image storage and Core mint are connected after compositor storage wiring",
    requestId,
  });
});
```

This keeps the route visible while the next task connects image storage and minting.

- [ ] **Step 6: Run finalization checks**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm --prefix functions test
npm run functions:build
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add apps/license-forge
git commit -m "feat: verify forge burns on chain"
```

## Task 10: Connect Image Storage, Metadata, And Core Minting

**Files:**
- Modify: `apps/license-forge/functions/src/index.ts`
- Modify: `apps/license-forge/functions/src/finalize.ts`
- Modify: `apps/license-forge/functions/src/metadata.ts`
- Modify: `apps/license-forge/functions/src/metaplexCore.ts`
- Create: `apps/license-forge/functions/src/storage.ts`
- Create: `apps/license-forge/functions/src/__tests__/metadata.test.ts`

- [ ] **Step 1: Write failing stored metadata test**

Create `apps/license-forge/functions/src/__tests__/metadata.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildLicenseRecord } from "../metadata.js";

describe("buildLicenseRecord", () => {
  it("records asset, storage, trait, loot, and pricing details", () => {
    const record = buildLicenseRecord({
      licenseId: "lic-1",
      wallet: "wallet",
      assetAddress: "asset",
      imagePath: "licenses/mainnet/asset/license.png",
      metadataPath: "licenses/mainnet/asset/metadata.json",
      rarityScore: 1001,
      traits: [{ category: "eyes", name: "Galaxies" }],
      loot: 42,
      lootBoost: 0.33,
      pricingSnapshot: { targetUsd: 2.5 },
      createdAt: "2026-05-27T00:00:00.000Z",
    });
    assert.equal(record.licenseId, "lic-1");
    assert.equal(record.assetAddress, "asset");
    assert.equal(record.traits[0].category, "eyes");
  });
});
```

- [ ] **Step 2: Run metadata test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm --prefix functions test
```

Expected: FAIL because `functions/src/metadata.ts` does not export `buildLicenseRecord`.

- [ ] **Step 3: Implement license record and storage helpers**

Create or update `apps/license-forge/functions/src/metadata.ts`:

```ts
export interface BuildLicenseRecordInput {
  licenseId: string;
  wallet: string;
  assetAddress: string;
  imagePath: string;
  metadataPath: string;
  rarityScore: number;
  traits: Array<{ category: string; name: string }>;
  loot: number;
  lootBoost: number;
  pricingSnapshot: Record<string, unknown>;
  createdAt: string;
}

export function buildLicenseRecord(input: BuildLicenseRecordInput) {
  return {
    licenseId: input.licenseId,
    wallet: input.wallet,
    ownerAtMint: input.wallet,
    assetAddress: input.assetAddress,
    imagePath: input.imagePath,
    metadataPath: input.metadataPath,
    rarityScore: input.rarityScore,
    traits: input.traits,
    loot: input.loot,
    lootBoost: input.lootBoost,
    pricingSnapshot: input.pricingSnapshot,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}
```

Create `apps/license-forge/functions/src/storage.ts`:

```ts
import { storageBucket } from "./admin.js";

export async function uploadPublicJson(path: string, value: unknown): Promise<string> {
  const file = storageBucket().file(path);
  await file.save(JSON.stringify(value, null, 2), {
    contentType: "application/json",
    resumable: false,
    metadata: { cacheControl: "public, max-age=31536000, immutable" },
  });
  return `https://storage.googleapis.com/${storageBucket().name}/${path}`;
}

export async function uploadPublicPng(path: string, png: Buffer): Promise<string> {
  const file = storageBucket().file(path);
  await file.save(png, {
    contentType: "image/png",
    resumable: false,
    metadata: { cacheControl: "public, max-age=31536000, immutable" },
  });
  return `https://storage.googleapis.com/${storageBucket().name}/${path}`;
}
```

- [ ] **Step 4: Connect `/api/forge/finalize`**

Update `/api/forge/finalize` to:

1. Load `forgeRequests/{requestId}`.
2. If status is `minted`, return the existing `licenses/{licenseId}`.
3. Load active trait pack.
4. Calculate loot boost from `users/{uid}.forgeLoot` when present, otherwise zero.
5. Roll traits from `seedMaterial`.
6. Compose PNG.
7. Upload PNG.
8. Build metadata JSON and upload it.
9. Call `mintCoreLicense` with `FORGE_RPC_URL`, `FORGE_MINTER_KEYPAIR_JSON`, `FORGE_CORE_COLLECTION`, wallet owner, license name, and metadata URI.
10. Store `licenses/{licenseId}`.
11. Update request status to `minted`.

Use an explicit guard:

```ts
if (process.env.FORGE_ENABLE_MAINNET_MINT !== "1" && (process.env.FORGE_CLUSTER ?? "devnet") === "mainnet-beta") {
  throw new Error("mainnet minting requires FORGE_ENABLE_MAINNET_MINT=1");
}
```

- [ ] **Step 5: Run full Functions checks**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm --prefix functions test
npm run functions:build
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/license-forge
git commit -m "feat: finalize license image metadata and mint"
```

## Task 11: Build Public Forge UI

**Files:**
- Modify: `apps/license-forge/src/App.tsx`
- Modify: `apps/license-forge/src/styles.css`
- Create: `apps/license-forge/src/firebase.ts`
- Create: `apps/license-forge/src/api.ts`
- Create: `apps/license-forge/src/wallet.ts`
- Create: `apps/license-forge/src/components/WalletPanel.tsx`
- Create: `apps/license-forge/src/components/AuthPanel.tsx`
- Create: `apps/license-forge/src/components/OfferPanel.tsx`
- Create: `apps/license-forge/src/components/LicensePreview.tsx`
- Create: `apps/license-forge/src/components/MunicipalLog.tsx`
- Create: `apps/license-forge/src/components/ForgeResult.tsx`
- Create: `apps/license-forge/src/__tests__/App.test.tsx`

Before coding this task, invoke `build-web-apps:frontend-app-builder` and `imagegen` for the accepted visual concept, because this is the primary visually driven app surface.

- [ ] **Step 1: Write failing App test**

Create `apps/license-forge/src/__tests__/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../App";

describe("App", () => {
  it("renders the public forge workflow and cursed municipal labels", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /Goblintown Driver's License Forge/i })).toBeInTheDocument();
    expect(screen.getByText(/VALID FOR ONE TRIP/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect Phantom/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Forge License/i })).toBeDisabled();
    expect(screen.getByText(/municipal logs/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run App test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm test -- --run src/__tests__/App.test.tsx
```

Expected: FAIL because the current App lacks the workflow controls.

- [ ] **Step 3: Implement API helper**

Create `apps/license-forge/src/api.ts`:

```ts
export async function apiPost<T>(path: string, body: unknown, idToken?: string): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}
```

Create `apps/license-forge/src/firebase.ts`:

```ts
import { initializeApp } from "firebase/app";
import { GithubAuthProvider, GoogleAuthProvider, getAuth, signInWithPopup, signOut } from "firebase/auth";
import { firebaseClientConfig } from "./shared/config";

const app = initializeApp(firebaseClientConfig());
export const auth = getAuth(app);

export function signInWithGoogle() {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export function signInWithGitHub() {
  return signInWithPopup(auth, new GithubAuthProvider());
}

export function signOutFirebase() {
  return signOut(auth);
}
```

- [ ] **Step 4: Implement app state and components**

Update `apps/license-forge/src/App.tsx` to compose the components and keep Forge disabled until wallet and quote are ready:

```tsx
import { useState } from "react";
import { AuthPanel } from "./components/AuthPanel";
import { ForgeResult } from "./components/ForgeResult";
import { LicensePreview } from "./components/LicensePreview";
import { MunicipalLog } from "./components/MunicipalLog";
import { OfferPanel } from "./components/OfferPanel";
import { WalletPanel } from "./components/WalletPanel";

export function App() {
  const [wallet, setWallet] = useState<string>("");
  const [quoteReady, setQuoteReady] = useState(false);
  const [logs, setLogs] = useState<string[]>([
    "municipal logs: counter open",
    "warning: laminate fumes may affect judgment",
  ]);

  return (
    <main className="forge-shell">
      <section className="forge-board" aria-label="Goblintown Driver's License Forge">
        <p className="stamp">Department of Cursed Motor Wagons</p>
        <h1>Goblintown Driver's License Forge</h1>
        <p className="notice">VALID FOR ONE TRIP. PAY THE MUNICIPAL BURN. DO NOT LICK THE LAMINATE.</p>
        <div className="forge-grid">
          <div className="forge-stack">
            <WalletPanel wallet={wallet} onWallet={setWallet} />
            <AuthPanel />
            <OfferPanel wallet={wallet} onQuoteReady={setQuoteReady} />
            <button className="forge-button" type="button" disabled={!wallet || !quoteReady}>
              Forge License
            </button>
          </div>
          <LicensePreview />
          <MunicipalLog logs={logs} />
        </div>
        <ForgeResult />
      </section>
    </main>
  );
}
```

Create simple initial components. Example `WalletPanel.tsx`:

```tsx
interface WalletPanelProps {
  wallet: string;
  onWallet: (wallet: string) => void;
}

export function WalletPanel({ wallet, onWallet }: WalletPanelProps) {
  return (
    <section className="panel">
      <h2>Wallet Counter</h2>
      <button type="button" onClick={() => onWallet("demo-wallet")} className="pixel-button">
        Connect Phantom
      </button>
      <p>{wallet ? `connected: ${wallet}` : "no wallet detected in the sewer grate"}</p>
    </section>
  );
}
```

Replace the demo wallet handler with real Phantom connection in the next step.

- [ ] **Step 5: Implement real Phantom connection**

Create `apps/license-forge/src/wallet.ts`:

```ts
export interface PhantomProvider {
  isPhantom?: boolean;
  connect: () => Promise<{ publicKey: { toBase58: () => string } }>;
  signAndSendTransaction: (transaction: unknown) => Promise<{ signature: string }>;
}

declare global {
  interface Window {
    solana?: PhantomProvider;
  }
}

export async function connectPhantom(): Promise<string> {
  const provider = window.solana;
  if (!provider?.isPhantom) throw new Error("Phantom wallet was not found.");
  const result = await provider.connect();
  return result.publicKey.toBase58();
}
```

Update `WalletPanel` to call `connectPhantom`.

- [ ] **Step 6: Update styling to match the approved direction**

Update `styles.css` with:

- chunky rectangular panels;
- no corporate cards;
- high-contrast municipal warning labels;
- pixel-ish monospace UI;
- responsive grid that collapses below `800px`;
- button states with stable dimensions.

Run a visual QA pass with the Browser plugin after implementing CSS.

- [ ] **Step 7: Run frontend checks**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm test -- --run src/__tests__/App.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 8: Start dev server and inspect**

Run:

```bash
npm run dev -- --port 5173
```

Open `http://127.0.0.1:5173` with the Browser plugin. Verify desktop and mobile widths, click Connect Phantom fallback behavior, and confirm text does not overlap.

- [ ] **Step 9: Commit**

Run:

```bash
git add apps/license-forge
git commit -m "feat: build public license forge ui"
```

## Task 12: Add Admin Panel And Offer/Trait Management

**Files:**
- Create: `apps/license-forge/src/components/AdminPanel.tsx`
- Create: `apps/license-forge/src/__tests__/AdminPanel.test.tsx`
- Create: `apps/license-forge/functions/src/adminRoutes.ts`
- Create: `apps/license-forge/functions/src/__tests__/adminRoutes.test.ts`
- Modify: `apps/license-forge/functions/src/index.ts`
- Modify: `apps/license-forge/src/App.tsx`

- [ ] **Step 1: Write failing admin allowlist test**

Create `apps/license-forge/functions/src/__tests__/adminRoutes.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isUidAllowed } from "../adminRoutes.js";

describe("admin routes", () => {
  it("checks comma-separated Firebase UID allowlist", () => {
    assert.equal(isUidAllowed("uid-a", "uid-a,uid-b"), true);
    assert.equal(isUidAllowed("uid-c", "uid-a,uid-b"), false);
  });
});
```

- [ ] **Step 2: Run admin test to verify it fails**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm --prefix functions test
```

Expected: FAIL because `functions/src/adminRoutes.ts` does not exist.

- [ ] **Step 3: Implement admin route helpers**

Create `apps/license-forge/functions/src/adminRoutes.ts`:

```ts
export function isUidAllowed(uid: string, allowlist: string): boolean {
  return allowlist.split(",").map((item) => item.trim()).filter(Boolean).includes(uid);
}

export function normalizeOfferPatch(raw: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  if (typeof raw.enabled === "boolean") patch.enabled = raw.enabled;
  if (typeof raw.targetUsd === "number" && raw.targetUsd > 0) patch.targetUsd = raw.targetUsd;
  if (typeof raw.opsReserveUsd === "number" && raw.opsReserveUsd >= 0) patch.opsReserveUsd = raw.opsReserveUsd;
  if (typeof raw.royaltyBasisPoints === "number") patch.royaltyBasisPoints = raw.royaltyBasisPoints;
  patch.updatedAt = new Date().toISOString();
  return patch;
}
```

- [ ] **Step 4: Wire admin endpoints**

In `functions/src/index.ts`, add:

- `POST /api/admin/offers`: require `requireAdminUid`, validate offer patch, write `forgeOffers/{offerId}`, write `adminAudit`.
- `POST /api/admin/traits`: require admin, store trait pack manifest, write `traitPacks/{id}`.
- `POST /api/admin/mint`: require admin, create a no-burn request and call finalization using `mintMode: "admin_free"`.

All admin responses include `{ ok: true, adminUid }` on success.

- [ ] **Step 5: Write failing admin UI test**

Create `apps/license-forge/src/__tests__/AdminPanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminPanel } from "../components/AdminPanel";

describe("AdminPanel", () => {
  it("renders hidden municipal controls when admin is true", () => {
    render(<AdminPanel admin />);
    expect(screen.getByText(/Unexposed Permit Office/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Offer/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Admin Mint/i })).toBeInTheDocument();
  });

  it("renders nothing for non-admin users", () => {
    const { container } = render(<AdminPanel admin={false} />);
    expect(container.textContent).toBe("");
  });
});
```

- [ ] **Step 6: Implement admin panel**

Create `apps/license-forge/src/components/AdminPanel.tsx`:

```tsx
interface AdminPanelProps {
  admin: boolean;
}

export function AdminPanel({ admin }: AdminPanelProps) {
  if (!admin) return null;
  return (
    <section className="panel admin-panel">
      <h2>Unexposed Permit Office</h2>
      <label>
        Target USD
        <input name="targetUsd" inputMode="decimal" defaultValue="2.50" />
      </label>
      <label>
        Ops Reserve USD
        <input name="opsReserveUsd" inputMode="decimal" defaultValue="0.35" />
      </label>
      <div className="admin-actions">
        <button type="button" className="pixel-button">Save Offer</button>
        <button type="button" className="pixel-button">Admin Mint</button>
      </div>
    </section>
  );
}
```

- [ ] **Step 7: Run admin checks**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm test -- --run src/__tests__/AdminPanel.test.tsx
npm --prefix functions test
npm run check
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add apps/license-forge
git commit -m "feat: add license forge admin controls"
```

## Task 13: Add Documentation And Deployment Checks

**Files:**
- Create: `docs/features/license-forge.md`
- Modify: `README.md`
- Modify: `apps/license-forge/README.md`
- Create: `apps/license-forge/.env.example`

- [ ] **Step 1: Write deployment docs**

Create `apps/license-forge/README.md`:

```md
# Goblintown License Forge

Public Firebase-hosted forge for Goblintown Driver's License NFTs.

## Local Setup

```bash
cd apps/license-forge
npm install
npm --prefix functions install
npm run check
npm run dev -- --port 5173
```

## Required Production Environment

- `FORGE_TREASURY_WALLET`
- `FORGE_RPC_URL`
- `FORGE_MINTER_KEYPAIR_JSON`
- `FORGE_CORE_COLLECTION`
- `FORGE_ADMIN_UIDS`
- `FORGE_CLUSTER`
- `FORGE_ENABLE_MAINNET_MINT=1` for production mainnet minting

## Deploy

```bash
npx -y firebase-tools@latest deploy --only hosting,functions,firestore,storage
```
```

Create `apps/license-forge/.env.example`:

```text
VITE_FIREBASE_API_KEY=AIzaSyD2px9fRoSh6bwOBDIk2dGioYbxROQ6Leo
VITE_FIREBASE_AUTH_DOMAIN=goblintown-88fd6.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=goblintown-88fd6
VITE_FIREBASE_STORAGE_BUCKET=goblintown-88fd6.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=904412921746
VITE_FIREBASE_APP_ID=1:904412921746:web:a92c6ba51e292b0d858b4b
VITE_FIREBASE_MEASUREMENT_ID=G-C1TSNGHXYG
```

- [ ] **Step 2: Add product docs**

Create `docs/features/license-forge.md`:

```md
# Goblintown License Forge

The License Forge is a separate Firebase-hosted app under `apps/license-forge`.
It lets public wallets burn `$GOBLINTOWN`, pay the configured mint/ops reserve,
and receive tradable Metaplex Core Driver's License NFTs.

Pricing defaults to a `$2.50` target. The reserve is paid to the ops wallet and
the remainder is burned. Signed-in Goblintown users can sync a signed Warren
loot claim for a capped rarity boost.

Admin access uses the same Firebase sign-in flow and a backend UID allowlist.
```

Add a short README row near other feature links:

```md
| **License Forge** | Firebase-hosted public `$GOBLINTOWN` burn forge for tradable Driver's License NFTs with Warren loot rarity boosts. |
```

- [ ] **Step 3: Run full verification**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge
npm test
cd apps/license-forge
npm run check
npx -y firebase-tools@latest --version
```

Expected: root tests pass, forge checks pass, Firebase CLI prints a version.

- [ ] **Step 4: Browser verification**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm run dev -- --port 5173
```

Use Browser plugin at `http://127.0.0.1:5173`.

Verify:

- desktop first viewport has wallet, sign-in, offer, preview, logs, and Forge action;
- mobile viewport does not overlap text;
- Forge action remains disabled until wallet and quote are ready;
- Admin panel is hidden for normal users;
- warning labels and logs match the cursed municipal direction.

- [ ] **Step 5: Commit**

Run:

```bash
git add README.md docs/features/license-forge.md apps/license-forge
git commit -m "docs: document license forge setup"
```

## Task 14: Final Integration Audit

**Files:**
- Modify files only if verification finds a concrete defect.

- [ ] **Step 1: Run root verification**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge
npm test
```

Expected: PASS.

- [ ] **Step 2: Run forge verification**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npm run check
```

Expected: PASS.

- [ ] **Step 3: Run Firebase config validation**

Run:

```bash
cd /Users/angus/goblintown/worktrees/license-forge/apps/license-forge
npx -y firebase-tools@latest deploy --only hosting,functions,firestore,storage --dry-run
```

Expected: Firebase CLI validates config without deploying. If the CLI reports that `--dry-run` is unsupported for this deploy shape, do not run a real deploy. Record that deploy validation is blocked until the user explicitly approves a staging or production deploy.

Run this safe fallback for local config and build validation:

```bash
npx -y firebase-tools@latest --version
npm run check
```

- [ ] **Step 4: Summarize production blockers**

Create a short final note in the implementation response listing:

- whether `FORGE_MINTER_KEYPAIR_JSON` is configured;
- whether `FORGE_CORE_COLLECTION` exists;
- whether mainnet minting is enabled;
- whether Firebase auth/admin UID allowlist is configured;
- whether devnet/staging was verified.

- [ ] **Step 5: Commit fixes if needed**

If Step 1-3 required fixes, commit them:

```bash
git add <fixed files>
git commit -m "fix: stabilize license forge integration"
```

If no fixes were needed, no commit is required.
