# Goblintown License Forge Design

## Purpose

Build a separate Firebase-hosted Goblintown Driver's License Forge that lets anyone connect a Phantom wallet, burn `$GOBLINTOWN`, pay only the reserve needed to fund minting/operations, and receive a tradable procedurally generated Goblintown Driver's License NFT.

The product should feel like cursed municipal infrastructure: loud, pixel-bureaucratic, early-2000s web weird, grimy, and lovable. It should be extensible enough to support future Goblintown municipal products, admin-only mints, seasonal trait packs, and alternate mint modes.

## Repo And Worktree Boundary

Implementation should happen in a separate development worktree rather than being folded into the existing local Express/Tank UI. The app surface should live as a new workspace under the repo, expected as `apps/license-forge`, with Firebase config, frontend, Functions, shared forge logic, and tests kept together.

The existing Goblintown app remains the source for Warren state and current Firebase sign-in conventions. The forge reuses those conventions, but it is a distinct public web app.

## Existing Setup To Reuse

The current Goblintown app already includes:

- bundled Firebase client config for project `goblintown-88fd6`, with `FIREBASE_*` env overrides;
- Google/GitHub Firebase Auth flow loaded from Firebase web SDK modules;
- a `users/{uid}` profile document model;
- local Warren stats exposed through `/api/warren/stats`, including `loot`;
- local country identity keys that can sign payloads.

The forge should reuse the same Firebase project/config pattern and Auth identity model. It should not introduce a second sign-in system.

## Public Forge Flow

1. User opens the Firebase-hosted Forge.
2. User connects Phantom or a compatible Solana wallet.
3. User optionally signs in with Goblintown Cloud to sync Warren loot modifier.
4. User chooses a public offer, such as Standard Forge or Degen Forge.
5. Frontend fetches a backend price quote for the offer.
6. Frontend builds and submits a wallet transaction that:
   - burns the quoted amount of `$GOBLINTOWN`;
   - transfers the quoted SOL reserve to the project ops wallet;
   - uses the Token-2022 program for the `$GOBLINTOWN` mint.
7. Backend verifies the finalized transaction, including wallet ownership, burn amount, mint, token program, destination wallet, and reserve transfer.
8. Backend creates a deterministic generation seed, rolls weighted traits with the wallet's verified loot modifier, composites the final license image, stores image and metadata, and mints a tradable Metaplex Core NFT to the wallet.
9. Frontend displays the final image, trait list, rarity score, NFT asset address, metadata URI, and transaction records.

The `$GOBLINTOWN` mint is `DJ15QJxVPFGv6kYhT6LvDGqG9b4aBFWQzavA7dGxpump`. Read-only mainnet checks during design showed this is a Token-2022 mint with 6 decimals, so burn logic must not assume the legacy SPL Token program.

## Pricing And Economics

The forge should default to a target cost of about `$2.50` per public forge.

Pricing must be backend-configurable and recorded per forge. Each quote stores:

- offer id and version;
- `targetUsd`;
- `$GOBLINTOWN` mint and decimals;
- `$GOBLINTOWN` USD price and price source;
- SOL USD price and price source;
- estimated mint/ops reserve in USD and lamports;
- burn value in USD;
- burn token amount in base units and UI units;
- quote expiry time;
- treasury/ops wallet;
- mint mode;
- royalty basis points.

The reserve is subtracted first and paid to the project ops wallet. The remainder of the target value is burned in `$GOBLINTOWN`.

Example: if the target is `$2.50` and the reserve is `$0.35`, the user pays about `$0.35` worth of SOL to the ops wallet and burns about `$2.15` worth of `$GOBLINTOWN`.

The backend must support min/max clamps so price volatility does not produce absurd burn amounts. If the quote cannot be priced safely, forging should fail closed with a clear message.

## NFT Minting

MVP mint mode is Metaplex Core.

Each license should be minted as a tradable Core Asset owned by the connected wallet. Licenses belong to a Goblintown Driver's License collection. The default collection royalty is 5%, stored as `500` basis points in backend/admin config.

The minted asset should not be soulbound. Do not add default freeze, transfer restriction, or wallet-lock plugins. Future offers may add special rules, but the public license collection is transferable.

The mint adapter should keep room for later modes:

- `core`: default tradable Metaplex Core Asset;
- `compressed`: future Bubblegum V2 compressed NFT mode;
- `admin_free`: admin-only no-burn/no-fee mint path;
- `offchain_preview`: test or staging mode that produces metadata without mainnet minting.

## Warren Loot Modifier

Public wallets get baseline rarity odds.

