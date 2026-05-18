export const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
export const LAMPORTS_PER_SOL = 1_000_000_000;

const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const SOLANA_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MAX_SIGNATURE_LIMIT = 20;
const DEFAULT_TIMEOUT_MS = 5_000;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SolanaRpcClientOptions {
  rpcUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface SolanaBalance {
  address: string;
  lamports: number;
  sol: number;
  rpcUrl: string;
}

export interface SolanaAccountInfo {
  address: string;
  exists: boolean;
  lamports?: number;
  owner?: string;
  executable?: boolean;
  rentEpoch?: number;
  dataLength?: number;
  rpcUrl: string;
}

export interface SolanaTokenAccount {
  pubkey: string;
  mint?: string;
  owner?: string;
  amount?: string;
  decimals?: number;
  uiAmountString?: string;
}

export interface SolanaSignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  memo?: string | null;
  blockTime?: number | null;
  confirmationStatus?: string;
}

export interface SolanaParsedAccountInfo {
  address: string;
  exists: boolean;
  lamports?: number;
  owner?: string;
  executable?: boolean;
  rentEpoch?: number;
  program?: string;
  parsedType?: string;
  parsedInfo?: Record<string, unknown>;
  rpcUrl: string;
}

export interface SolanaTransactionInstruction {
  program?: string;
  programId?: string;
  type?: string;
  accountCount?: number;
}

export interface SolanaTransactionSummary {
  signature: string;
  rpcUrl: string;
  readOnly: true;
  found: boolean;
  slot?: number;
  blockTime?: number | null;
  status?: "success" | "failed" | "unknown";
  feeLamports?: number;
  error?: unknown;
  signers: string[];
  accountKeys: string[];
  instructions: SolanaTransactionInstruction[];
  logMessages: string[];
}

interface RawSolanaInstruction {
  program?: string;
  programId?: string;
  accounts?: unknown[];
  parsed?: { type?: string } | string;
}

interface RawSolanaTransactionResponse {
  slot?: number;
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    fee?: number;
    logMessages?: string[] | null;
  } | null;
  transaction?: {
    signatures?: string[];
    message?: {
      accountKeys?: Array<string | {
        pubkey?: string;
        signer?: boolean;
        writable?: boolean;
      }>;
      instructions?: RawSolanaInstruction[];
    };
  };
}

export interface SolanaActivitySummary {
  address: string;
  rpcUrl: string;
  readOnly: true;
  signatureCount: number;
  failedCount: number;
  latestSignature?: string;
  latestSlot?: number;
  latestBlockTime?: number | null;
  confirmationCounts: Record<string, number>;
  signatures: SolanaSignatureInfo[];
  notes: string[];
}

export interface SolanaTokenSummary {
  address: string;
  rpcUrl: string;
  readOnly: true;
  kind: "mint" | "token-account" | "missing" | "unknown";
  owner?: string;
  decimals?: number;
  supply?: string;
  uiSupply?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  isInitialized?: boolean;
  mint?: string;
  tokenOwner?: string;
  amount?: string;
  uiAmountString?: string;
  parsedType?: string;
  notes: string[];
}

export interface SolanaRpcClient {
  rpcUrl: string;
  getHealth(): Promise<{ ok: boolean; status: string; rpcUrl: string }>;
  getBalance(address: string): Promise<SolanaBalance>;
  getAccount(address: string): Promise<SolanaAccountInfo>;
  getParsedAccount(address: string): Promise<SolanaParsedAccountInfo>;
  getTokenAccounts(owner: string, limit?: number): Promise<{
    owner: string;
    count: number;
    accounts: SolanaTokenAccount[];
    truncated: boolean;
    rpcUrl: string;
  }>;
  getSignatures(address: string, limit?: number): Promise<{
    address: string;
    count: number;
    signatures: SolanaSignatureInfo[];
    rpcUrl: string;
  }>;
  getTransaction(signature: string): Promise<SolanaTransactionSummary>;
}

export interface SolanaAddressSummary {
  address: string;
  rpcUrl: string;
  readOnly: true;
  balance?: SolanaBalance;
  account?: SolanaAccountInfo;
  tokens?: Awaited<ReturnType<SolanaRpcClient["getTokenAccounts"]>>;
  signatures?: Awaited<ReturnType<SolanaRpcClient["getSignatures"]>>;
  errors: string[];
}

