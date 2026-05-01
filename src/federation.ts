import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { makePigeon } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { callCreature } from "./openai-client.js";
import { Hoard } from "./hoard.js";
import { loadWarren } from "./warren.js";
import type {
  InboxMessage,
  Loot,
  OutboxRecord,
  Personality,
} from "./types.js";

export interface SendOptions {
  fromWarrenName: string;
  fromHoard: Hoard;
  fromPeerSecret?: string;
  toWarrenPath: string;
  sourceLootId: string;
  audience?: string;
  personality?: Personality;
}

export interface SendResult {
  outbox: OutboxRecord;
  pigeonLoot: Loot;
  deliveredTo: string;
}

export async function sendToWarren(opts: SendOptions): Promise<SendResult> {
  const sourceLoot = await opts.fromHoard.getLoot(opts.sourceLootId);
  if (!sourceLoot) {
    throw new Error(`Source Loot ${opts.sourceLootId} not found in Hoard.`);
  }

  const audience = opts.audience ?? "another Warren's reviewer";
  const pigeon = makePigeon(opts.personality);
  const userPrompt = pigeonPrompt(audience, sourceLoot.output);
  const { text: compressed, usage } = await callCreature(pigeon, userPrompt);
  const drift = measureDrift(compressed);

  const pigeonLoot: Loot = {
    id: "",
    creatureKind: "pigeon",
    personality: pigeon.personality,
    model: pigeon.model,
    prompt: userPrompt,
    output: compressed,
    parentLootIds: [sourceLoot.id],
    timestamp: Date.now(),
    drift,
    usage,
  };
  await opts.fromHoard.stash(pigeonLoot);

  const signature = signMessage(
    sourceLoot.id,
    pigeonLoot.id,
    compressed,
    opts.fromWarrenName,
    opts.fromPeerSecret,
  );

  const targetAbs = resolve(opts.toWarrenPath);
  const targetWarren = await loadWarren(targetAbs);

  if (targetWarren.manifest.peerSecret && !opts.fromPeerSecret) {
    throw new Error(
      `Target Warren "${targetWarren.manifest.name}" requires HMAC; set peerSecret in this Warren's manifest.`,
    );
  }
  if (
    targetWarren.manifest.peerSecret &&
    !verifyHmac(signature, targetWarren.manifest.peerSecret)
  ) {
    throw new Error(
      `Target Warren "${targetWarren.manifest.name}" requires HMAC under a different secret than ours.`,
    );
  }

  const messageId = randomUUID().slice(0, 12);
  const inboxMsg: InboxMessage = {
    id: messageId,
    fromWarren: opts.fromWarrenName,
    audience,
    body: compressed,
    signature,
    sourceLootId: sourceLoot.id,
    receivedAt: Date.now(),
  };
  await targetWarren.hoard.stashInbox(inboxMsg);

  const outbox: OutboxRecord = {
    id: messageId,
    toWarren: targetWarren.manifest.name,
    audience,
    sourceLootId: sourceLoot.id,
    pigeonLootId: pigeonLoot.id,
    signature,
    sentAt: Date.now(),
  };
  await opts.fromHoard.stashOutbox(outbox);

  return { outbox, pigeonLoot, deliveredTo: targetWarren.root };
}

export function verifyInbox(msg: InboxMessage, localSecret?: string): boolean {
  const loose = looseSignature(msg.sourceLootId, msg.body, msg.fromWarren);
  if (!msg.signature.startsWith(loose)) return false;
  if (localSecret) {
    if (!verifyHmac(msg.signature, localSecret)) return false;
  }
  return true;
}

export interface SendHttpOptions {
  fromWarrenName: string;
  fromHoard: Hoard;
  fromPeerSecret?: string;
  toUrl: string;
  sourceLootId: string;
  audience?: string;
  personality?: Personality;
}

export interface SendHttpResult {
  outbox: OutboxRecord;
  pigeonLoot: Loot;
  remoteId: string;
}

