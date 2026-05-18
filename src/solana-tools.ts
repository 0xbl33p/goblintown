import {
  createSolanaRpcClient,
  normalizeSolanaAddress,
  normalizeSolanaSignature,
  profileSolanaAddress,
  summarizeSolanaActivity,
  summarizeSolanaToken,
  summarizeSolanaTransaction,
  type FetchLike,
} from "./solana.js";
import type { ToolDefinition } from "./tools.js";

export interface SolanaToolOptions {
  enabled?: boolean;
  rpcUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export function createSolanaTools(opts: SolanaToolOptions = {}): ToolDefinition[] {
  const enabled = opts.enabled === true;

  const withClient = async (
    args: Record<string, unknown>,
    fn: (client: ReturnType<typeof createSolanaRpcClient>, address: string) => Promise<unknown>,
  ): Promise<unknown> => {
    if (!enabled) {
      return { ok: false, error: "solana add-on disabled" };
    }
    const address = normalizeSolanaAddress(args.address);
    if (!address) return { ok: false, error: "invalid Solana address" };
    const client = createSolanaRpcClient({
      rpcUrl: opts.rpcUrl,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
    return fn(client, address);
  };

  return [
    {
      name: "solana.profile",
      description: "One-call Solana address dossier: inferred type, SOL balance, account metadata, token accounts, recent activity, notes, and warnings. Use this first for address investigations.",
      schema: solanaAddressSchema(),
      invoke(args) {
        return withClient(args, (client, address) => profileSolanaAddress(address, client));
      },
    },
    {
      name: "solana.activity",
      description: "Summarize recent Solana signatures for an address, including failed count, latest slot/time, and confirmation counts. Read-only.",
      schema: {
        type: "object",
        properties: {
          address: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 20 },
        },
        required: ["address"],
      },
      invoke(args) {
        const limit = typeof args.limit === "number" ? args.limit : 10;
        return withClient(args, (client, address) => summarizeSolanaActivity(address, client, limit));
      },
    },
    {
      name: "solana.transaction",
      description: "Inspect a Solana transaction signature with parsed account keys, signers, instruction summaries, fee, status, and capped logs. Read-only.",
      schema: {
        type: "object",
        properties: { signature: { type: "string" } },
        required: ["signature"],
      },
      async invoke(args) {
        if (!enabled) return { ok: false, error: "solana add-on disabled" };
        const signature = normalizeSolanaSignature(args.signature);
        if (!signature) return { ok: false, error: "invalid Solana transaction signature" };
        const client = createSolanaRpcClient({
          rpcUrl: opts.rpcUrl,
          fetchImpl: opts.fetchImpl,
          timeoutMs: opts.timeoutMs,
        });
        return summarizeSolanaTransaction(signature, client);
      },
    },
    {
      name: "solana.token",
      description: "Inspect parsed SPL token mint or token-account data for a Solana address, including supply/decimals or holder amount when available. Read-only.",
      schema: solanaAddressSchema(),
      invoke(args) {
        return withClient(args, (client, address) => summarizeSolanaToken(address, client));
      },
    },
    {
      name: "solana.balance",
      description: "Read SOL balance for a Solana address. Prefer solana.profile for investigations. Read-only; requires the Solana add-on.",
      schema: solanaAddressSchema(),
      invoke(args) {
        return withClient(args, (client, address) => client.getBalance(address));
      },
    },
    {
      name: "solana.account",
      description: "Read basic Solana account metadata. Read-only; requires the Solana add-on.",
      schema: solanaAddressSchema(),
      invoke(args) {
        return withClient(args, (client, address) => client.getAccount(address));
      },
    },
    {
      name: "solana.tokens",
      description: "List SPL token accounts owned by a Solana address. Read-only; result is capped.",
      schema: {
        type: "object",
        properties: {
          address: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 20 },
        },
        required: ["address"],
      },
      invoke(args) {
        const limit = typeof args.limit === "number" ? args.limit : 10;
        return withClient(args, (client, address) => client.getTokenAccounts(address, limit));
      },
    },
    {
      name: "solana.signatures",
      description: "List recent Solana signatures for an address. Prefer solana.activity for summarized investigations. Read-only; max 20 signatures.",
      schema: {
        type: "object",
        properties: {
          address: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 20 },
        },
        required: ["address"],
      },
      invoke(args) {
        const limit = typeof args.limit === "number" ? args.limit : 10;
        return withClient(args, (client, address) => client.getSignatures(address, limit));
      },
    },
    {
      name: "solana.rpcHealth",
      description: "Check the configured Solana RPC health. Read-only; requires the Solana add-on.",
      schema: { type: "object", properties: {} },
      async invoke() {
        if (!enabled) return { ok: false, error: "solana add-on disabled" };
        const client = createSolanaRpcClient({
          rpcUrl: opts.rpcUrl,
          fetchImpl: opts.fetchImpl,
          timeoutMs: opts.timeoutMs,
        });
        return client.getHealth();
      },
    },
  ];
}

function solanaAddressSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { address: { type: "string" } },
    required: ["address"],
  };
}