export interface SolanaAddressProfile extends SolanaAddressSummary {
  inferredType: "inactive" | "wallet" | "program" | "token-mint" | "token-account" | "account";
  parsedAccount?: SolanaParsedAccountInfo;
  activity: SolanaActivitySummary;
  tokenHighlights: {
    tokenAccountCount: number;
    nonZeroTokenAccounts: number;
    topTokens: SolanaTokenAccount[];
  };
  notes: string[];
  warnings: string[];
}

export function normalizeSolanaAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!BASE58_ADDRESS_RE.test(value)) return null;
  return value;
}

export function normalizeSolanaSignature(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!BASE58_SIGNATURE_RE.test(value)) return null;
  return value;
}

export function normalizeSolanaRpcUrl(raw?: string): string {
  const value = (raw ?? process.env.GOBLINTOWN_SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC_URL).trim();
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Solana RPC URL must use http(s).");
  }
  if (parsed.protocol === "http:" && !isLocalhost(parsed.hostname)) {
    throw new Error("Solana RPC URL must use https unless it targets localhost.");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function createSolanaRpcClient(opts: SolanaRpcClientOptions = {}): SolanaRpcClient {
  const rpcUrl = normalizeSolanaRpcUrl(opts.rpcUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
      const body = await response.json() as {
        result?: T;
        error?: { message?: string; code?: number };
      };
      if (!response.ok) {
        throw new Error(`Solana RPC HTTP ${response.status}`);
      }
      if (body.error) {
        const suffix = body.error.code === undefined ? "" : ` (${body.error.code})`;
        throw new Error(`${body.error.message ?? "Solana RPC error"}${suffix}`);
      }
      return body.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    rpcUrl,
    async getHealth() {
      const status = await rpc<string>("getHealth");
      return { ok: status === "ok", status, rpcUrl };
    },
    async getBalance(address) {
      const normalized = requireAddress(address);
      const result = await rpc<{ value: number }>("getBalance", [normalized]);
      const lamports = Number(result.value ?? 0);
      return {
        address: normalized,
        lamports,
        sol: lamports / LAMPORTS_PER_SOL,
        rpcUrl,
      };
    },
    async getAccount(address) {
      const normalized = requireAddress(address);
      const result = await rpc<{
        value: null | {
          lamports?: number;
          owner?: string;
          executable?: boolean;
          rentEpoch?: number;
          data?: unknown;
        };
      }>("getAccountInfo", [normalized, { encoding: "base64" }]);
      const account = result.value;
      if (!account) return { address: normalized, exists: false, rpcUrl };
      return {
        address: normalized,
        exists: true,
        lamports: typeof account.lamports === "number" ? account.lamports : undefined,
        owner: typeof account.owner === "string" ? account.owner : undefined,
        executable: typeof account.executable === "boolean" ? account.executable : undefined,
        rentEpoch: typeof account.rentEpoch === "number" ? account.rentEpoch : undefined,
        dataLength: base64DataLength(account.data),
        rpcUrl,
      };
    },
    async getParsedAccount(address) {
      const normalized = requireAddress(address);
      const result = await rpc<{
        value: null | {
          lamports?: number;
          owner?: string;
          executable?: boolean;
          rentEpoch?: number;
          data?: {
            program?: string;
            parsed?: {
              type?: string;
              info?: Record<string, unknown>;
            };
          };
        };
      }>("getAccountInfo", [normalized, { encoding: "jsonParsed" }]);
      const account = result.value;
      if (!account) return { address: normalized, exists: false, rpcUrl };
      const parsed = account.data?.parsed;
      return {
        address: normalized,
        exists: true,
        lamports: typeof account.lamports === "number" ? account.lamports : undefined,
        owner: typeof account.owner === "string" ? account.owner : undefined,
        executable: typeof account.executable === "boolean" ? account.executable : undefined,
        rentEpoch: typeof account.rentEpoch === "number" ? account.rentEpoch : undefined,
        program: typeof account.data?.program === "string" ? account.data.program : undefined,
        parsedType: typeof parsed?.type === "string" ? parsed.type : undefined,
        parsedInfo: parsed?.info && typeof parsed.info === "object" ? parsed.info : undefined,
        rpcUrl,
      };
    },
    async getTokenAccounts(owner, limit = 10) {
      const normalized = requireAddress(owner);
      const max = clampLimit(limit, 1, 20);
      const result = await rpc<{
        value: Array<{
          pubkey?: string;
          account?: {
            data?: {
              parsed?: {
                info?: {
                  mint?: string;
                  owner?: string;
                  tokenAmount?: {
                    amount?: string;
                    decimals?: number;
                    uiAmountString?: string;
                  };
                };
              };
            };
          };
        }>;
      }>("getTokenAccountsByOwner", [
        normalized,
        { programId: SOLANA_TOKEN_PROGRAM_ID },
        { encoding: "jsonParsed" },
      ]);
      const accounts = (result.value ?? []).slice(0, max).map((row) => {
        const info = row.account?.data?.parsed?.info ?? {};
        const tokenAmount = info.tokenAmount ?? {};
        return {
          pubkey: String(row.pubkey ?? ""),
          mint: info.mint,
          owner: info.owner,
          amount: tokenAmount.amount,
          decimals: tokenAmount.decimals,
          uiAmountString: tokenAmount.uiAmountString,
        };
      });
      return {
        owner: normalized,
        count: result.value?.length ?? 0,
        accounts,
        truncated: (result.value?.length ?? 0) > accounts.length,
        rpcUrl,
      };
    },
    async getSignatures(address, limit = 10) {
      const normalized = requireAddress(address);
      const capped = clampLimit(limit, 1, MAX_SIGNATURE_LIMIT);
      const signatures = await rpc<SolanaSignatureInfo[]>(
        "getSignaturesForAddress",
        [normalized, { limit: capped }],
      );
      return {
        address: normalized,
        count: signatures.length,
        signatures,
        rpcUrl,
      };
    },
    async getTransaction(signature) {
      const normalized = requireSignature(signature);
      const result = await rpc<RawSolanaTransactionResponse | null>("getTransaction", [
        normalized,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
      return transactionSummaryFromRpc(normalized, rpcUrl, result);
    },
  };
}

export async function summarizeSolanaAddress(
  address: string,
  clientOrOptions: SolanaRpcClient | SolanaRpcClientOptions = {},
): Promise<SolanaAddressSummary> {
  const normalized = requireAddress(address);
  const client = isSolanaRpcClient(clientOrOptions)
    ? clientOrOptions
    : createSolanaRpcClient(clientOrOptions);
  const errors: string[] = [];

  const capture = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  const [balance, account, tokens, signatures] = await Promise.all([
    capture("balance", () => client.getBalance(normalized)),
    capture("account", () => client.getAccount(normalized)),
    capture("tokens", () => client.getTokenAccounts(normalized, 10)),
    capture("signatures", () => client.getSignatures(normalized, 10)),
  ]);

  return {
    address: normalized,
    rpcUrl: client.rpcUrl,
    readOnly: true,
    ...(balance ? { balance } : {}),
    ...(account ? { account } : {}),
    ...(tokens ? { tokens } : {}),
    ...(signatures ? { signatures } : {}),
    errors,
  };
}

export async function profileSolanaAddress(
  address: string,
  clientOrOptions: SolanaRpcClient | SolanaRpcClientOptions = {},
): Promise<SolanaAddressProfile> {
  const normalized = requireAddress(address);
  const client = isSolanaRpcClient(clientOrOptions)
    ? clientOrOptions
    : createSolanaRpcClient(clientOrOptions);
  const summary = await summarizeSolanaAddress(normalized, client);
  let parsedAccount: SolanaParsedAccountInfo | undefined;
  const warnings = [...summary.errors.map((err) => `partial lookup error: ${err}`)];
  try {
    parsedAccount = await client.getParsedAccount(normalized);
  } catch (err) {
    warnings.push(`parsed account unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const activity = activityFromSignatures(
    normalized,
    client.rpcUrl,
    summary.signatures?.signatures ?? [],
  );
  const tokenAccounts = summary.tokens?.accounts ?? [];
  const topTokens = tokenAccounts
    .filter((token) => Number(token.uiAmountString ?? token.amount ?? 0) > 0)
    .slice(0, 5);
  const tokenHighlights = {
    tokenAccountCount: summary.tokens?.count ?? 0,
    nonZeroTokenAccounts: topTokens.length,
    topTokens,
  };
  const inferredType = inferAddressType(summary, parsedAccount);
  const notes = profileNotes(summary, parsedAccount, activity, tokenHighlights);
  if (activity.failedCount > 0) {
    warnings.push(`${activity.failedCount} failed recent transaction${activity.failedCount === 1 ? "" : "s"}`);
  }
  return {
    ...summary,
    inferredType,
    ...(parsedAccount ? { parsedAccount } : {}),
    activity,
    tokenHighlights,
    notes,
    warnings,
  };
}

export async function summarizeSolanaActivity(
  address: string,
  clientOrOptions: SolanaRpcClient | SolanaRpcClientOptions = {},
  limit = 10,
): Promise<SolanaActivitySummary> {
  const normalized = requireAddress(address);
  const client = isSolanaRpcClient(clientOrOptions)
    ? clientOrOptions
    : createSolanaRpcClient(clientOrOptions);
  const signatures = await client.getSignatures(normalized, limit);
  return activityFromSignatures(normalized, client.rpcUrl, signatures.signatures);
}

export async function summarizeSolanaTransaction(
  signature: string,
  clientOrOptions: SolanaRpcClient | SolanaRpcClientOptions = {},
): Promise<SolanaTransactionSummary> {
  const normalized = requireSignature(signature);
  const client = isSolanaRpcClient(clientOrOptions)
    ? clientOrOptions
    : createSolanaRpcClient(clientOrOptions);
  return client.getTransaction(normalized);
}

export async function summarizeSolanaToken(
  address: string,
  clientOrOptions: SolanaRpcClient | SolanaRpcClientOptions = {},
): Promise<SolanaTokenSummary> {
  const normalized = requireAddress(address);
  const client = isSolanaRpcClient(clientOrOptions)
    ? clientOrOptions
    : createSolanaRpcClient(clientOrOptions);
  const account = await client.getParsedAccount(normalized);
  if (!account.exists) {
    return {
      address: normalized,
      rpcUrl: client.rpcUrl,
      readOnly: true,
      kind: "missing",
      notes: ["No account exists for this address."],
    };
  }
  const info = account.parsedInfo ?? {};
  if (account.parsedType === "mint") {
    const decimals = numberValue(info.decimals);
    const supply = stringValue(info.supply);
    return {
      address: normalized,
      rpcUrl: client.rpcUrl,
      readOnly: true,
      kind: "mint",
      owner: account.owner,
      decimals,
      supply,
      uiSupply: supply && decimals !== undefined ? decimalString(supply, decimals) : undefined,
      mintAuthority: nullableString(info.mintAuthority),
      freezeAuthority: nullableString(info.freezeAuthority),
      isInitialized: booleanValue(info.isInitialized),
      parsedType: account.parsedType,
      notes: ["Parsed SPL token mint account."],
    };
  }
  if (account.parsedType === "account") {
    const tokenAmount = objectValue(info.tokenAmount);
    return {
      address: normalized,
      rpcUrl: client.rpcUrl,
      readOnly: true,
      kind: "token-account",
      owner: account.owner,
      mint: stringValue(info.mint),
      tokenOwner: stringValue(info.owner),
      amount: stringValue(tokenAmount.amount),
      decimals: numberValue(tokenAmount.decimals),
      uiAmountString: stringValue(tokenAmount.uiAmountString),
      parsedType: account.parsedType,
      notes: ["Parsed SPL token holding account."],
    };
  }
  return {
    address: normalized,
    rpcUrl: client.rpcUrl,
    readOnly: true,
    kind: "unknown",
    owner: account.owner,
    parsedType: account.parsedType,
    notes: ["Account is not a parsed SPL mint or token holding account."],
  };
}

function requireAddress(raw: string): string {
  const normalized = normalizeSolanaAddress(raw);
  if (!normalized) throw new Error("invalid Solana address");
  return normalized;
}

function requireSignature(raw: string): string {
  const normalized = normalizeSolanaSignature(raw);
  if (!normalized) throw new Error("invalid Solana transaction signature");
  return normalized;
}

function isSolanaRpcClient(value: SolanaRpcClient | SolanaRpcClientOptions): value is SolanaRpcClient {
  return typeof (value as SolanaRpcClient).getBalance === "function" &&
    typeof (value as SolanaRpcClient).getAccount === "function";
}

function activityFromSignatures(
  address: string,
  rpcUrl: string,
  signatures: SolanaSignatureInfo[],
): SolanaActivitySummary {
  const confirmationCounts: Record<string, number> = {};
  for (const sig of signatures) {
    const key = sig.confirmationStatus ?? "unknown";
    confirmationCounts[key] = (confirmationCounts[key] ?? 0) + 1;
  }
  const failedCount = signatures.filter((sig) => sig.err != null).length;
  const latest = signatures[0];
  const notes = signatures.length === 0
    ? ["No recent signatures returned by the configured RPC endpoint."]
    : [`${signatures.length} recent signature${signatures.length === 1 ? "" : "s"} returned.`];
  if (failedCount > 0) notes.push(`${failedCount} recent signature${failedCount === 1 ? "" : "s"} failed.`);
  return {
    address,
    rpcUrl,
    readOnly: true,
    signatureCount: signatures.length,
    failedCount,
    latestSignature: latest?.signature,
    latestSlot: latest?.slot,
    latestBlockTime: latest?.blockTime,
    confirmationCounts,
    signatures,
    notes,
  };
}

function inferAddressType(
  summary: SolanaAddressSummary,
  parsedAccount?: SolanaParsedAccountInfo,
): SolanaAddressProfile["inferredType"] {
  if (parsedAccount?.parsedType === "mint") return "token-mint";
  if (parsedAccount?.parsedType === "account") return "token-account";
  if (summary.account?.executable || parsedAccount?.executable) return "program";
  if (summary.account?.exists === false && (summary.balance?.lamports ?? 0) === 0) return "inactive";
  if ((summary.tokens?.count ?? 0) > 0) return "wallet";
  return "account";
}

function profileNotes(
  summary: SolanaAddressSummary,
  parsedAccount: SolanaParsedAccountInfo | undefined,
  activity: SolanaActivitySummary,
  tokenHighlights: SolanaAddressProfile["tokenHighlights"],
): string[] {
  const notes: string[] = [];
  if (summary.balance) notes.push(`SOL balance: ${summary.balance.sol} SOL.`);
  if (summary.account?.exists === false) notes.push("No account data exists at this address.");
  if (summary.account?.executable || parsedAccount?.executable) notes.push("Executable program account.");
  if (parsedAccount?.parsedType) notes.push(`Parsed account type: ${parsedAccount.parsedType}.`);
  if (tokenHighlights.tokenAccountCount > 0) {
    notes.push(`${tokenHighlights.tokenAccountCount} token account${tokenHighlights.tokenAccountCount === 1 ? "" : "s"} found.`);
  }
  notes.push(...activity.notes);
  return notes;
}

function transactionSummaryFromRpc(
  signature: string,
  rpcUrl: string,
  tx: RawSolanaTransactionResponse | null,
): SolanaTransactionSummary {
  if (!tx) {
    return {
      signature,
      rpcUrl,
      readOnly: true,
      found: false,
      signers: [],
      accountKeys: [],
      instructions: [],
      logMessages: [],
    };
  }
  const accountRows = tx.transaction?.message?.accountKeys ?? [];
  const accountKeys = accountRows.map(accountKeyString).filter((value) => value.length > 0);
  const signers = accountRows
    .filter((row) => typeof row === "object" && row !== null && row.signer === true)
    .map(accountKeyString)
    .filter((value) => value.length > 0);
  const instructions = (tx.transaction?.message?.instructions ?? []).slice(0, 24).map((ix) => {
    const parsedType = typeof ix.parsed === "object" && ix.parsed && typeof ix.parsed.type === "string"
      ? ix.parsed.type
      : undefined;
    return {
      program: typeof ix.program === "string" ? ix.program : undefined,
      programId: typeof ix.programId === "string" ? ix.programId : undefined,
      type: parsedType,
      accountCount: Array.isArray(ix.accounts) ? ix.accounts.length : undefined,
    };
  });
  const error = tx.meta?.err ?? null;
  return {
    signature,
    rpcUrl,
    readOnly: true,
    found: true,
    slot: typeof tx.slot === "number" ? tx.slot : undefined,
    blockTime: tx.blockTime,
    status: error == null ? "success" : "failed",
    feeLamports: typeof tx.meta?.fee === "number" ? tx.meta.fee : undefined,
    error: error ?? undefined,
    signers,
    accountKeys,
    instructions,
    logMessages: (tx.meta?.logMessages ?? []).slice(0, 20),
  };
}

function accountKeyString(row: string | { pubkey?: string }): string {
  return typeof row === "string" ? row : String(row.pubkey ?? "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function decimalString(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return raw;
  if (decimals <= 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function clampLimit(raw: number, min: number, max: number): number {
  if (!Number.isFinite(raw)) return min;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function base64DataLength(data: unknown): number | undefined {
  if (!Array.isArray(data) || typeof data[0] !== "string") return undefined;
  try {
    return Buffer.byteLength(data[0], "base64");
  } catch {
    return undefined;
  }
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";
}
