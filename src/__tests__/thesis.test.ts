import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildThesisTask,
  collectThesisEvidence,
  normalizeThesisInput,
} from "../thesis.js";
import type { SolanaRpcClient } from "../solana.js";

const SAMPLE_ADDRESS = "11111111111111111111111111111111";
const SAMPLE_SIGNATURE = "5".repeat(88);

describe("thesis engine", () => {
  it("normalizes a general project-quality thesis request", () => {
    const input = normalizeThesisInput({
      subject: "  Firedancer validator client  ",
      horizon: "90d",
      context: "assess engineering and ecosystem advantages",
    });

    assert.equal(input.subject, "Firedancer validator client");
    assert.equal(input.horizon, "90d");
    assert.equal(input.context, "assess engineering and ecosystem advantages");
  });

  it("rejects empty thesis subjects", () => {
    assert.throws(() => normalizeThesisInput({ subject: " " }), /subject is required/);
  });

  it("builds a project-quality prompt and explicitly avoids buyability framing", () => {
    const task = buildThesisTask({
      subject: "Example protocol",
      horizon: "30d",
      context: "team is shipping quickly",
    });

    assert.match(task, /project-quality thesis/i);
    assert.match(task, /team credibility/i);
    assert.match(task, /technical quality/i);
    assert.match(task, /advantages/i);
    assert.match(task, /invalidation triggers/i);
    assert.match(task, /not a buy\/sell recommendation/i);
    assert.doesNotMatch(task, /price target/i);
  });

  it("treats missing evidence as unknown instead of a negative finding", () => {
    const task = buildThesisTask({
      subject: "Example repo",
      horizon: "30d",
      context: "Evaluate my own repository.",
    });

    assert.match(task, /absence of evidence is not evidence of absence/i);
    assert.match(task, /Unknown \/ Unverified/i);
    assert.match(task, /Do not downgrade/i);
  });

  it("forbids unsupported name-squatting and not-doxxed claims", () => {
    const task = buildThesisTask({
      subject: "0xbl33p/goblintown",
      horizon: "30d",
      context: "I am the doxxed developer and this is my repository.",
    });

    assert.match(task, /User-provided context is evidence/i);
    assert.match(task, /not being doxxed is not a negative signal/i);
    assert.match(task, /Do not claim name-squatting/i);
  });

  it("collects Solana evidence without making buy/sell claims", async () => {
    const evidence = await collectThesisEvidence(
      {
        subject: "Example Solana project",
        horizon: "30d",
        solanaAddress: SAMPLE_ADDRESS,
        solanaSignature: SAMPLE_SIGNATURE,
      },
      fakeSolanaClient(),
    );

    assert.match(evidence.block, /Solana evidence/i);
    assert.match(evidence.block, /profile/i);
    assert.match(evidence.block, /transaction/i);
    assert.match(evidence.block, /read-only/i);
    assert.doesNotMatch(evidence.block, /buy|sell/i);
  });
});

function fakeSolanaClient(): SolanaRpcClient {
  return {
    rpcUrl: "https://rpc.example.test",
    async getHealth() {
      return { ok: true, status: "ok", rpcUrl: this.rpcUrl };
    },
    async getBalance(address) {
      return { address, lamports: 1_000_000_000, sol: 1, rpcUrl: this.rpcUrl };
    },
    async getAccount(address) {
      return { address, exists: true, owner: SAMPLE_ADDRESS, executable: false, rpcUrl: this.rpcUrl };
    },
    async getParsedAccount(address) {
      return { address, exists: false, rpcUrl: this.rpcUrl };
    },
    async getTokenAccounts(owner) {
      return { owner, count: 0, accounts: [], truncated: false, rpcUrl: this.rpcUrl };
    },
    async getSignatures(address) {
      return {
        address,
        count: 1,
        signatures: [{ signature: "sig", slot: 42, err: null, confirmationStatus: "finalized" }],
        rpcUrl: this.rpcUrl,
      };
    },
    async getTransaction(signature) {
      return {
        signature,
        rpcUrl: this.rpcUrl,
        readOnly: true,
        found: true,
        status: "success",
        slot: 42,
        feeLamports: 5000,
        signers: [SAMPLE_ADDRESS],
        accountKeys: [SAMPLE_ADDRESS],
        instructions: [{ program: "system", type: "transfer" }],
        logMessages: [],
      };
    },
  };
}
