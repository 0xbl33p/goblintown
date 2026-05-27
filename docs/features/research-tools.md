# Research Tools

Goblintown includes research surfaces that run through the same local-first
pipeline. They are tools for structured thinking, not financial instructions
from a glowing terminal.

## Thesis Engine

The thesis engine creates quality-and-advantage memos for a subject. In less
fused English, it asks about quality and advantages before it asks what the
internet is currently yelling about.

- project;
- team;
- product;
- protocol;
- repository;
- market;
- technical decision.

```bash
goblintown thesis "Firedancer validator client" \
  --horizon 90d \
  --context "Focus on engineering quality, ecosystem advantage, and execution risk" \
  --scan "README.md"

goblintown thesis "Jito" --solana <address> --remember
```

The memo covers team credibility, product and technical quality, ecosystem
position, traction, durable advantages, risks, invalidation triggers, and
evidence gaps. It is not a buy/sell recommendation and should not frame the
answer around buyability.

Missing evidence should be labeled **Unknown / Unverified**.

## Sentiment Sources

Sentiment starts with free/no-key sources, then optionally uses local API keys.

```bash
goblintown sentiment sources
goblintown sentiment market
goblintown sentiment project "Jito"
goblintown sentiment key set coingecko --value <secret>
goblintown sentiment key clear coingecko
```

Baseline sources:

- Alternative.me Fear & Greed;
- GDELT news tone.

Optional connectors:

- CoinGecko: `COINGECKO_API_KEY`
- Dune: `DUNE_API_KEY`
- Neynar/Farcaster: `NEYNAR_API_KEY`
- Santiment: `SANTIMENT_API_KEY`
- CryptoPanic: `CRYPTOPANIC_AUTH_TOKEN`
- LunarCrush: `LUNARCRUSH_API_KEY`

Keys can live in env vars or `.goblintown/secrets.json`. Env vars win.

In the app, sentiment keys live at:

```text
Settings -> Sentiment Sources
```

The Tank `SENTIMENT` tool uses the same source registry.

## Solana Add-on

The Solana add-on is read-only:

```bash
goblintown addon enable solana
goblintown addon solana <address>
goblintown addon solana activity <address>
goblintown addon solana token <address>
goblintown addon solana tx <signature>
```

When `--troll-tools` is enabled, the add-on exposes the same read-only evidence
tools to the Troll:

- `solana.profile`
- `solana.activity`
- `solana.transaction`
- `solana.token`
- `solana.balance`
- `solana.account`
- `solana.tokens`
- `solana.signatures`
- `solana.rpcHealth`

The default endpoint is:

```text
https://api.mainnet-beta.solana.com
```

Override it with:

```bash
export GOBLINTOWN_SOLANA_RPC_URL="https://..."
```

Or enable tools for one process without editing `warren.json`:

```bash
export GOBLINTOWN_TOOLS_SOLANA=1
```
