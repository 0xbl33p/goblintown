import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  createSolanaRpcClient,
  normalizeSolanaAddress,
  normalizeSolanaSignature,
  profileSolanaAddress,
  summarizeSolanaToken,
  summarizeSolanaTransaction,
  summarizeSolanaAddress,
} from "../solana.js";

const SAMPLE_ADDRESS = "11111111111111111111111111111111";
const SAMPLE_SIGNATURE = "5".repeat(88);

describe("solana rpc client", () => {
  it("accepts base58-looking Solana addresses and rejects unsafe values", () => {
    assert.equal(normalizeSolanaAddress(SAMPLE_ADDRESS), SAMPLE_ADDRESS);
    assert.equal(normalizeSolanaAddress("0xdeadbeef"), null);
    assert.equal(normalizeSolanaAddress("../secret"), null);
    assert.equal(normalizeSolanaAddress(""), null);
  });

  it("accepts base58-looking transaction signatures and rejects unsafe values", () => {
    assert.equal(normalizeSolanaSignature(SAMPLE_SIGNATURE), SAMPLE_SIGNATURE);
    assert.equal(normalizeSolanaSignature("0xdeadbeef"), null);
    assert.equal(normalizeSolanaSignature("../secret"), null);
    assert.equal(normalizeSolanaSignature("short"), null);
  });

  it("fetches and formats SOL balance through JSON-RPC", async () => {
    const calls: unknown[] = [];
    const client = createSolanaRpcClient({
      rpcUrl: "https://rpc.example.test",
      fetchImpl: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body ?? "{}")));
        return jsonResponse({ result: { value: 2_500_000_000 } });
      },
    });

    const balance = await client.getBalance(SAMPLE_ADDRESS);

    assert.equal(balance.address, SAMPLE_ADDRESS);
    assert.equal(balance.lamports, 2_500_000_000);
    assert.equal(balance.sol, 2.5);
    assert.deepEqual(calls, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [SAMPLE_ADDRESS],
      },
    ]);
  });

  it("caps signature lookups at twenty entries", async () => {
    let posted: Record<string, unknown> | undefined;
    const client = createSolanaRpcClient({
      rpcUrl: "https://rpc.example.test",
      fetchImpl: async (_url, init) => {
        posted = JSON.parse(String(init?.body ?? "{}"));
        return jsonResponse({ result: [] });
      },
    });

    await client.getSignatures(SAMPLE_ADDRESS, 99);

    assert.deepEqual(posted?.params, [SAMPLE_ADDRESS, { limit: 20 }]);
  });

  it("builds a compact address summary and keeps partial RPC errors visible", async () => {
    const client = createSolanaRpcClient({
      rpcUrl: "https://rpc.example.test",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.method === "getBalance") return jsonResponse({ result: { value: 42 } });
        if (body.method === "getAccountInfo") return jsonResponse({ result: { value: null } });
        if (body.method === "getTokenAccountsByOwner") throw new Error("token endpoint down");
        if (body.method === "getSignaturesForAddress") return jsonResponse({ result: [] });
        return jsonResponse({ result: "ok" });
      },
    });

    const summary = await summarizeSolanaAddress(SAMPLE_ADDRESS, client);

    assert.equal(summary.address, SAMPLE_ADDRESS);
    assert.equal(summary.balance?.lamports, 42);
    assert.equal(summary.account?.exists, false);
    assert.equal(summary.signatures?.count, 0);
    assert.match(summary.errors.join("\n"), /tokens: token endpoint down/);
  });

  it("builds a useful address profile with inferred type, notes, and activity", async () => {
    const client = createSolanaRpcClient({
      rpcUrl: "https://rpc.example.test",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.method === "getBalance") return jsonResponse({ result: { value: 2_000_000_000 } });
        if (body.method === "getAccountInfo" && body.params?.[1]?.encoding === "base64") {
          return jsonResponse({
            result: {
              value: {
                lamports: 2_000_000_000,
                owner: SAMPLE_ADDRESS,
                executable: false,
                rentEpoch: 0,
                data: ["", "base64"],
              },
            },
          });
        }
        if (body.method === "getAccountInfo" && body.params?.[1]?.encoding === "jsonParsed") {
          return jsonResponse({ result: { value: null } });
        }
        if (body.method === "getTokenAccountsByOwner") {
          return jsonResponse({
            result: {
              value: [
                tokenAccount("TokenMint111111111111111111111111111111", "7.5"),
                tokenAccount("TokenMint222222222222222222222222222222", "0"),
              ],
            },
          });
        }
        if (body.method === "getSignaturesForAddress") {
          return jsonResponse({
            result: [
              { signature: "sig-ok", slot: 12, err: null, blockTime: 1_717_000_000, confirmationStatus: "finalized" },
              { signature: "sig-fail", slot: 11, err: { InstructionError: [0, "Custom"] }, blockTime: 1_716_999_999 },
            ],
          });
        }
        return jsonResponse({ result: "ok" });
      },
    });

    const profile = await profileSolanaAddress(SAMPLE_ADDRESS, client);

    assert.equal(profile.address, SAMPLE_ADDRESS);
    assert.equal(profile.inferredType, "wallet");
    assert.equal(profile.activity.signatureCount, 2);
    assert.equal(profile.activity.failedCount, 1);
    assert.equal(profile.tokenHighlights.nonZeroTokenAccounts, 1);
    assert.match(profile.notes.join("\n"), /2 token account/);
    assert.match(profile.warnings.join("\n"), /failed recent transaction/);
  });

  it("fetches a parsed transaction summary", async () => {
    let posted: Record<string, unknown> | undefined;
    const client = createSolanaRpcClient({
      rpcUrl: "https://rpc.example.test",
      fetchImpl: async (_url, init) => {
        posted = JSON.parse(String(init?.body ?? "{}"));
        return jsonResponse({
          result: {
            slot: 99,
            blockTime: 1_717_000_001,
            meta: {
              err: null,
              fee: 5000,
              logMessages: ["Program log: hello"],
            },
            transaction: {
              message: {
                accountKeys: [
                  { pubkey: SAMPLE_ADDRESS, signer: true, writable: true },
                  { pubkey: "B".repeat(32), signer: false, writable: false },
                ],
                instructions: [
                  { programId: SAMPLE_ADDRESS, program: "system", parsed: { type: "transfer" } },
                ],
              },
              signatures: [SAMPLE_SIGNATURE],
            },
          },
        });
      },
    });

    const tx = await summarizeSolanaTransaction(SAMPLE_SIGNATURE, client);

    assert.equal(posted?.method, "getTransaction");
    assert.deepEqual(posted?.params, [
      SAMPLE_SIGNATURE,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
    assert.equal(tx.found, true);
    assert.equal(tx.status, "success");
    assert.equal(tx.feeLamports, 5000);
    assert.deepEqual(tx.signers, [SAMPLE_ADDRESS]);
    assert.equal(tx.instructions[0].type, "transfer");
  });

  it("summarizes parsed token mint data when available", async () => {
    const client = createSolanaRpcClient({
      rpcUrl: "https://rpc.example.test",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        assert.equal(body.method, "getAccountInfo");
        assert.equal(body.params?.[1]?.encoding, "jsonParsed");
        return jsonResponse({
          result: {
            value: {
              owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              lamports: 1,
              executable: false,
              data: {
                program: "spl-token",
                parsed: {
                  type: "mint",
                  info: {
                    decimals: 6,
                    supply: "123450000",
                    mintAuthority: SAMPLE_ADDRESS,
                    freezeAuthority: null,
                    isInitialized: true,
                  },
                },
              },
            },
          },
        });
      },
    });

    const token = await summarizeSolanaToken(SAMPLE_ADDRESS, client);

    assert.equal(token.kind, "mint");
    assert.equal(token.decimals, 6);
    assert.equal(token.supply, "123450000");
    assert.equal(token.mintAuthority, SAMPLE_ADDRESS);
    assert.equal(token.uiSupply, "123.45");
  });
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

function tokenAccount(mint: string, uiAmountString: string): Record<string, unknown> {
  return {
    pubkey: mint.replace("Mint", "Account"),
    account: {
      data: {
        parsed: {
          info: {
            mint,
            owner: SAMPLE_ADDRESS,
            tokenAmount: {
              amount: uiAmountString === "0" ? "0" : "7500000",
              decimals: 6,
              uiAmountString,
            },
          },
        },
      },
    },
  };
}