Signed-in Goblintown users can sync their Warren loot count from the existing local app. The current local app exposes `loot` through `/api/warren/stats`; the forge should use a signed claim flow instead of trusting a raw number typed into the browser.

Recommended claim flow:

1. Forge creates a nonce for the signed-in Firebase user.
2. Local Goblintown app reads Warren stats and signs a claim containing `uid`, `wallet`, `loot`, `warrenName`, `issuedAt`, `expiresAt`, and `nonce`.
3. Forge backend verifies the signature against the user's registered Warren public key or a Firebase-stored key record.
4. Backend stores the latest verified claim in `users/{uid}/lootClaims/{claimId}` and mirrors the current trusted value to `users/{uid}.forgeLoot`.

The rarity boost should use a capped logarithmic curve:

```text
lootTier = floor(log10(loot + 1))
boost = min(maxBoost, log10(loot + 1) * boostCurve)
```

The exact `maxBoost` and `boostCurve` live in offer config. The goal is that more loot improves rare odds, while high-loot users cannot force every roll into ultra-rare territory.

Each generated license metadata record stores the raw verified loot count, calculated boost, offer id, seed, and trait rolls used.

## Trait Engine

Traits are data-driven and versioned by trait pack.

Required categories:

- `eyes`
- `nose`
- `ears`
- `mouth`
- `hat_hair`
- `shirt`
- `extras`
- `background`
- `rare_mutations`

Each trait entry supports:

- `id`
- `name`
- `rarity_weight`
- `imagePath`
- `category`
- `zIndex`
- `anchorX`
- `anchorY`
- `colorOverlayAllowed`
- `incompatibleTraits`
- `rare`

Every category should include at least one ultra-rare outlandish trait. Initial rare examples include toilet crown, burning halo, TV head, cursed USB necklace, shopping cart armor, wet cigarette mouth, glowing radioactive acne, eyeballs made of galaxies, and forklift certification badge.

Trait selection must be deterministic from the generation seed, offer config version, trait pack version, wallet, and verified transaction signature. The same metadata should reproduce the same final image.

The trait engine must resolve incompatibilities by rerolling within the category with a bounded retry count, then falling back to a configured safe default. Failed compatibility resolution should produce a backend error before minting, not a broken image.

## Image Compositor

Use Sharp in Firebase Functions v2 for MVP image compositing.

The compositor should:

- load a shared license template and base goblin head;
- sort trait layers by `zIndex`;
- place each layer with `anchorX` and `anchorY`;
- apply approved color overlays only when `colorOverlayAllowed` is true;
- render code-native text fields onto the license image, including name, id number, issue date, expiry date, rarity score, and flavor text;
- output a fixed-size PNG suitable for marketplace display.

Generated images are stored in Firebase Storage under versioned paths such as:

```text
licenses/{network}/{assetId}/license.png
licenses/{network}/{assetId}/metadata.json
```

Trait source images can be bundled in Functions for MVP or stored in Firebase Storage under admin-managed trait pack paths. The admin upload tool should support Storage-based trait packs so future expansion does not require redeploying code.

## Metadata

Each license metadata JSON includes:

- NFT name;
- description;
- image URI;
- external URL;
- goblin name;
- goblin ID number;
- issue date;
- expiry date;
- rarity score;
- rarity tier;
- trait list;
- wallet address that minted the license;
- current NFT owner at mint time;
- generation seed;
- offer id and version;
- trait pack id and version;
- burn transaction signature;
- mint transaction signature;
- Metaplex Core asset address;
- loot count and loot boost used;
- pricing snapshot.

Flavor text is encouraged, but it must be generated from deterministic tables, not an LLM call in the hot forge path.

## Firebase Data Model

Firestore collections:

- `forgeOffers/{offerId}`: public and admin offer config, pricing rules, mint mode, rarity rules, enabled status, and version.
- `forgeQuotes/{quoteId}`: short-lived quote snapshots and nonce data.
- `forgeRequests/{requestId}`: transaction verification state, wallet, user id, quote, seed, status, errors, and timestamps.
- `licenses/{licenseId}`: final public license record, metadata, storage paths, asset address, owner at mint, rarity, and trait summary.
- `users/{uid}`: existing profile extended with forge fields such as `forgeLoot`, `admin`, and latest synced wallet.
- `users/{uid}/lootClaims/{claimId}`: signed Warren loot claims.
- `traitPacks/{traitPackId}`: pack metadata, active version, categories, checksums, and admin state.
- `adminAudit/{eventId}`: admin offer edits, trait uploads, admin mints, and collection config changes.

