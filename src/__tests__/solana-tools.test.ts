import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createSolanaTools } from "../solana-tools.js";
import { runToolCalls } from "../tools.js";

const SAMPLE_ADDRESS = "11111111111111111111111111111111";
const SAMPLE_SIGNATURE = "5".repeat(88);

describe("solana verifier tools", () => {
  it("are inert when the Solana add-on is not enabled", async () => {
    let called = false;
    const tools = createSolanaTools({
      enabled: false,
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
    });

    const results = await runToolCalls(
      [{ name: "solana.balance", args: { address: SAMPLE_ADDRESS } }],
      tools,
    );

    assert.equal(called, false);
    assert.equal(results[0].ok, true);
    assert.match(
      String((results[0].result as { error?: string }).error ?? ""),
      /disabled/,
    );
  });

  it("invokes read-only Solana RPC when enabled", async () => {
    const tools = createSolanaTools({
      enabled: true,
      rpcUrl: "https://rpc.example.test",
      fetchImpl: async () => jsonResponse({ result: { value: 1_000_000_000 } }),
    });

    const results = await runToolCalls(
      [{ name: "solana.balance", args: { address: SAMPLE_ADDRESS } }],
      tools,
    );

    const result = results[0].result as { lamports?: number; sol?: number };
    assert.equal(results[0].ok, true);
    assert.equal(result.lamports, 1_000_000_000);
    assert.equal(result.sol, 1);
  });

  it("exposes high-level investigator tools", () => {
    const names = createSolanaTools({ enabled: true }).map((tool) => tool.name);
    assert.ok(names.includes("solana.profile"));
    assert.ok(names.includes("solana.activity"));
    assert.ok(names.includes("solana.transaction"));
    assert.ok(names.includes("solana.token"));
  });

  it("runs the one-call profile tool with partial-success semantics", async () => {
    const tools = createSolanaTools({
      enabled: true,
      rpcUrl: "https://rpc.example.test",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.method === "getBalance") return jsonResponse({ result: { value: 1_000_000_000 } });
        if (body.method === "getAccountInfo" && body.params?.[1]?.encoding === "base64") {
          return jsonResponse({ result: { value: { lamports: 1_000_000_000, owner: SAMPLE_ADDRESS, executable: false, data: ["", "base64"] } } });
        }
        if (body.method === "getAccountInfo" && body.params?.[1]?.encoding === "jsonParsed") return jsonResponse({ result: { value: null } });
        if (body.method === "getTokenAccountsByOwner") return jsonResponse({ result: { value: [] } });
        if (body.method === "getSignaturesForAddress") return jsonResponse({ result: [] });
        return jsonResponse({ result: "ok" });
      },
    });

    const results = await runToolCalls(
      [{ name: "solana.profile", args: { address: SAMPLE_ADDRESS } }],
      tools,
    );

    const result = results[0].result as { inferredType?: string; activity?: { signatureCount?: number } };
    assert.equal(results[0].ok, true);
    assert.equal(result.inferredType, "account");
    assert.equal(result.activity?.signatureCount, 0);
  });

  it("runs the parsed transaction tool", async () => {
    const tools = createSolanaTools({
      enabled: true,
      rpcUrl: "https://rpc.example.test",
      fetchImpl: async () => jsonResponse({
        result: {
          slot: 5,
          meta: { err: null, fee: 5000, logMessages: [] },
          transaction: {
            message: {
              accountKeys: [{ pubkey: SAMPLE_ADDRESS, signer: true }],
              instructions: [],
            },
            signatures: [SAMPLE_SIGNATURE],
          },
        },
      }),
    });

    const results = await runToolCalls(
      [{ name: "solana.transaction", args: { signature: SAMPLE_SIGNATURE } }],
      tools,
    );

    const result = results[0].result as { status?: string; signers?: string[] };
    assert.equal(results[0].ok, true);
    assert.equal(result.status, "success");
    assert.deepEqual(result.signers, [SAMPLE_ADDRESS]);
  });
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}
