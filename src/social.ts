import { createHash } from "node:crypto";
import type { DirectMessage, FriendRecord, FriendRequest } from "./types.js";

const MAX_TEXT = 2000;

export function normalizeSocialName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) return null;
  return name;
}

export function normalizeSocialUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function normalizePublicKeyPem(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key.includes("BEGIN PUBLIC KEY")) return null;
  if (key.length > 8192) return null;
  return key;
}

export function normalizeMessageBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const body = value.trim();
  if (!body) return null;
  if (body.length > MAX_TEXT) return body.slice(0, MAX_TEXT);
  return body;
}

export function friendIdFromPublicKey(publicKey: string): string {
  return createHash("sha256")
    .update(publicKey)
    .digest("hex")
    .slice(0, 16);
}

export function makeThreadId(pubA: string, pubB: string): string {
  const [a, b] = [pubA.trim(), pubB.trim()].sort();
  return createHash("sha256")
    .update(a)
    .update("\0")
    .update(b)
    .digest("hex")
    .slice(0, 16);
}

export function makeMessagePreview(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length <= 120 ? oneLine : oneLine.slice(0, 119) + "…";
}

export function friendRequestPayload(req: FriendRequest): string {
  return JSON.stringify({
    id: req.id,
    fromName: req.fromName,
    fromUrl: req.fromUrl,
    fromPublicKey: req.fromPublicKey,
    toName: req.toName,
    toUrl: req.toUrl,
    createdAt: req.createdAt,
  });
}

export function directMessagePayload(msg: DirectMessage): string {
  return JSON.stringify({
    id: msg.id,
    threadId: msg.threadId,
    fromName: msg.fromName,
    fromUrl: msg.fromUrl,
    fromPublicKey: msg.fromPublicKey,
    toName: msg.toName,
    toUrl: msg.toUrl,
    body: msg.body,
    createdAt: msg.createdAt,
  });
}

export function normalizeFriendRequest(value: unknown): FriendRequest | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === "string" ? v.id.trim() : "";
  const fromName = normalizeSocialName(v.fromName);
  const fromUrl = normalizeSocialUrl(v.fromUrl);
  const fromPublicKey = normalizePublicKeyPem(v.fromPublicKey);
  const toName = normalizeSocialName(v.toName);
  const toUrl = normalizeSocialUrl(v.toUrl);
  const createdAt = typeof v.createdAt === "string" ? v.createdAt : "";
  const signature = typeof v.signature === "string" ? v.signature.trim() : "";
  if (!id || !fromName || !fromUrl || !fromPublicKey || !toName || !toUrl || !createdAt || !signature) {
    return null;
  }
  return {
    id,
    fromName,
    fromUrl,
    fromPublicKey,
    toName,
    toUrl,
    createdAt,
    signature,
  };
}

export function normalizeDirectMessage(value: unknown): DirectMessage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === "string" ? v.id.trim() : "";
  const threadId = typeof v.threadId === "string" ? v.threadId.trim() : "";
  const fromName = normalizeSocialName(v.fromName);
  const fromUrl = normalizeSocialUrl(v.fromUrl);
  const fromPublicKey = normalizePublicKeyPem(v.fromPublicKey);
  const toName = normalizeSocialName(v.toName);
  const toUrl = normalizeSocialUrl(v.toUrl);
  const body = normalizeMessageBody(v.body);
  const createdAt = typeof v.createdAt === "string" ? v.createdAt : "";
  const signature = typeof v.signature === "string" ? v.signature.trim() : "";
  const readAt = typeof v.readAt === "string" && v.readAt.trim() ? v.readAt : undefined;
  if (
    !id || !threadId || !fromName || !fromUrl || !fromPublicKey || !toName || !toUrl ||
    !body || !createdAt || !signature
  ) {
    return null;
  }
  return {
    id,
    threadId,
    fromName,
    fromUrl,
    fromPublicKey,
    toName,
    toUrl,
    body,
    createdAt,
    signature,
    ...(readAt ? { readAt } : {}),
  };
}

export function normalizeFriendRecord(value: unknown): FriendRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === "string" ? v.id.trim() : "";
  const name = normalizeSocialName(v.name);
  const url = normalizeSocialUrl(v.url);
  const publicKey = normalizePublicKeyPem(v.publicKey);
  const createdAt = typeof v.createdAt === "string" ? v.createdAt : "";
  const note = typeof v.note === "string" ? v.note.trim() : undefined;
  if (!id || !name || !url || !publicKey || !createdAt) return null;
  return {
    id,
    name,
    url,
    publicKey,
    createdAt,
    ...(note ? { note } : {}),
  };
}