Security rules should allow public reads of active offers, public license records, and published trait pack metadata. Writes to forge state happen through Functions. Admin writes require Firebase Auth and UID allowlist checked in Functions and mirrored in rules where direct admin reads are needed.

## Backend Functions

Functions v2 endpoints:

- `GET /api/config`: returns Firebase-safe public config, active offer summaries, mint address, and app version.
- `POST /api/quote`: creates a short-lived quote for an offer and wallet.
- `POST /api/forge/verify`: verifies a submitted transaction and creates or resumes a forge request.
- `POST /api/forge/finalize`: idempotently generates image/metadata and mints the NFT after verification.
- `POST /api/loot/nonce`: creates a signed-claim nonce for a Firebase user.
- `POST /api/loot/claim`: verifies and stores a signed Warren loot claim.
- `GET /api/licenses/:id`: returns public license metadata from Firestore.
- `POST /api/admin/offers`: admin-only offer create/update.
- `POST /api/admin/traits`: admin-only trait manifest update and trait asset registration.
- `POST /api/admin/mint`: admin-only no-burn/no-fee mint path using offer rules.

All forge finalization endpoints must be idempotent by request id and burn transaction signature.

## Admin Panel

Admin access uses the same Firebase sign-in as the public app. Admin authorization is based on a backend UID allowlist. There is no separate shared admin password.

The hidden admin panel supports:

- offer config edits;
- target price, reserve, min/max burn, royalty, and enabled status;
- trait pack upload/activation;
- trait compatibility preview;
- admin no-burn/no-fee mint;
- collection address/config display;
- audit log review.

Admin operations are recorded in `adminAudit`.

## UI Direction

The public UI should be the actual forge, not a marketing landing page.

The first viewport should show:

- connected wallet state;
- optional Goblintown Cloud sign-in state;
- selected offer and current quoted price;
- license preview frame;
- terminal-style municipal logs;
- `Forge License` action;
- fake warning labels and compliance notices.

Style goals:

- cursed municipal infrastructure;
- pixel-art bureaucracy;
- early 2000s Flash game energy;
- chunky controls;
- loud warning labels;
- grimy but readable contrast;
- retro-tech terminal logs;
- "VALID FOR ONE TRIP" and similar bureaucratic copy.

Avoid clean corporate SaaS styling. Controls still need to be accessible, responsive, and legible.

## Error Handling And Safety

The burn/payment/mint flow must fail safely.

Rules:

- quote expires before transaction verification if stale;
- backend verifies transaction from chain state, not client claims;
- backend verifies signer wallet, mint, token program, token decimals, burn amount, reserve transfer, and destination wallet;
- generation starts only after verified finalized transaction;
- finalization is idempotent;
- if image generation fails before mint, request remains retryable;
- if mint fails after image storage, request remains retryable without requiring another burn;
- if mint succeeds but Firestore write fails, backend can recover by asset address and stored metadata path;
- duplicate submissions of the same burn transaction return the existing license/request.

The admin free-mint path must be hidden from public UI and require backend allowlist authorization.

## Testing Strategy

Core tests:

- deterministic seeded randomness reproduces trait rolls;
- rarity weights and loot boost alter probabilities within expected bounds;
- incompatibility resolver avoids forbidden combinations and falls back safely;
- price quote calculation subtracts reserve and burns the remainder;
- Token-2022 burn transaction parser verifies mint, owner, and amount;
- request finalization is idempotent;
- metadata includes all required fields;
- admin allowlist blocks non-admin users;
- Firestore rules protect writes;
- compositor places layers in stable order and emits a non-empty PNG.

Use devnet/staging for wallet and mint integration tests. Mainnet minting should require explicit production config and credentials.

## Rollout Plan

1. Build the separate worktree and app scaffold.
2. Add shared Firebase config/sign-in reuse.
3. Implement deterministic trait engine and tests.
4. Implement pricing and quote tests.
5. Implement Token-2022 transaction generation and verification.
6. Implement Sharp compositor with a small starter trait pack.
7. Implement Storage/Firestore metadata pipeline.
8. Implement Metaplex Core mint adapter with 5% royalties.
9. Implement public forge UI.
10. Implement Warren loot claim sync.
11. Implement admin offer/trait/mint panel.
12. Verify locally, then deploy to a staging Firebase target before production.

## Non-Goals For MVP

- Bubblegum compressed NFTs as the default mint mode.
- Trait trading market.
- Reroll marketplace.
- Fully automated seasonal pool scheduling.
- Public admin tooling.
- LLM-generated license flavor text in the hot path.