export async function sendToWarrenHttp(
  opts: SendHttpOptions,
): Promise<SendHttpResult> {
  const sourceLoot = await opts.fromHoard.getLoot(opts.sourceLootId);
  if (!sourceLoot) {
    throw new Error(`Source Loot ${opts.sourceLootId} not found in Hoard.`);
  }
  const audience = opts.audience ?? "another Warren's reviewer";
  const pigeon = makePigeon(opts.personality);
  const userPrompt = pigeonPrompt(audience, sourceLoot.output);
  const { text: compressed, usage } = await callCreature(pigeon, userPrompt);
  const drift = measureDrift(compressed);

  const pigeonLoot: Loot = {
    id: "",
    creatureKind: "pigeon",
    personality: pigeon.personality,
    model: pigeon.model,
    prompt: userPrompt,
    output: compressed,
    parentLootIds: [sourceLoot.id],
    timestamp: Date.now(),
    drift,
    usage,
  };
  await opts.fromHoard.stash(pigeonLoot);

  const signature = signMessage(
    sourceLoot.id,
    pigeonLoot.id,
    compressed,
    opts.fromWarrenName,
    opts.fromPeerSecret,
  );
  const endpoint = opts.toUrl.replace(/\/+$/, "") + "/api/inbox";
  const httpRes = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fromWarren: opts.fromWarrenName,
      audience,
      body: compressed,
      signature,
      sourceLootId: sourceLoot.id,
    }),
  });
  if (!httpRes.ok) {
    const text = await httpRes.text().catch(() => "(no body)");
    throw new Error(
      `HTTP delivery failed: ${httpRes.status} ${httpRes.statusText} — ${text}`,
    );
  }
  const remote = (await httpRes.json()) as { ok?: boolean; id?: string };
  if (!remote.ok || typeof remote.id !== "string") {
    throw new Error(
      `Remote did not acknowledge delivery: ${JSON.stringify(remote)}`,
    );
  }

  const outbox: OutboxRecord = {
    id: remote.id,
    toWarren: opts.toUrl,
    audience,
    sourceLootId: sourceLoot.id,
    pigeonLootId: pigeonLoot.id,
    signature,
    sentAt: Date.now(),
  };
  await opts.fromHoard.stashOutbox(outbox);

  return { outbox, pigeonLoot, remoteId: remote.id };
}

function pigeonPrompt(audience: string, body: string): string {
  return (
    `Compress the following artifact for this audience: ${audience}.\n\n` +
    `Preserve every essential fact and instruction. ` +
    `Drop preamble, repetition, and meta-commentary. ` +
    `Output only the compressed message.\n\n` +
    `Artifact:\n${body}`
  );
}

export function signMessage(
  sourceLootId: string,
  pigeonLootId: string,
  body: string,
  fromWarren: string,
  peerSecret?: string,
): string {
  const loose = looseSignature(sourceLootId, body, fromWarren);
  const tight = createHash("sha256")
    .update(loose)
    .update("\0")
    .update(pigeonLootId)
    .digest("hex")
    .slice(0, 16);
  let sig = `${loose}.${tight}`;
  if (peerSecret) {
    const hmac = createHmac("sha256", peerSecret).update(sig).digest("hex");
    sig += `;hmac:${hmac}`;
  }
  return sig;
}

export function looseSignature(
  sourceLootId: string,
  body: string,
  fromWarren: string,
): string {
  return createHash("sha256")
    .update(fromWarren)
    .update("\0")
    .update(sourceLootId)
    .update("\0")
    .update(body)
    .digest("hex")
    .slice(0, 16);
}

export function verifyHmac(signature: string, secret: string): boolean {
  const i = signature.indexOf(";hmac:");
  if (i < 0) return false;
  const base = signature.slice(0, i);
  const tag = signature.slice(i + ";hmac:".length);
  const expected = createHmac("sha256", secret).update(base).digest("hex");
  if (tag.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(tag, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
