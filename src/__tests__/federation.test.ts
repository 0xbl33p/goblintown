import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { signMessage, verifyHmac, verifyInbox } from "../federation.js";
import type { InboxMessage } from "../types.js";
import { createHash } from "node:crypto";

function looseSig(srcLootId: string, body: string, fromWarren: string): string {
  return createHash("sha256")
    .update(fromWarren)
    .update("\0")
    .update(srcLootId)
    .update("\0")
    .update(body)
    .digest("hex")
    .slice(0, 16);
}

describe("verifyInbox", () => {
  it("accepts a message whose signature begins with the recomputed loose sig", () => {
    const fromWarren = "alpha";
    const sourceLootId = "abc1234567890def";
    const body = "compressed message body";
    const loose = looseSig(sourceLootId, body, fromWarren);
    const msg: InboxMessage = {
      id: "m1",
      fromWarren,
      audience: "test",
      body,
      sourceLootId,
      signature: `${loose}.deadbeefdeadbeef`,
      receivedAt: 0,
    };
    assert.equal(verifyInbox(msg), true);
  });

  it("rejects a message whose body has been tampered with", () => {
    const fromWarren = "alpha";
    const sourceLootId = "abc1234567890def";
    const loose = looseSig(sourceLootId, "original body", fromWarren);
    const msg: InboxMessage = {
      id: "m2",
      fromWarren,
      audience: "test",
      body: "TAMPERED body",
      sourceLootId,
      signature: `${loose}.deadbeefdeadbeef`,
      receivedAt: 0,
    };
    assert.equal(verifyInbox(msg), false);
  });

  it("rejects a forged fromWarren claim", () => {
    const sourceLootId = "abc";
    const body = "b";
    const loose = looseSig(sourceLootId, body, "alpha");
    const msg: InboxMessage = {
      id: "m3",
      fromWarren: "beta",
      audience: "test",
      body,
      sourceLootId,
      signature: `${loose}.tail`,
      receivedAt: 0,
    };
    assert.equal(verifyInbox(msg), false);
  });
});

describe("HMAC peer authentication", () => {
  it("signMessage with a secret produces a verifiable HMAC tag", () => {
    const secret = "shared-secret";
    const sig = signMessage("loot1", "pigeon1", "body", "alpha", secret);
    assert.match(sig, /;hmac:/);
    assert.equal(verifyHmac(sig, secret), true);
    assert.equal(verifyHmac(sig, "wrong-secret"), false);
  });

  it("verifyInbox enforces HMAC when local secret is provided", () => {
    const secret = "shared-secret";
    const fromWarren = "alpha";
    const sourceLootId = "abc";
    const body = "hello";
    const goodSig = signMessage(sourceLootId, "pigeon", body, fromWarren, secret);
    const goodMsg: InboxMessage = {
      id: "m1",
      fromWarren,
      audience: "x",
      body,
      sourceLootId,
      signature: goodSig,
      receivedAt: 0,
    };
    // Without a local secret, loose signature is enough.
    assert.equal(verifyInbox(goodMsg), true);
    // With matching secret, the full tag also verifies.
    assert.equal(verifyInbox(goodMsg, secret), true);
    // With a mismatched secret, the receiver rejects.
    assert.equal(verifyInbox(goodMsg, "different-secret"), false);
    // With a local secret but no HMAC tag at all, the receiver rejects.
    const noTagMsg: InboxMessage = {
      ...goodMsg,
      signature: signMessage(sourceLootId, "pigeon", body, fromWarren),
    };
    assert.equal(verifyInbox(noTagMsg, secret), false);
  });

  it("rejects HMAC tag of wrong length", () => {
    assert.equal(verifyHmac("loose.tail;hmac:short", "s"), false);
  });
});
