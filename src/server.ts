import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import express, { type Request, type Response } from "express";
import {
  MAX_PEERS,
  MAX_TEAM_MEMBERS,
  makeCountryName,
  makeCountryCode,
  normalizeCountryConfig,
  normalizeCountryCode,
  normalizeCountryId,
  normalizeCountryName,
  normalizeWarrenPeers,
  normalizeWarrenPeer,
  resolveRoleOwners,
  sampleOpenCountries,
} from "./country.js";
import {
  ensureCountryIdentity,
  readCountryIdentity,
  signCountryPayload,
  verifyCountryPayload,
} from "./country-identity.js";
import { verifyHmac, verifyInbox } from "./federation.js";
import { performRite, type RiteStep } from "./rite.js";
import { loadRewardPlugin } from "./reward-plugin.js";
import {
  ensureRunDir,
  loadAllRuns,
  saveRun,
  type RunRecord,
} from "./run-store.js";
import {
  CREATURE_KINDS,
  type Artifact,
  type CountryJoinRequest,
  type CountryQueuedRite,
  type CreatureKind,
  type DirectMessage,
  type DirectMessageThread,
  type FriendRecord,
  type FriendRequest,
  type InboxMessage,
  type OutputFormat,
  type Personality,
  type ProviderConfig,
} from "./types.js";
import { executePlan, type PlanExecutionEvent } from "./plan-executor.js";
import { planTask } from "./planner.js";
import { findRelevantArtifacts } from "./artifact.js";
import { exportRunAsMasTrace } from "./trace-export.js";
import { normalizeOutputFormat } from "./formatting.js";
import {
  MODEL_SLOTS,
  PROVIDER_PRESETS,
  normalizeProviderConfig,
  resolveProviderRuntime,
} from "./providers.js";
import {
  clearProviderSecretForRoot,
  readProviderSecretsForRootSync,
  setProviderSecretForRoot,
} from "./provider-secrets.js";
import { loadWarren, saveWarrenManifest, type Warren } from "./warren.js";
import {
  directMessagePayload,
  friendIdFromPublicKey,
  friendRequestPayload,
  makeMessagePreview,
  makeThreadId,
  normalizeDirectMessage,
  normalizeFriendRecord,
  normalizeFriendRequest,
  normalizeMessageBody,
  normalizePublicKeyPem,
  normalizeSocialName,
  normalizeSocialUrl,
} from "./social.js";

export interface ServeOptions {
  cwd: string;
  port: number;
}

interface RunState {
  record: RunRecord;
  subscribers: Set<Response>;
}

const DISCOVERY_OPEN_MEMBER_LIMIT = 3;

function runSummary(record: RunRecord): Omit<RunRecord, "events"> & { eventCount: number } {
  const { events, ...rest } = record;
  return {
    ...rest,
    eventCount: events.length,
  };
}

function cspHeaderForRequest(): string {
  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "https://www.gstatic.com",
    "https://apis.google.com",
    "https://www.googleapis.com",
  ].join(" ");
  const connectSrc = [
    "'self'",
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
    "https://firestore.googleapis.com",
    "https://www.googleapis.com",
    "https://*.googleapis.com",
    "https://*.firebaseio.com",
    "wss://*.firebaseio.com",
  ].join(" ");
  const frameSrc = [
    "'self'",
    "https://accounts.google.com",
    "https://*.google.com",
    "https://*.firebaseapp.com",
  ].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    `frame-src ${frameSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

export async function serve(opts: ServeOptions): Promise<void> {
  const warren = await loadWarren(opts.cwd);
  await ensureCountryIdentity(warren.root);
  ensureCountryDefaults(warren);
  await saveWarrenManifest(warren);
  const app = express();
  const runs = new Map<string, RunState>();
  const runDir = await ensureRunDir(warren.root);

  // Recover persisted runs. Anything still flagged in-progress when we boot
  // is interpreted as interrupted by an earlier server restart — mark it done
  // and keep it visible so its SSE history can still be replayed.
  // recover persisted runs; mark anything still in-progress as interrupted
  const persisted = await loadAllRuns(runDir);
  for (const rec of persisted) {
    if (!rec.done) {
      rec.done = true;
      rec.error = rec.error ?? "interrupted (server restarted)";
      rec.finishedAt = rec.finishedAt ?? Date.now();
      await saveRun(runDir, rec);
    }
    runs.set(rec.runId, { record: rec, subscribers: new Set() });
  }

  app.use(express.json({ limit: "1mb" }));
  app.use("/assets", express.static(join(warren.root, "site/assets")));
  app.use((_req, res, next) => {
    res.setHeader("X-Goblintown-Warren", warren.manifest.name);
    res.setHeader("Content-Security-Policy", cspHeaderForRequest());
    next();
  });

  app.get("/", async (_req, res) => renderHome(warren, runs, res));
  app.get("/rite/new", (_req, res) =>
    res.send(layout("New Rite", newRiteForm())),
  );
  app.get("/rite/:id", async (req, res) => renderRite(warren, req, res));
  app.get("/quest/:id", async (req, res) => renderQuest(warren, req, res));
  app.get("/loot/:id", async (req, res) => renderLoot(warren, req, res));
  app.get("/drift", async (_req, res) => renderDrift(warren, res));
  app.get("/inbox", async (_req, res) => renderInbox(warren, res));
  app.get("/outbox", async (_req, res) => renderOutbox(warren, res));
  app.get("/runs", async (_req, res) => renderRuns(runs, res));

  app.post("/api/rite", async (req, res) =>
    startRiteRun(warren, runs, runDir, req, res),
  );
  app.post("/api/plan", async (req, res) =>
    startPlanRun(warren, runs, runDir, req, res),
  );
  app.get("/api/rite/:runId/stream", (req, res) =>
    streamRiteRun(runs, req, res),
  );
  app.get("/api/runs", (_req, res) =>
    res.json(
      [...runs.values()]
        .map((r) => runSummary(r.record))
        .sort((a, b) => b.startedAt - a.startedAt),
    ),
  );
  app.get("/api/runs/:runId", (req, res) => {
    const state = runs.get(req.params.runId);
    if (!state) {
      res.status(404).json({ error: "no such run" });
      return;
    }
    const includeEvents = req.query.full === "1";
    res.json(includeEvents ? state.record : runSummary(state.record));
  });
  app.get("/api/trace/:runId", (req, res) => {
    const state = runs.get(req.params.runId);
    if (!state) {
      // try by finalRiteId
      const byRite = [...runs.values()].find((r) => r.record.finalRiteId === req.params.runId);
      if (!byRite) {
        res.status(404).json({ error: "no run/rite for that id" });
        return;
      }
      res.json(exportRunAsMasTrace(byRite.record, warren.manifest.name));
      return;
    }
    res.json(exportRunAsMasTrace(state.record, warren.manifest.name));
  });
  app.get("/api/loot/:id", async (req, res) => {
    const loot = await warren.hoard.getLoot(req.params.id);
    if (!loot) {
      res.status(404).json({ error: "loot not found" });
      return;
    }
    res.json(loot);
  });
  app.get("/api/artifact/:id", async (req, res) => {
    const art = await warren.hoard.getArtifact(req.params.id);
    if (!art) {
      res.status(404).json({ error: "artifact not found" });
      return;
    }
    res.json(art);
  });
  app.get("/api/rite/:id/artifact", async (req, res) => {
    const art = await warren.hoard.getArtifactByRiteId(req.params.id);
    if (!art) {
      res.status(404).json({ error: "no artifact for that rite" });
      return;
    }
    res.json(art);
  });
  app.get("/api/artifacts", async (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    const all = (await warren.hoard.allArtifacts()).sort((a, b) => b.timestamp - a.timestamp);
    res.json(all.slice(0, Math.max(1, Math.min(500, limit))));
  });
  app.get("/api/warren/stats", async (_req, res) => {
    const [loot, rites] = await Promise.all([
      warren.hoard.allLoot(),
      warren.hoard.allRites(),
    ]);
    const driftSum = loot.reduce((s, l) => s + l.drift.driftRate, 0);
    const drift = loot.length ? driftSum / loot.length : 0;
    res.json({
      warren: warren.manifest.name,
      loot: loot.length,
      rites: rites.length,
      drift,
    });
  });
  app.get("/api/providers", (_req, res) => {
    res.json({
      presets: Object.values(PROVIDER_PRESETS).map((p) => ({
        id: p.id,
        label: p.label,
        baseURL: p.baseURL,
        apiKeyEnv: p.apiKeyEnv,
        local: !!p.local,
        models: p.models,
        note: p.note,
      })),
      modelSlots: MODEL_SLOTS,
    });
  });
  app.get("/api/provider", (_req, res) => {
    res.json(providerPayload(warren));
  });
  app.get("/api/firebase/config", (_req, res) => {
    res.json(firebaseClientConfigPayload());
  });
  app.post("/api/provider", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const config = normalizeProviderConfig(body);
    warren.manifest.provider = config;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
    const clearApiKey = body.clearApiKey === true;
    const apiKeyEnv = config.apiKeyEnv ?? "OPENAI_API_KEY";
    if (apiKey !== undefined) {
      if (apiKey.length > 0) {
        await setProviderSecretForRoot(warren.root, apiKeyEnv, apiKey);
      } else {
        await clearProviderSecretForRoot(warren.root, apiKeyEnv);
      }
    } else if (clearApiKey) {
      await clearProviderSecretForRoot(warren.root, apiKeyEnv);
    }
    await saveWarrenManifest(warren);
    res.json(providerPayload(warren));
  });
  app.get("/api/friends", async (_req, res) => {
    const own = await ensureCountryIdentity(warren.root);
    const ownName = warren.manifest.name;
    const friends = await warren.hoard.allFriends();
    const requests = await warren.hoard.allFriendRequests();
    const threads = await warren.hoard.allDmThreads();
    const threadRows = await Promise.all(threads.map(async (t) => {
      const unread = await unreadCountForThread(warren, t.id, ownName);
      const otherPublicKey = t.participantA === own.publicKeyPem ? t.participantB : t.participantA;
      const friend = friends.find((f) => f.publicKey === otherPublicKey);
      return {
        ...t,
        unread,
        friendId: friend?.id ?? "",
        friendName: friend?.name ?? "unknown",
      };
    }));
    res.json({
      friends: friends.sort((a, b) => a.name.localeCompare(b.name)),
      pendingRequests: requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      threads: threadRows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    });
  });
  app.post("/api/friends/request", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestedCode = normalizeCountryCode(body.countryCode ?? body.code);
    let targetUrl = normalizeSocialUrl(body.targetUrl);
    let resolvedCountry: {
      source: string;
      countryId: string;
      countryName: string;
      countryCode: string;
      memberCount: number;
      discoverable: boolean;
      leadName: string;
      leadUrl?: string;
      targetUrl?: string;
      leaderPublicKey?: string;
    } | null = null;
    if (!targetUrl && requestedCode) {
      const countries = await discoverCountries(warren);
      const discoverable = filterDiscoverableCountries(warren, countries, requestedCode);
      const openCountries = filterOpenCountries(discoverable);
      resolvedCountry = sampleOpenCountries(openCountries, 1)[0] ?? null;
      targetUrl = normalizeSocialUrl(resolvedCountry?.targetUrl);
      if (!targetUrl) {
        res.status(404).json({
          error: `no discoverable country found for code ${requestedCode}`,
        });
        return;
      }
    }
    if (!targetUrl) {
      res.status(400).json({ error: "countryCode or targetUrl required" });
      return;
    }
    const fromUrl = normalizeSocialUrl(process.env.GOBLINTOWN_PUBLIC_URL);
    if (!fromUrl) {
      res.status(400).json({ error: "Set GOBLINTOWN_PUBLIC_URL before sending friend requests." });
      return;
    }
    if (fromUrl === targetUrl) {
      res.status(400).json({ error: "cannot friend yourself" });
      return;
    }
    const own = await ensureCountryIdentity(warren.root);
    let remotePublic: {
      leadName: string;
      leadUrl?: string;
      leaderPublicKey?: string;
    } | null = null;
    try {
      const pubResp = await fetch(`${targetUrl}/api/country/public`);
      if (pubResp.ok) {
        remotePublic = (await pubResp.json()) as {
          leadName: string;
          leadUrl?: string;
          leaderPublicKey?: string;
        };
      }
    } catch {
      remotePublic = null;
    }
    const toName = normalizeSocialName(body.toName) ?? normalizeSocialName(remotePublic?.leadName) ?? "lead";
    const toUrl =
      normalizeSocialUrl(body.toUrl) ??
      normalizeSocialUrl(remotePublic?.leadUrl) ??
      normalizeSocialUrl(resolvedCountry?.leadUrl) ??
      targetUrl;
    const toPublicKey =
      normalizePublicKeyPem(body.toPublicKey) ??
      normalizePublicKeyPem(remotePublic?.leaderPublicKey) ??
      normalizePublicKeyPem(resolvedCountry?.leaderPublicKey);
    if (!toPublicKey) {
      res.status(400).json({ error: "target public key unavailable; remote must expose /api/country/public leaderPublicKey" });
      return;
    }
    const requestMsg: FriendRequest = {
      id: randomUUID().slice(0, 12),
      fromName: warren.manifest.name,
      fromUrl,
      fromPublicKey: own.publicKeyPem,
      toName,
      toUrl,
      createdAt: new Date().toISOString(),
      signature: "",
    };
    requestMsg.signature = signCountryPayload(own.privateKeyPem, friendRequestPayload(requestMsg));
    const sendResp = await fetch(`${toUrl}/api/friends/receive-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestMsg),
    });
    if (!sendResp.ok) {
      const text = await sendResp.text().catch(() => "");
      res.status(502).json({ error: `friend request failed: ${sendResp.status} ${sendResp.statusText} ${text}` });
      return;
    }
    res.json({
      ok: true,
      id: requestMsg.id,
      ...(resolvedCountry
        ? {
            country: {
              code: resolvedCountry.countryCode,
              name: resolvedCountry.countryName,
            },
          }
        : {}),
    });
  });
  app.post("/api/friends/receive-request", async (req, res) => {
    const requestMsg = normalizeFriendRequest(req.body);
    if (!requestMsg) {
      res.status(400).json({ error: "invalid friend request payload" });
      return;
    }
    const ownUrl = normalizeSocialUrl(process.env.GOBLINTOWN_PUBLIC_URL);
    if (!ownUrl) {
      res.status(400).json({ error: "receiver missing GOBLINTOWN_PUBLIC_URL" });
      return;
    }
    if (requestMsg.toName !== warren.manifest.name || requestMsg.toUrl !== ownUrl) {
      res.status(400).json({ error: "friend request recipient mismatch" });
      return;
    }
    if (!verifyCountryPayload(
      requestMsg.fromPublicKey,
      friendRequestPayload(requestMsg),
      requestMsg.signature,
    )) {
      res.status(400).json({ error: "friend request signature invalid" });
      return;
    }
    const pending = await warren.hoard.allFriendRequests();
    const already = pending.some((p) => p.id === requestMsg.id);
    if (!already) await warren.hoard.stashFriendRequest(requestMsg);
    res.json({ ok: true, id: requestMsg.id });
  });
  app.post("/api/friends/respond", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    const approve = body.approve !== false;
    if (!requestId) {
      res.status(400).json({ error: "requestId required" });
      return;
    }
    const pending = await warren.hoard.allFriendRequests();
    const requestMsg = pending.find((r) => r.id === requestId);
    if (!requestMsg) {
      res.status(404).json({ error: "friend request not found" });
      return;
    }
    await warren.hoard.removeFriendRequest(requestId);
    if (!approve) {
      res.json({ ok: true, approved: false });
      return;
    }
    const friend: FriendRecord = {
      id: friendIdFromPublicKey(requestMsg.fromPublicKey),
      name: requestMsg.fromName,
      url: requestMsg.fromUrl,
      publicKey: requestMsg.fromPublicKey,
      createdAt: new Date().toISOString(),
    };
    await upsertFriend(warren, friend);
    const own = await ensureCountryIdentity(warren.root);
    const ownUrl = normalizeSocialUrl(process.env.GOBLINTOWN_PUBLIC_URL);
    let callbackDelivered = false;
    let callbackError = "";
    if (ownUrl) {
      const approvedMsg: FriendRequest = {
        id: randomUUID().slice(0, 12),
        fromName: warren.manifest.name,
        fromUrl: ownUrl,
        fromPublicKey: own.publicKeyPem,
        toName: requestMsg.fromName,
        toUrl: requestMsg.fromUrl,
        createdAt: new Date().toISOString(),
        signature: "",
      };
      approvedMsg.signature = signCountryPayload(own.privateKeyPem, friendRequestPayload(approvedMsg));
      try {
        const cbResp = await fetch(`${requestMsg.fromUrl}/api/friends/approved`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(approvedMsg),
        });
        if (!cbResp.ok) {
          const text = await cbResp.text().catch(() => "");
          callbackError = `approval callback failed: ${cbResp.status} ${cbResp.statusText} ${text}`;
        } else {
          callbackDelivered = true;
        }
      } catch (err) {
        callbackError = err instanceof Error ? err.message : String(err);
      }
    } else {
      callbackError = "missing GOBLINTOWN_PUBLIC_URL";
    }
    res.json({
      ok: true,
      approved: true,
      callback: {
        delivered: callbackDelivered,
        ...(callbackError ? { error: callbackError } : {}),
      },
    });
  });
  app.post("/api/friends/approved", async (req, res) => {
    const approvedMsg = normalizeFriendRequest(req.body);
    if (!approvedMsg) {
      res.status(400).json({ error: "invalid approval payload" });
      return;
    }
    const ownUrl = normalizeSocialUrl(process.env.GOBLINTOWN_PUBLIC_URL);
    if (!ownUrl) {
      res.status(400).json({ error: "receiver missing GOBLINTOWN_PUBLIC_URL" });
      return;
    }
    if (approvedMsg.toName !== warren.manifest.name || approvedMsg.toUrl !== ownUrl) {
      res.status(400).json({ error: "approval recipient mismatch" });
      return;
    }
    if (!verifyCountryPayload(
      approvedMsg.fromPublicKey,
      friendRequestPayload(approvedMsg),
      approvedMsg.signature,
    )) {
      res.status(400).json({ error: "approval signature invalid" });
      return;
    }
    await upsertFriend(warren, {
      id: friendIdFromPublicKey(approvedMsg.fromPublicKey),
      name: approvedMsg.fromName,
      url: approvedMsg.fromUrl,
      publicKey: approvedMsg.fromPublicKey,
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  });
  app.post("/api/friends/:friendId/remove", async (req, res) => {
    const friendId = req.params.friendId.trim();
    if (!friendId) {
      res.status(400).json({ error: "friendId required" });
      return;
    }
    await warren.hoard.removeFriend(friendId);
    res.json({ ok: true });
  });
  app.get("/api/dm/threads", async (_req, res) => {
    const ownName = warren.manifest.name;
    const own = await ensureCountryIdentity(warren.root);
    const friends = await warren.hoard.allFriends();
    const threads = await warren.hoard.allDmThreads();
    const rows = await Promise.all(threads.map(async (t) => {
      const unread = await unreadCountForThread(warren, t.id, ownName);
      const otherPublicKey = t.participantA === own.publicKeyPem ? t.participantB : t.participantA;
      const friend = friends.find((f) => f.publicKey === otherPublicKey);
      return {
        ...t,
        unread,
        friendId: friend?.id ?? "",
        friendName: friend?.name ?? "unknown",
      };
    }));
    res.json(rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  });
  app.get("/api/dm/:threadId", async (req, res) => {
    const threadId = req.params.threadId.trim();
    if (!threadId) {
      res.status(400).json({ error: "threadId required" });
      return;
    }
    const before = typeof req.query.before === "string" ? req.query.before : "";
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 100;
    const all = (await warren.hoard.allDmMessages(threadId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let rows = all;
    if (before) rows = rows.filter((m) => m.createdAt < before);
    rows = rows.slice(Math.max(0, rows.length - limit));
    res.json(rows);
  });
  app.post("/api/dm/send", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const friendId = typeof body.friendId === "string" ? body.friendId.trim() : "";
    const textBody = normalizeMessageBody(body.body);
    if (!friendId || !textBody) {
      res.status(400).json({ error: "friendId and body required" });
      return;
    }
    const ownUrl = normalizeSocialUrl(process.env.GOBLINTOWN_PUBLIC_URL);
    if (!ownUrl) {
      res.status(400).json({ error: "Set GOBLINTOWN_PUBLIC_URL before sending messages." });
      return;
    }
    const friend = (await warren.hoard.allFriends()).find((f) => f.id === friendId);
    if (!friend) {
      res.status(404).json({ error: "friend not found" });
      return;
    }
    const own = await ensureCountryIdentity(warren.root);
    const threadId = makeThreadId(own.publicKeyPem, friend.publicKey);
    const msg: DirectMessage = {
      id: randomUUID().slice(0, 12),
      threadId,
      fromName: warren.manifest.name,
      fromUrl: ownUrl,
      fromPublicKey: own.publicKeyPem,
      toName: friend.name,
      toUrl: friend.url,
      body: textBody,
      createdAt: new Date().toISOString(),
      signature: "",
    };
    msg.signature = signCountryPayload(own.privateKeyPem, directMessagePayload(msg));
    await warren.hoard.stashDmMessage(msg);
    await warren.hoard.stashDmThread({
      id: threadId,
      participantA: [own.publicKeyPem, friend.publicKey].sort()[0],
      participantB: [own.publicKeyPem, friend.publicKey].sort()[1],
      updatedAt: msg.createdAt,
      lastMessagePreview: makeMessagePreview(msg.body),
    });
    const remoteResp = await fetch(`${friend.url}/api/dm/receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    if (!remoteResp.ok) {
      const text = await remoteResp.text().catch(() => "");
      res.status(502).json({ error: `delivery failed: ${remoteResp.status} ${remoteResp.statusText} ${text}` });
      return;
    }
    res.json({ ok: true, id: msg.id, threadId });
  });
  app.post("/api/dm/receive", async (req, res) => {
    const msg = normalizeDirectMessage(req.body);
    if (!msg) {
      res.status(400).json({ error: "invalid message payload" });
      return;
    }
    const ownUrl = normalizeSocialUrl(process.env.GOBLINTOWN_PUBLIC_URL);
    if (!ownUrl || msg.toName !== warren.manifest.name || msg.toUrl !== ownUrl) {
      res.status(400).json({ error: "message recipient mismatch" });
      return;
    }
    if (!verifyCountryPayload(msg.fromPublicKey, directMessagePayload(msg), msg.signature)) {
      res.status(400).json({ error: "message signature invalid" });
      return;
    }
    const expectedThreadId = makeThreadId(
      msg.fromPublicKey,
      (await ensureCountryIdentity(warren.root)).publicKeyPem,
    );
    if (expectedThreadId !== msg.threadId) {
      res.status(400).json({ error: "thread mismatch" });
      return;
    }
    const friend = (await warren.hoard.allFriends()).find((f) => f.publicKey === msg.fromPublicKey);
    if (!friend) {
      res.status(403).json({ error: "sender is not in your friends list" });
      return;
    }
    await warren.hoard.stashDmMessage(msg);
    await warren.hoard.stashDmThread({
      id: msg.threadId,
      participantA: [msg.fromPublicKey, friend.publicKey].sort()[0],
      participantB: [msg.fromPublicKey, friend.publicKey].sort()[1],
      updatedAt: msg.createdAt,
      lastMessagePreview: makeMessagePreview(msg.body),
    });
    res.json({ ok: true, id: msg.id });
  });
  app.post("/api/dm/:threadId/read", async (req, res) => {
    const threadId = req.params.threadId.trim();
    if (!threadId) {
      res.status(400).json({ error: "threadId required" });
      return;
    }
    const ownName = warren.manifest.name;
    const rows = await warren.hoard.allDmMessages(threadId);
    const now = new Date().toISOString();
    await Promise.all(rows.map(async (msg) => {
      if (msg.toName === ownName && !msg.readAt) {
        await warren.hoard.stashDmMessage({ ...msg, readAt: now });
      }
    }));
    res.json({ ok: true });
  });
  app.get("/api/country", async (_req, res) => {
    res.json(await countryPayload(warren));
  });
  app.get("/api/country/public", async (_req, res) => {
    res.json(await countryPublicPayload(warren));
  });
  app.get("/api/country/presence", async (_req, res) => {
    const ownName = warren.manifest.name;
    const [inbox, dmThreads] = await Promise.all([
      warren.hoard.allInbox(),
      warren.hoard.allDmThreads(),
    ]);
    let unreadDm = 0;
    for (const t of dmThreads) unreadDm += await unreadCountForThread(warren, t.id, ownName);
    res.json({
      online: true,
      hasMail: inbox.length > 0 || unreadDm > 0,
      unreadDm,
      checkedAt: new Date().toISOString(),
      warren: warren.manifest.name,
    });
  });
  app.get("/api/country/discover", async (_req, res) => {
    const list = await discoverCountries(warren);
    const qCode = normalizeCountryCode(_req.query.code) ?? undefined;
    const discoverable = filterDiscoverableCountries(warren, list, qCode);
    const openCountries = filterOpenCountries(discoverable);
    res.json({
      countries: openCountries,
      randomOpen: sampleOpenCountries(openCountries, 10),
    });
  });
  app.post("/api/country/join", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const targetUrl = typeof body.targetUrl === "string" ? body.targetUrl.trim() : "";
    const countryId = normalizeCountryId(body.countryId);
    const countryCode = normalizeCountryCode(body.countryCode);
    if (!targetUrl || !countryId || !countryCode) {
      res.status(400).json({ error: "targetUrl, countryId, countryCode required" });
      return;
    }
    const own = normalizeCountryConfig(warren.manifest.country);
    const ownUrl = (process.env.GOBLINTOWN_PUBLIC_URL ?? "").replace(/\/+$/, "");
    if (ownUrl && targetUrl.replace(/\/+$/, "") === ownUrl) {
      res.status(400).json({ error: "cannot send join request to your own town URL" });
      return;
    }
    if (
      own.countryId && own.countryCode &&
      own.countryId === countryId && own.countryCode === countryCode
    ) {
      res.status(400).json({ error: "cannot join your own country" });
      return;
    }
    try {
      const request = await sendJoinRequestToCountryLeader(
        warren,
        targetUrl,
        countryId,
        countryCode,
      );
      res.json({ ok: true, requestId: request.id });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post("/api/country/join-request", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const request = normalizeIncomingJoinRequest(body);
    if (!request) {
      res.status(400).json({ error: "invalid join request" });
      return;
    }
    const c = normalizeCountryConfig(warren.manifest.country);
    if (c.countryId !== request.countryId || c.countryCode !== request.countryCode) {
      res.status(400).json({ error: "country mismatch" });
      return;
    }
    if (!verifyCountryPayload(request.fromPublicKey, joinRequestMessage(request), request.signature)) {
      res.status(400).json({ error: "signature invalid" });
      return;
    }
    if ((warren.manifest.peers ?? []).length >= MAX_PEERS) {
      res.status(409).json({ error: "team full" });
      return;
    }
    const pending = c.pendingJoinRequests ?? [];
    if (pending.some((r) => r.id === request.id)) {
      res.json({ ok: true, duplicate: true });
      return;
    }
    warren.manifest.country = normalizeCountryConfig({
      ...c,
      pendingJoinRequests: [...pending, request],
    });
    await saveWarrenManifest(warren);
    res.json({ ok: true, id: request.id });
  });
  app.post("/api/country/join-approved", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const peer = normalizeWarrenPeer({
      name: body.name,
      url: body.url,
      note: body.note,
      createdAt: new Date().toISOString(),
    });
    const countryId = normalizeCountryId(body.countryId);
    const countryName = normalizeCountryName(body.countryName);
    const countryCode = normalizeCountryCode(body.countryCode);
    const leaderPublicKey = typeof body.leaderPublicKey === "string" ? body.leaderPublicKey.trim() : "";
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";
    if (!peer || !countryId || !countryName || !countryCode || !leaderPublicKey || !signature) {
      res.status(400).json({ error: "invalid approval payload" });
      return;
    }
    const msg = joinApprovalMessage({
      countryId,
      countryName,
      countryCode,
      peerName: peer.name,
      peerUrl: peer.url,
    });
    if (!verifyCountryPayload(leaderPublicKey, msg, signature)) {
      res.status(400).json({ error: "approval signature invalid" });
      return;
    }
    const peers = normalizeWarrenPeers([...(warren.manifest.peers ?? []), peer]);
    const c = normalizeCountryConfig(warren.manifest.country);
    warren.manifest.peers = peers;
    warren.manifest.country = normalizeCountryConfig({
      ...c,
      enabled: true,
      countryId,
      countryName,
      countryCode,
      leaderPublicKey,
    });
    await saveWarrenManifest(warren);
    res.json({ ok: true });
  });
  app.post("/api/country/join-approve", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    const approve = body.approve !== false;
    const c = normalizeCountryConfig(warren.manifest.country);
    const pending = c.pendingJoinRequests ?? [];
    const reqRow = pending.find((r) => r.id === requestId);
    if (!reqRow) {
      res.status(404).json({ error: "request not found" });
      return;
    }
    const remaining = pending.filter((r) => r.id !== requestId);
    if (!approve) {
      warren.manifest.country = normalizeCountryConfig({
        ...c,
        pendingJoinRequests: remaining,
      });
      await saveWarrenManifest(warren);
      res.json(await countryPayload(warren));
      return;
    }
    const nextPeers = normalizeWarrenPeers([
      ...(warren.manifest.peers ?? []),
      {
        name: reqRow.fromName,
        url: reqRow.fromUrl,
        createdAt: new Date().toISOString(),
        note: `country:${c.countryCode ?? ""}`,
      },
    ]);
    if (nextPeers.length > MAX_PEERS) {
      res.status(409).json({ error: "team full" });
      return;
    }
    warren.manifest.peers = nextPeers;
    warren.manifest.country = normalizeCountryConfig({
      ...c,
      pendingJoinRequests: remaining,
    });
    await saveWarrenManifest(warren);
    let delivered = false;
    let deliveryError = "";
    try {
      await notifyJoinApproved(warren, reqRow);
      delivered = true;
    } catch (err) {
      deliveryError = err instanceof Error ? err.message : String(err);
    }
    res.json({
      ...(await countryPayload(warren)),
      delivery: {
        delivered,
        ...(deliveryError ? { error: deliveryError } : {}),
      },
    });
  });
  app.post("/api/country", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = normalizeCountryConfig(warren.manifest.country);
    const peersRaw = Array.isArray(body.peers)
      ? body.peers
      : (warren.manifest.peers ?? []);
    if (Array.isArray(peersRaw) && peersRaw.length > MAX_PEERS) {
      res
        .status(400)
        .json({ error: `team full: max ${MAX_TEAM_MEMBERS} members (lead + ${MAX_PEERS} peers)` });
      return;
    }
    const peers = peersRaw
      .map((p) => normalizeWarrenPeer(p))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .slice(0, MAX_PEERS);
    const country = normalizeCountryConfig({
      ...current,
      ...(body.collabBackend !== undefined ? { collabBackend: body.collabBackend } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.countryId !== undefined ? { countryId: body.countryId } : {}),
      ...(body.countryName !== undefined ? { countryName: body.countryName } : {}),
      ...(body.countryCode !== undefined ? { countryCode: body.countryCode } : {}),
      ...(body.leaderPublicKey !== undefined ? { leaderPublicKey: body.leaderPublicKey } : {}),
      ...(body.discoverable !== undefined ? { discoverable: body.discoverable } : {}),
      ...(body.roleOwners !== undefined ? { roleOwners: body.roleOwners } : {}),
      ...(body.autoAssignLeadExtras !== undefined
        ? { autoAssignLeadExtras: body.autoAssignLeadExtras }
        : {}),
      ...(body.pendingJoinRequests !== undefined ? { pendingJoinRequests: body.pendingJoinRequests } : {}),
      ...(body.riteQueue !== undefined ? { riteQueue: body.riteQueue } : {}),
    });
    warren.manifest.peers = peers;
    warren.manifest.country = country;
    await saveWarrenManifest(warren);
    res.json(await countryPayload(warren));
  });
  app.post("/api/cli", async (req, res) => {
    const body = (req.body ?? {}) as { line?: unknown };
    if (typeof body.line !== "string" || body.line.trim().length === 0) {
      res.status(400).json({ error: "line is required" });
      return;
    }
    const args = parseCliLine(body.line.trim());
    if (args.length === 0) {
      res.status(400).json({ error: "empty command" });
      return;
    }
    if (args[0] === "serve") {
      res.status(400).json({ error: "`serve` is already running in this UI session." });
      return;
    }
    const result = await runCliLine(warren.root, args);
    res.json(result);
  });
  app.post("/api/inbox", async (req, res) => receiveInboxOverHttp(warren, req, res));

  app.use((_req, res) =>
    res
      .status(404)
      .send(layout("Not Found", "<h1>404</h1><p>The Hoard does not contain that.</p>")),
  );

  await new Promise<void>((resolve) => {
    app.listen(opts.port, () => {
      process.stdout.write(
        `Hoard UI listening on http://localhost:${opts.port}/\n` +
          `Warren: ${warren.manifest.name}  (${warren.root})\n`,
      );
      resolve();
    });
  });
}

async function startRiteRun(
  warren: Warren,
  runs: Map<string, RunState>,
  runDir: string,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as {
    task?: unknown;
    packSize?: unknown;
    scanGlobs?: unknown;
    personality?: unknown;
    noFallback?: unknown;
    noSpecialist?: unknown;
    specialistCap?: unknown;
    debate?: unknown;
    trollTools?: unknown;
    budgetTokens?: unknown;
    maxOutputTokens?: unknown;
    cite?: unknown;
    remember?: unknown;
    outputFormat?: unknown;
  };
  if (typeof body.task !== "string" || body.task.trim().length === 0) {
    res.status(400).json({ error: "task is required" });
    return;
  }
  const countryBlock = await checkCountryExecutionReadiness(
    warren,
    "rite",
    body.task,
  );
  if (countryBlock) {
    await saveWarrenManifest(warren);
    res.status(409).json(countryBlock);
    return;
  }
  const runId = randomUUID().slice(0, 12);
  const personality =
    typeof body.personality === "string"
      ? (body.personality as Personality)
      : undefined;
  const scanGlobs = Array.isArray(body.scanGlobs)
    ? (body.scanGlobs.filter((g) => typeof g === "string") as string[])
    : [];
  const packSize = typeof body.packSize === "number" ? body.packSize : 3;
  const noFallback = !!body.noFallback;
  const noSpecialist = !!body.noSpecialist;
  const specialistCap =
    typeof body.specialistCap === "number" && body.specialistCap > 0
      ? body.specialistCap
      : undefined;
  const debate = !!body.debate;
  const trollTools = !!body.trollTools;
  const budgetTokens =
    typeof body.budgetTokens === "number" && body.budgetTokens > 0
      ? body.budgetTokens
      : undefined;
  const maxOutputTokens =
    typeof body.maxOutputTokens === "number" && body.maxOutputTokens > 0
      ? body.maxOutputTokens
      : undefined;
  const citeRiteIds = Array.isArray(body.cite)
    ? (body.cite.filter((c) => typeof c === "string") as string[])
    : [];
  const remember = !!body.remember;
  const outputFormat = normalizeOutputFormat(
    body.outputFormat ?? warren.manifest.provider?.outputFormat,
  );

  const record: RunRecord = {
    runId,
    task: body.task,
    packSize,
    scanGlobs,
    personality,
    noFallback,
    events: [],
    done: false,
    startedAt: Date.now(),
  };
  await saveRun(runDir, record);

  const state: RunState = { record, subscribers: new Set() };
  runs.set(runId, state);

  // coalesce disk writes during bursty pack steps
  let pendingSave: NodeJS.Timeout | null = null;
  const persist = () => {
    if (pendingSave) return;
    pendingSave = setTimeout(() => {
      pendingSave = null;
      void saveRun(runDir, state.record);
    }, 100);
  };
  const persistNow = async () => {
    if (pendingSave) {
      clearTimeout(pendingSave);
      pendingSave = null;
    }
    await saveRun(runDir, state.record);
  };

  const emit = (kind: string, data: unknown) => {
    const ev = { seq: state.record.events.length, kind, data };
    state.record.events.push(ev);
    for (const sub of state.subscribers) writeSse(sub, ev);
    persist();
  };

  const finish = async () => {
    state.record.done = true;
    state.record.finishedAt = Date.now();
    await persistNow();
    for (const sub of state.subscribers) {
      try {
        sub.end();
      } catch {
        // already closed
      }
    }
  };

  const rewardPlugin = await loadRewardPlugin(warren.root);
  if (rewardPlugin.source !== "builtin") {
    emit("reward-plugin", { source: rewardPlugin.source });
  }

  // Optional Phase 1 memory hookup from the rite form too.
  const parentArtifacts: Artifact[] = [];
  for (const r of citeRiteIds) {
    const a = await warren.hoard.getArtifactByRiteId(r);
    if (a) parentArtifacts.push(a);
  }
  if (remember) {
    const all = await warren.hoard.allArtifacts();
    const auto = findRelevantArtifacts(all, body.task, 3).filter(
      (a) => !parentArtifacts.some((p) => p.id === a.id),
    );
    parentArtifacts.push(...auto);
  }

  performRite({
    task: body.task,
    packSize,
    scanGlobs,
    cwd: warren.root,
    hoard: warren.hoard,
    personality,
    rewardFn: rewardPlugin.fn,
    noFallback,
    noSpecialist,
    specialistCap,
    debate,
    trollTools,
    budgetTokens,
    maxOutputTokensPerCall: maxOutputTokens,
    outputFormat,
    parentArtifacts,
    onStep: (step: RiteStep) => emit("step", step),
  })
    .then(async (result) => {
      state.record.finalRiteId = result.rite.id;
      state.record.outcome = result.rite.outcome;
      emit("done", {
        riteId: result.rite.id,
        outcome: result.rite.outcome,
        winnerLootId: result.rite.winnerLootId,
      });
      await finish();
    })
    .catch(async (err: unknown) => {
      state.record.error =
        err instanceof Error ? err.message : String(err);
      emit("error", { message: state.record.error });
      await finish();
    });

  res.json({ runId });
}

async function startPlanRun(
  warren: Warren,
  runs: Map<string, RunState>,
  runDir: string,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as {
    task?: unknown;
    maxNodes?: unknown;
    maxReplan?: unknown;
    cite?: unknown;
    remember?: unknown;
    budgetTokens?: unknown;
    outputFormat?: unknown;
  };
  if (typeof body.task !== "string" || body.task.trim().length === 0) {
    res.status(400).json({ error: "task is required" });
    return;
  }
  const countryBlock = await checkCountryExecutionReadiness(
    warren,
    "plan",
    body.task,
  );
  if (countryBlock) {
    await saveWarrenManifest(warren);
    res.status(409).json(countryBlock);
    return;
  }
  const runId = randomUUID().slice(0, 12);
  const maxNodes = typeof body.maxNodes === "number" ? body.maxNodes : 6;
  const maxReplan = typeof body.maxReplan === "number" ? body.maxReplan : 2;
  const budgetTokens = typeof body.budgetTokens === "number" ? body.budgetTokens : undefined;
  const outputFormat = normalizeOutputFormat(
    body.outputFormat ?? warren.manifest.provider?.outputFormat,
  );
  const cites = Array.isArray(body.cite) ? (body.cite.filter((c) => typeof c === "string") as string[]) : [];
  const remember = !!body.remember;

  const record: RunRecord = {
    runId,
    task: body.task,
    packSize: 0, // not directly meaningful for plans
    scanGlobs: [],
    events: [],
    done: false,
    startedAt: Date.now(),
  };
  await saveRun(runDir, record);
  const state: RunState = { record, subscribers: new Set() };
  runs.set(runId, state);

  let pendingSave: NodeJS.Timeout | null = null;
  const persist = () => {
    if (pendingSave) return;
    pendingSave = setTimeout(() => {
      pendingSave = null;
      void saveRun(runDir, state.record);
    }, 100);
  };
  const persistNow = async () => {
    if (pendingSave) { clearTimeout(pendingSave); pendingSave = null; }
    await saveRun(runDir, state.record);
  };
  const emit = (kind: string, data: unknown) => {
    const ev = { seq: state.record.events.length, kind, data };
    state.record.events.push(ev);
    for (const sub of state.subscribers) writeSse(sub, ev);
    persist();
  };
  const finish = async () => {
    state.record.done = true;
    state.record.finishedAt = Date.now();
    await persistNow();
    for (const sub of state.subscribers) {
      try { sub.end(); } catch { /* closed */ }
    }
  };

  const rewardPlugin = await loadRewardPlugin(warren.root);

  // Memory load
  const parents: Artifact[] = [];
  for (const r of cites) {
    const a = await warren.hoard.getArtifactByRiteId(r);
    if (a) parents.push(a);
  }
  if (remember) {
    const all = await warren.hoard.allArtifacts();
    const auto = findRelevantArtifacts(all, body.task, 3).filter(
      (a) => !parents.some((p) => p.id === a.id),
    );
    parents.push(...auto);
  }

  // Plan + execute, surfacing both planner events and step events
  void (async () => {
    try {
      emit("plan:planning", { task: body.task, parents: parents.length });
      const { plan } = await planTask({
        task: body.task as string,
        parentArtifacts: parents,
        maxNodes,
      });
      emit("plan:built", { plan });
      const result = await executePlan({
        plan,
        cwd: warren.root,
        hoard: warren.hoard,
        rewardFn: rewardPlugin.fn,
        budgetTokens,
        outputFormat,
        parentArtifacts: parents,
        maxReplanDepth: maxReplan,
        onPlanEvent: (ev: PlanExecutionEvent) => emit(ev.kind, ev),
        onStep: (nodeId, step) => emit("step", { nodeId, step }),
      });
      state.record.outcome = result.outcome === "success" ? "winner" : "all_failed";
      state.record.finalRiteId = result.finalRiteId;
      emit("done", {
        riteId: result.finalRiteId,
        outcome: result.outcome,
        finalArtifactId: result.finalArtifact?.id,
        finalLootId: result.finalLootId,
        winnerLootId: result.finalLootId,
      });
      await finish();
    } catch (err) {
      state.record.error = err instanceof Error ? err.message : String(err);
      emit("error", { message: state.record.error });
      await finish();
    }
  })();

  res.json({ runId });
}

function streamRiteRun(
  runs: Map<string, RunState>,
  req: Request,
  res: Response,
): void {
  const state = runs.get(req.params.runId);
  if (!state) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  for (const ev of state.record.events) writeSse(res, ev);
  // Marker: history catch-up is complete; live events follow (or stream closes if done).
  res.write(`event: replay-end\ndata: {}\n\n`);
  if (state.record.done) {
    res.end();
    return;
  }
  state.subscribers.add(res);
  req.on("close", () => state.subscribers.delete(res));
}

function writeSse(res: Response, ev: { seq: number; kind: string; data: unknown }): void {
  res.write(`id: ${ev.seq}\n`);
  res.write(`event: ${ev.kind}\n`);
  res.write(`data: ${JSON.stringify(ev.data)}\n\n`);
}

async function renderRuns(
  runs: Map<string, RunState>,
  res: Response,
): Promise<void> {
  const records = [...runs.values()]
    .map((s) => s.record)
    .sort((a, b) => b.startedAt - a.startedAt);
  const rows = records
    .map((r) => {
      const status = r.done
        ? r.error
          ? `<span class="tag tag-fail">error</span>`
          : `<span class="tag tag-pass">done</span>`
        : `<span class="tag tag-winner">running</span>`;
      const link = r.finalRiteId
        ? `<a href="/rite/${esc(r.finalRiteId)}">${esc(r.finalRiteId)}</a>`
        : "—";
      const watchLabel = r.done ? "replay" : "watch live";
      return `<tr>
        <td><a href="/?run=${esc(r.runId)}" title="${watchLabel} in tank">${esc(r.runId)}</a></td>
        <td>${status}</td>
        <td>${link}</td>
        <td>${r.events.length}</td>
        <td>${esc(new Date(r.startedAt).toISOString())}</td>
        <td><pre style="margin:0; white-space: pre-wrap; word-break: break-word; max-width: 60ch;">${esc(r.task)}</pre></td>
      </tr>`;
    })
    .join("");
  const body = `
    <p><a href="/">← Hoard</a></p>
    <h1>Runs (${records.length})</h1>
    <table>
      <tr><th>runId</th><th>status</th><th>rite</th><th>events</th><th>started</th><th>task</th></tr>
      ${rows || `<tr><td colspan="6" class="muted">none</td></tr>`}
    </table>
  `;
  res.send(layout("Runs", body));
}

async function receiveInboxOverHttp(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as Partial<InboxMessage>;
  const required: (keyof InboxMessage)[] = [
    "fromWarren",
    "audience",
    "body",
    "signature",
    "sourceLootId",
  ];
  for (const k of required) {
    if (typeof body[k] !== "string") {
      res.status(400).json({ error: `${k} required` });
      return;
    }
  }
  const candidate: InboxMessage = {
    id: randomUUID().slice(0, 12),
    fromWarren: body.fromWarren as string,
    audience: body.audience as string,
    body: body.body as string,
    signature: body.signature as string,
    sourceLootId: body.sourceLootId as string,
    receivedAt: Date.now(),
  };
  if (!verifyInbox(candidate, warren.manifest.peerSecret)) {
    const reason = warren.manifest.peerSecret
      ? "signature or HMAC invalid"
      : "signature mismatch";
    res.status(400).json({ error: reason });
    return;
  }
  await warren.hoard.stashInbox(candidate);
  res.json({ ok: true, id: candidate.id });
}

function providerPayload(warren: Warren): {
  config: ProviderConfig;
  runtime: {
    id: string;
    label: string;
    baseURL?: string;
    apiKeyEnv: string;
    apiKeySource: "env" | "stored" | "dummy" | "none";
    hasStoredApiKey: boolean;
    hasApiKey: boolean;
    missingApiKey?: string;
    outputFormat: OutputFormat;
    models: Record<string, string>;
  };
} {
  const config = normalizeProviderConfig(warren.manifest.provider);
  const storedSecrets = readProviderSecretsForRootSync(warren.root);
  const runtime = resolveProviderRuntime(config, process.env, storedSecrets);
  return {
    config,
    runtime: {
      id: runtime.id,
      label: runtime.label,
      baseURL: runtime.baseURL,
      apiKeyEnv: runtime.apiKeyEnv,
      apiKeySource: runtime.apiKeySource,
      hasStoredApiKey: !!storedSecrets[runtime.apiKeyEnv],
      hasApiKey: runtime.apiKey.length > 0 && !runtime.missingApiKey,
      missingApiKey: runtime.missingApiKey,
      outputFormat: runtime.outputFormat,
      models: runtime.models,
    },
  };
}

async function upsertFriend(warren: Warren, candidate: FriendRecord): Promise<void> {
  const normalized = normalizeFriendRecord(candidate);
  if (!normalized) return;
  const existing = await warren.hoard.allFriends();
  const byPublicKey = existing.find((f) => f.publicKey === normalized.publicKey);
  if (byPublicKey) {
    await warren.hoard.stashFriend({
      ...byPublicKey,
      name: normalized.name,
      url: normalized.url,
      publicKey: normalized.publicKey,
      ...(normalized.note ? { note: normalized.note } : {}),
    });
    return;
  }
  await warren.hoard.stashFriend(normalized);
}

async function unreadCountForThread(warren: Warren, threadId: string, ownName: string): Promise<number> {
  const rows = await warren.hoard.allDmMessages(threadId);
  return rows.filter((m) => m.toName === ownName && !m.readAt).length;
}

async function countryPayload(warren: Warren): Promise<{
  lead: string;
  collabBackend: "local" | "firebase";
  modeEnabled: boolean;
  countryId: string;
  countryName: string;
  countryCode: string;
  identityPublicKey: string;
  discoverable: boolean;
  maxMembers: number;
  maxPeers: number;
  roles: CreatureKind[];
  members: Array<{ name: string; url?: string; lead: boolean; online: boolean; hasMail: boolean }>;
  peers: Array<{ name: string; url: string; note?: string }>;
  pendingJoinRequests: CountryJoinRequest[];
  riteQueue: CountryQueuedRite[];
  config: {
    autoAssignLeadExtras: boolean;
    roleOwners: Partial<Record<CreatureKind, string>>;
  };
  resolvedRoleOwners: Record<CreatureKind, string>;
}> {
  const identity = await ensureCountryIdentity(warren.root);
  const lead = warren.manifest.name;
  ensureCountryDefaults(warren);
  const peers = (warren.manifest.peers ?? []).map((p) => ({
    name: p.name,
    url: p.url,
    ...(p.note ? { note: p.note } : {}),
  }));
  const leadHasMail = (await warren.hoard.allInbox()).length > 0;
  const peerPresence = await Promise.all(
    peers.map(async (p) => ({
      peer: p,
      ...(await probePeerPresence(p.url)),
    })),
  );
  const members = [
    { name: lead, lead: true, online: true, hasMail: leadHasMail },
    ...peerPresence.map((p) => ({
      name: p.peer.name,
      url: p.peer.url,
      lead: false,
      online: p.online,
      hasMail: p.hasMail,
    })),
  ];
  const config = normalizeCountryConfig(warren.manifest.country);
  const memberNames = members.map((m) => m.name);
  return {
    lead,
    collabBackend: config.collabBackend === "firebase" ? "firebase" : "local",
    modeEnabled: config.enabled === true,
    countryId: config.countryId ?? "",
    countryName: config.countryName ?? "",
    countryCode: config.countryCode ?? "",
    identityPublicKey: identity.publicKeyPem,
    discoverable: config.discoverable !== false,
    maxMembers: MAX_TEAM_MEMBERS,
    maxPeers: MAX_PEERS,
    roles: [...CREATURE_KINDS],
    members,
    peers,
    pendingJoinRequests: config.pendingJoinRequests ?? [],
    riteQueue: config.riteQueue ?? [],
    config: {
      autoAssignLeadExtras: config.autoAssignLeadExtras !== false,
      roleOwners: config.roleOwners ?? {},
    },
    resolvedRoleOwners: resolveRoleOwners(config, memberNames, lead),
  };
}

function firebaseClientConfigPayload(): {
  enabled: boolean;
  config: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
    storageBucket?: string;
    messagingSenderId?: string;
    measurementId?: string;
  } | null;
} {
  const apiKey = trimmedEnv("FIREBASE_API_KEY");
  const authDomain = trimmedEnv("FIREBASE_AUTH_DOMAIN");
  const projectId = trimmedEnv("FIREBASE_PROJECT_ID");
  const appId = trimmedEnv("FIREBASE_APP_ID");
  const enabled = !!(apiKey && authDomain && projectId && appId);
  if (!enabled) return { enabled: false, config: null };
  return {
    enabled: true,
    config: {
      apiKey,
      authDomain,
      projectId,
      appId,
      ...(trimmedEnv("FIREBASE_STORAGE_BUCKET")
        ? { storageBucket: trimmedEnv("FIREBASE_STORAGE_BUCKET") as string }
        : {}),
      ...(trimmedEnv("FIREBASE_MESSAGING_SENDER_ID")
        ? { messagingSenderId: trimmedEnv("FIREBASE_MESSAGING_SENDER_ID") as string }
        : {}),
      ...(trimmedEnv("FIREBASE_MEASUREMENT_ID")
        ? { measurementId: trimmedEnv("FIREBASE_MEASUREMENT_ID") as string }
        : {}),
    },
  };
}

function trimmedEnv(name: string): string | null {
  const v = process.env[name];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

async function countryPublicPayload(warren: Warren): Promise<{
  warren: string;
  countryId: string;
  countryName: string;
  countryCode: string;
  memberCount: number;
  discoverable: boolean;
  leadName: string;
  leadUrl?: string;
  leaderPublicKey?: string;
}> {
  ensureCountryDefaults(warren);
  const c = normalizeCountryConfig(warren.manifest.country);
  return {
    warren: warren.manifest.name,
    countryId: c.countryId ?? "",
    countryName: c.countryName ?? "",
    countryCode: c.countryCode ?? "",
    memberCount: 1 + (warren.manifest.peers?.length ?? 0),
    discoverable: c.discoverable !== false,
    leadName: warren.manifest.name,
    leadUrl: process.env.GOBLINTOWN_PUBLIC_URL,
    leaderPublicKey: c.leaderPublicKey,
  };
}

async function probePeerPresence(url: string): Promise<{ online: boolean; hasMail: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const r = await fetch(`${url}/api/country/presence`, { signal: controller.signal });
    if (!r.ok) return { online: false, hasMail: false };
    const body = (await r.json()) as { online?: boolean; hasMail?: boolean };
    return {
      online: body.online === true,
      hasMail: body.hasMail === true,
    };
  } catch {
    return { online: false, hasMail: false };
  } finally {
    clearTimeout(timer);
  }
}

function ensureCountryDefaults(warren: Warren): void {
  const c = normalizeCountryConfig(warren.manifest.country);
  if (c.countryId && c.countryName && c.countryCode && c.leaderPublicKey) return;
  const identity = readCountryIdentity(warren.root);
  const existing = new Set<string>();
  if (c.countryName) existing.add(c.countryName);
  warren.manifest.country = normalizeCountryConfig({
    ...c,
    countryId: c.countryId ?? randomUUID().slice(0, 12),
    countryName: c.countryName ?? makeCountryName(existing),
    countryCode: c.countryCode ?? makeCountryCode(),
    leaderPublicKey: c.leaderPublicKey ?? (identity?.publicKeyPem ?? ""),
    discoverable: c.discoverable !== false,
  });
}

function normalizeIncomingJoinRequest(
  body: Record<string, unknown>,
): CountryJoinRequest | null {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const countryId = normalizeCountryId(body.countryId);
  const countryCode = normalizeCountryCode(body.countryCode);
  const fromName = typeof body.fromName === "string" ? body.fromName.trim() : "";
  const fromUrl = typeof body.fromUrl === "string" ? body.fromUrl.trim() : "";
  const fromPublicKey =
    typeof body.fromPublicKey === "string" ? body.fromPublicKey.trim() : "";
  const createdAt = typeof body.createdAt === "string" ? body.createdAt : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  if (
    !id || !countryId || !countryCode || !fromName || !fromUrl || !fromPublicKey || !createdAt ||
    !signature
  ) return null;
  return {
    id,
    countryId,
    countryCode,
    fromName,
    fromUrl,
    fromPublicKey,
    createdAt,
    signature,
  };
}

function joinRequestMessage(req: CountryJoinRequest): string {
  return JSON.stringify({
    id: req.id,
    countryId: req.countryId,
    countryCode: req.countryCode,
    fromName: req.fromName,
    fromUrl: req.fromUrl,
    fromPublicKey: req.fromPublicKey,
    createdAt: req.createdAt,
  });
}

function joinApprovalMessage(data: {
  countryId: string;
  countryName: string;
  countryCode: string;
  peerName: string;
  peerUrl: string;
}): string {
  return JSON.stringify(data);
}

async function notifyJoinApproved(warren: Warren, reqRow: CountryJoinRequest): Promise<void> {
  const identity = await ensureCountryIdentity(warren.root);
  const c = normalizeCountryConfig(warren.manifest.country);
  const countryId = c.countryId ?? "";
  const countryName = c.countryName ?? "";
  const countryCode = c.countryCode ?? "";
  const msg = joinApprovalMessage({
    countryId,
    countryName,
    countryCode,
    peerName: warren.manifest.name,
    peerUrl: process.env.GOBLINTOWN_PUBLIC_URL ?? "",
  });
  const signature = signCountryPayload(identity.privateKeyPem, msg);
  const resp = await fetch(`${reqRow.fromUrl}/api/country/join-approved`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      countryId,
      countryName,
      countryCode,
      name: warren.manifest.name,
      url: process.env.GOBLINTOWN_PUBLIC_URL ?? "",
      leaderPublicKey: identity.publicKeyPem,
      signature,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`join approval callback failed: ${resp.status} ${resp.statusText} ${text}`);
  }
}

async function discoverCountries(warren: Warren): Promise<
  Array<{
    source: string;
    countryId: string;
    countryName: string;
    countryCode: string;
    memberCount: number;
    discoverable: boolean;
    leadName: string;
    leadUrl?: string;
    targetUrl?: string;
    leaderPublicKey?: string;
  }>
> {
  const seen = new Set<string>();
  const out: Array<{
    source: string;
    countryId: string;
    countryName: string;
    countryCode: string;
    memberCount: number;
    discoverable: boolean;
    leadName: string;
    leadUrl?: string;
    targetUrl?: string;
    leaderPublicKey?: string;
  }> = [];
  const own = await countryPublicPayload(warren);
  out.push({ source: "self", ...own, targetUrl: own.leadUrl });
  if (own.countryId) seen.add(own.countryId);
  const peers = warren.manifest.peers ?? [];
  const pulls = await Promise.all(
    peers.map(async (p) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2200);
        const r = await fetch(`${p.url}/api/country/public`, { signal: controller.signal });
        clearTimeout(timer);
        if (!r.ok) return null;
        const data = (await r.json()) as {
          countryId: string;
          countryName: string;
          countryCode: string;
          memberCount: number;
          discoverable: boolean;
          leadName: string;
          leadUrl?: string;
          targetUrl?: string;
          leaderPublicKey?: string;
        };
        return {
          source: p.name,
          ...data,
          targetUrl: data.leadUrl || p.url,
        };
      } catch {
        return null;
      }
    }),
  );
  for (const item of pulls) {
    if (!item) continue;
    if (!item.countryId || seen.has(item.countryId)) continue;
    seen.add(item.countryId);
    out.push(item);
  }
  return out;
}

function filterDiscoverableCountries(
  warren: Warren,
  list: Array<{
    source: string;
    countryId: string;
    countryName: string;
    countryCode: string;
    memberCount: number;
    discoverable: boolean;
    leadName: string;
    leadUrl?: string;
    targetUrl?: string;
    leaderPublicKey?: string;
  }>,
  qCode?: string,
): Array<{
  source: string;
  countryId: string;
  countryName: string;
  countryCode: string;
  memberCount: number;
  discoverable: boolean;
  leadName: string;
  leadUrl?: string;
  targetUrl?: string;
  leaderPublicKey?: string;
}> {
  const ownCountryId = normalizeCountryConfig(warren.manifest.country).countryId ?? "";
  const ownUrl = (process.env.GOBLINTOWN_PUBLIC_URL ?? "").replace(/\/+$/, "");
  return list.filter((c) => {
    if (!c.discoverable) return false;
    if (!c.targetUrl) return false;
    if (c.source === "self") return false;
    if (ownCountryId && c.countryId === ownCountryId) return false;
    if (ownUrl && c.targetUrl.replace(/\/+$/, "") === ownUrl) return false;
    if (qCode && c.countryCode !== qCode) return false;
    return true;
  });
}

function filterOpenCountries(
  list: Array<{
    source: string;
    countryId: string;
    countryName: string;
    countryCode: string;
    memberCount: number;
    discoverable: boolean;
    leadName: string;
    leadUrl?: string;
    targetUrl?: string;
    leaderPublicKey?: string;
  }>,
): Array<{
  source: string;
  countryId: string;
  countryName: string;
  countryCode: string;
  memberCount: number;
  discoverable: boolean;
  leadName: string;
  leadUrl?: string;
  targetUrl?: string;
  leaderPublicKey?: string;
}> {
  return list.filter((row) => Number.isFinite(row.memberCount) && row.memberCount <= DISCOVERY_OPEN_MEMBER_LIMIT);
}

async function sendJoinRequestToCountryLeader(
  warren: Warren,
  targetUrl: string,
  countryId: string,
  countryCode: string,
): Promise<CountryJoinRequest> {
  const identity = await ensureCountryIdentity(warren.root);
  const fromUrl = process.env.GOBLINTOWN_PUBLIC_URL;
  if (!fromUrl) {
    throw new Error("Set GOBLINTOWN_PUBLIC_URL before sending join requests.");
  }
  const request: CountryJoinRequest = {
    id: randomUUID().slice(0, 12),
    countryId,
    countryCode,
    fromName: warren.manifest.name,
    fromUrl,
    fromPublicKey: identity.publicKeyPem,
    createdAt: new Date().toISOString(),
    signature: "",
  };
  request.signature = signCountryPayload(identity.privateKeyPem, joinRequestMessage(request));
  const r = await fetch(`${targetUrl.replace(/\/+$/, "")}/api/country/join-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`join request failed: ${r.status} ${r.statusText} ${text}`);
  }
  return request;
}

async function checkCountryExecutionReadiness(
  warren: Warren,
  mode: "rite" | "plan",
  task: string,
): Promise<{ error: string; queued: boolean; queueId: string; offline: string[] } | null> {
  const c = normalizeCountryConfig(warren.manifest.country);
  if (c.enabled !== true) return null;
  const peers = warren.manifest.peers ?? [];
  if (peers.length === 0) return null;
  const checks = await Promise.all(
    peers.map(async (p) => ({
      name: p.name,
      ...(await probePeerPresence(p.url)),
    })),
  );
  const offline = checks.filter((c2) => !c2.online).map((c2) => c2.name);
  if (offline.length === 0) return null;
  const queue: CountryQueuedRite[] = c.riteQueue ?? [];
  const queueId = randomUUID().slice(0, 12);
  queue.push({
    id: queueId,
    mode,
    task: task.trim().slice(0, 240),
    createdAt: Date.now(),
  });
  warren.manifest.country = normalizeCountryConfig({
    ...c,
    riteQueue: queue.slice(-64),
  });
  return {
    error: `country mode requires all teammates online (${offline.join(", ")})`,
    queued: true,
    queueId,
    offline,
  };
}

function parseCliLine(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    out.push(raw.replace(/\\(["'`\\])/g, "$1"));
  }
  return out;
}

async function runCliLine(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string; command: string }> {
  const cliPath = join(cwd, "dist", "cli.js");
  const command = ["node", cliPath, ...args].join(" ");
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 500_000) stdout = stdout.slice(-500_000);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, 8 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      const exitCode = typeof code === "number" ? code : 1;
      resolve({
        ok: exitCode === 0,
        code: exitCode,
        stdout,
        stderr,
        command,
      });
    });
  });
}


async function renderHome(
  warren: Warren,
  _runs: Map<string, RunState>,
  res: Response,
): Promise<void> {
  const [rites, loot] = await Promise.all([
    warren.hoard.allRites(),
    warren.hoard.allLoot(),
  ]);
  const driftSum = loot.reduce((s, l) => s + l.drift.driftRate, 0);
  const drift = loot.length ? driftSum / loot.length : 0;
  res.send(tankHtml(warren.manifest.name, loot.length, rites.length, drift));
}

async function renderRite(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const rite = await warren.hoard.getRite(req.params.id);
  if (!rite) {
    res.status(404).send(layout("Not Found", "<h1>Rite not found</h1>"));
    return;
  }
  const allLootIds = new Set<string>();
  if (rite.contextLootId) allLootIds.add(rite.contextLootId);
  for (const id of rite.goblinLootIds) allLootIds.add(id);
  for (const id of Object.values(rite.chaosLootIds)) allLootIds.add(id);
  if (rite.ogreLootId) allLootIds.add(rite.ogreLootId);

  const loots = await Promise.all(
    [...allLootIds].map((id) => warren.hoard.getLoot(id)),
  );
  const lootById = new Map(loots.filter((l) => l).map((l) => [l!.id, l!]));

  const goblinRows = rite.goblinLootIds
    .map((gid) => {
      const g = lootById.get(gid);
      const v = rite.trollVerdicts[gid];
      const chaosId = rite.chaosLootIds[gid];
      const tag = gid === rite.winnerLootId ? `<span class="tag tag-winner">winner</span>` : "";
      return `<tr>
        <td><a href="/loot/${esc(gid)}">${esc(gid)}</a> ${tag}</td>
        <td>${chaosId ? `<a href="/loot/${esc(chaosId)}">${esc(chaosId)}</a>` : "—"}</td>
        <td>${v ? v.score.toFixed(2) : "—"}</td>
        <td>${v ? (v.passed ? `<span class="tag tag-pass">PASS</span>` : `<span class="tag tag-fail">FAIL</span>`) : "—"}</td>
        <td>${g ? (g.reward ?? 0).toFixed(3) : "—"}</td>
        <td>${g ? g.drift.driftRate.toFixed(4) : "—"}</td>
        <td class="critique">${esc(truncate(v?.critique ?? "", 200))}</td>
      </tr>`;
    })
    .join("");

  const ogre = rite.ogreLootId ? lootById.get(rite.ogreLootId) : null;

  const body = `
    <p><a href="/">← Hoard</a></p>
    <h1>Rite ${esc(rite.id)}</h1>
    <p class="muted">${esc(new Date(rite.startedAt).toISOString())} · pack=${rite.packSize} · personality=${esc(rite.personality)} · outcome=<span class="tag tag-${esc(rite.outcome)}">${esc(rite.outcome)}</span></p>
    <h2>Task</h2>
    <pre>${esc(rite.task)}</pre>

    ${
      rite.contextLootId
        ? `<h2>Raccoon scavenge</h2>
           <p><a href="/loot/${esc(rite.contextLootId)}">${esc(rite.contextLootId)}</a> · ${rite.scanGlobs.length} glob(s): ${rite.scanGlobs.map((g) => `<code>${esc(g)}</code>`).join(", ")}</p>`
        : ""
    }

    <h2>Pack & arbitration</h2>
    <table>
      <tr><th>Goblin</th><th>Gremlin</th><th>Troll</th><th></th><th>Shinies</th><th>Drift</th><th>Critique</th></tr>
      ${goblinRows}
    </table>

    ${
      ogre
        ? `<h2>Ogre fallback</h2>
           <p><a href="/loot/${esc(ogre.id)}">${esc(ogre.id)}</a> — synthesized from ${ogre.parentLootIds?.length ?? 0} failed attempts.</p>
           <pre>${esc(ogre.output)}</pre>`
        : ""
    }
  `;
  res.send(layout(`Rite ${rite.id}`, body));
}

async function renderQuest(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const quests = await warren.hoard.allQuests();
  const quest = quests.find((q) => q.id === req.params.id);
  if (!quest) {
    res.status(404).send(layout("Not Found", "<h1>Quest not found</h1>"));
    return;
  }
  const loots = await Promise.all(
    quest.lootIds.map((id) => warren.hoard.getLoot(id)),
  );

  const rows = loots
    .map((l) => {
      if (!l) return "";
      const v = quest.trollVerdicts[l.id];
      const tag = l.id === quest.winnerLootId ? `<span class="tag tag-winner">winner</span>` : "";
      return `<tr>
        <td><a href="/loot/${esc(l.id)}">${esc(l.id)}</a> ${tag}</td>
        <td>${v ? v.score.toFixed(2) : "—"}</td>
        <td>${v ? (v.passed ? `<span class="tag tag-pass">PASS</span>` : `<span class="tag tag-fail">FAIL</span>`) : "—"}</td>
        <td>${(l.reward ?? 0).toFixed(3)}</td>
        <td>${l.drift.driftRate.toFixed(4)}</td>
        <td class="critique">${esc(truncate(v?.critique ?? "", 200))}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <p><a href="/">← Hoard</a></p>
    <h1>Quest ${esc(quest.id)}</h1>
    <p class="muted">${esc(new Date(quest.startedAt).toISOString())} · pack=${quest.packSize} · personality=${esc(quest.personality)}</p>
    <h2>Task</h2>
    <pre>${esc(quest.task)}</pre>
    <h2>Pack</h2>
    <table>
      <tr><th>Loot</th><th>Troll</th><th></th><th>Shinies</th><th>Drift</th><th>Critique</th></tr>
      ${rows}
    </table>
  `;
  res.send(layout(`Quest ${quest.id}`, body));
}

async function renderLoot(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const loot = await warren.hoard.getLoot(req.params.id);
  if (!loot) {
    res.status(404).send(layout("Not Found", "<h1>Loot not found</h1>"));
    return;
  }
  const parents = loot.parentLootIds ?? [];
  const driftRows = CREATURE_KINDS.map(
    (k) => `<tr><td>${k}</td><td>${loot.drift.creatureMentions[k]}</td></tr>`,
  ).join("");

  const usageBlock = loot.usage
    ? ` · tokens p=${loot.usage.promptTokens}/c=${loot.usage.completionTokens}/t=${loot.usage.totalTokens}`
    : "";
  const body = `
    <p><a href="/">← Hoard</a></p>
    <h1>Loot ${esc(loot.id)}</h1>
    <p class="muted">
      ${esc(loot.creatureKind)} · ${esc(loot.personality)} · ${esc(loot.model)} · ${esc(new Date(loot.timestamp).toISOString())}
      ${loot.reward !== undefined ? ` · shinies=${loot.reward.toFixed(3)}` : ""}${usageBlock}
    </p>

    ${
      parents.length > 0
        ? `<p>Parents: ${parents.map((p) => `<a href="/loot/${esc(p)}">${esc(p)}</a>`).join(", ")}</p>`
        : ""
    }
    ${loot.questId ? `<p>Quest: <a href="/quest/${esc(loot.questId)}">${esc(loot.questId)}</a></p>` : ""}
    ${loot.riteId ? `<p>Rite: <a href="/rite/${esc(loot.riteId)}">${esc(loot.riteId)}</a></p>` : ""}

    <h2>Output</h2>
    <pre>${esc(loot.output)}</pre>

    <h2>Prompt</h2>
    <pre>${esc(loot.prompt)}</pre>

    <h2>Drift</h2>
    <p>Cross-creature words: ${loot.drift.totalCreatureWords} / ${loot.drift.outputWordCount} words · rate=${loot.drift.driftRate.toFixed(4)}</p>
    <table><tr><th>Creature</th><th>Mentions</th></tr>${driftRows}</table>
  `;
  res.send(layout(`Loot ${loot.id}`, body));
}

async function renderDrift(warren: Warren, res: Response): Promise<void> {
  const all = await warren.hoard.allLoot();
  const byKind = new Map<CreatureKind, number[]>();
  for (const k of CREATURE_KINDS) byKind.set(k, []);
  for (const l of all) byKind.get(l.creatureKind)?.push(l.drift.driftRate);

  const rows = CREATURE_KINDS.map((k) => {
    const rates = byKind.get(k) ?? [];
    const avg = rates.length
      ? rates.reduce((a, b) => a + b, 0) / rates.length
      : 0;
    return `<tr><td>${k}</td><td>${rates.length}</td><td>${avg.toFixed(4)}</td></tr>`;
  }).join("");

  const body = `
    <p><a href="/">← Hoard</a></p>
    <h1>Drift report</h1>
    <p class="muted">Cross-creature mentions / total words. High = reward signal is leaking.</p>
    <table>
      <tr><th>Creature</th><th>n</th><th>avg drift rate</th></tr>
      ${rows}
    </table>
    <p class="muted">${all.length} total loot drops scanned.</p>
  `;
  res.send(layout("Drift", body));
}

async function renderInbox(warren: Warren, res: Response): Promise<void> {
  const msgs = (await warren.hoard.allInbox()).sort(
    (a, b) => b.receivedAt - a.receivedAt,
  );
  const rows = msgs
    .map(
      (m) => `<tr>
        <td>${esc(m.id)}</td>
        <td>${esc(m.fromWarren)}</td>
        <td>${esc(m.audience)}</td>
        <td><code>${esc(m.signature)}</code></td>
        <td><pre>${esc(truncate(m.body, 400))}</pre></td>
      </tr>`,
    )
    .join("");
  const body = `
    <p><a href="/">← Hoard</a></p>
    <h1>Inbox (${msgs.length})</h1>
    <table>
      <tr><th>id</th><th>from</th><th>audience</th><th>signature</th><th>body</th></tr>
      ${rows || `<tr><td colspan="5" class="muted">empty</td></tr>`}
    </table>
  `;
  res.send(layout("Inbox", body));
}

async function renderOutbox(warren: Warren, res: Response): Promise<void> {
  const recs = (await warren.hoard.allOutbox()).sort(
    (a, b) => b.sentAt - a.sentAt,
  );
  const rows = recs
    .map(
      (r) => `<tr>
        <td>${esc(r.id)}</td>
        <td>${esc(r.toWarren)}</td>
        <td>${esc(r.audience)}</td>
        <td><a href="/loot/${esc(r.sourceLootId)}">${esc(r.sourceLootId)}</a></td>
        <td><a href="/loot/${esc(r.pigeonLootId)}">${esc(r.pigeonLootId)}</a></td>
        <td><code>${esc(r.signature)}</code></td>
      </tr>`,
    )
    .join("");
  const body = `
    <p><a href="/">← Hoard</a></p>
    <h1>Outbox (${recs.length})</h1>
    <table>
      <tr><th>id</th><th>to</th><th>audience</th><th>source loot</th><th>pigeon loot</th><th>signature</th></tr>
      ${rows || `<tr><td colspan="6" class="muted">empty</td></tr>`}
    </table>
  `;
  res.send(layout("Outbox", body));
}

function creatureCounts(
  loot: { creatureKind: CreatureKind }[],
): Record<CreatureKind, number> {
  const counts: Record<CreatureKind, number> = {
    goblin: 0,
    gremlin: 0,
    raccoon: 0,
    troll: 0,
    ogre: 0,
    pigeon: 0,
  };
  for (const l of loot) counts[l.creatureKind]++;
  return counts;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(title)} · Goblintown</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, Menlo, Consolas, monospace; background: #0d1410; color: #b9d3a8; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
  h1, h2, h3 { color: #d8efb6; font-weight: 600; }
  h1 { border-bottom: 1px solid #2a3d22; padding-bottom: .5rem; }
  a { color: #8fcf52; }
  a:hover { color: #c2f37a; }
  pre { background: #0a0e08; padding: .8rem; border-left: 3px solid #2a3d22; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  code { background: #0a0e08; padding: 1px 4px; border-radius: 2px; }
  table { border-collapse: collapse; margin: .5rem 0 1.5rem; width: 100%; }
  th, td { border: 1px solid #1f2d18; padding: .35rem .6rem; text-align: left; vertical-align: top; }
  th { background: #14201a; }
  .muted { color: #5a7042; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .tag-pass { background: #1f3a14; color: #b6f37a; }
  .tag-fail { background: #3a1414; color: #f3a07a; }
  .tag-winner { background: #5a4a14; color: #f3df7a; }
  .tag-winner, .tag-ogre_fallback, .tag-all_failed { padding-left: 6px; padding-right: 6px; }
  .tag-ogre_fallback { background: #3a2914; color: #f3c07a; }
  .tag-all_failed { background: #3a1414; color: #f3a07a; }
  .critique { color: #98b878; font-style: italic; max-width: 30ch; }
  section { margin: 1.5rem 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function newRiteForm(): string {
  return `
    <p><a href="/">← Hoard</a></p>
    <h1>New rite</h1>
    <form id="rite-form">
      <p><label>Task<br><textarea name="task" rows="4" cols="80" placeholder="What should the goblins solve?" required></textarea></label></p>
      <p><label>Pack size <input name="packSize" type="number" value="3" min="1" max="9"></label>
         &nbsp;<label>Personality
           <select name="personality">
             <option value="nerdy">nerdy</option>
             <option value="cynical">cynical</option>
             <option value="chipper">chipper</option>
             <option value="stoic">stoic</option>
             <option value="feral">feral</option>
           </select>
         </label>
         &nbsp;<label><input type="checkbox" name="noFallback"> skip Ogre fallback</label>
      </p>
      <p><label>Scan globs (one per line — optional)<br><textarea name="scanGlobs" rows="3" cols="60" placeholder="src/**/*.ts"></textarea></label></p>
      <p><button type="submit">Begin rite</button></p>
    </form>
    <h2>Stream</h2>
    <pre id="log" style="min-height: 12em;">(idle)</pre>
    <p id="winner-link"></p>
    <script>
      const form = document.getElementById("rite-form");
      const log = document.getElementById("log");
      const winnerLink = document.getElementById("winner-link");
      function append(s) { log.textContent = (log.textContent === "(idle)" ? "" : log.textContent) + s + "\\n"; log.scrollTop = log.scrollHeight; }
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        log.textContent = "";
        winnerLink.innerHTML = "";
        const fd = new FormData(form);
        const scanGlobs = (fd.get("scanGlobs") || "").toString().split(/\\r?\\n/).map(s => s.trim()).filter(Boolean);
        const payload = {
          task: fd.get("task"),
          packSize: Number(fd.get("packSize") || 3),
          personality: fd.get("personality"),
          noFallback: !!fd.get("noFallback"),
          scanGlobs,
        };
        append("POST /api/rite ...");
        const startRes = await fetch("/api/rite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!startRes.ok) { append("error: " + (await startRes.text())); return; }
        const { runId } = await startRes.json();
        append("runId=" + runId + " — opening SSE stream");
        const es = new EventSource("/api/rite/" + runId + "/stream");
        es.addEventListener("step", (ev) => append("• " + JSON.stringify(JSON.parse(ev.data))));
        es.addEventListener("reward-plugin", (ev) => append("(reward plugin: " + JSON.parse(ev.data).source + ")"));
        es.addEventListener("done", (ev) => {
          const d = JSON.parse(ev.data);
          append("✔ done — outcome=" + d.outcome + " riteId=" + d.riteId);
          winnerLink.innerHTML = '<a href="/rite/' + d.riteId + '">→ view rite ' + d.riteId + '</a>';
          es.close();
        });
        es.addEventListener("error", (ev) => {
          let msg = "(connection error)";
          try { msg = JSON.parse(ev.data).message; } catch {}
          append("✖ error: " + msg);
          es.close();
        });
      });
    </script>
  `;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function tankHtml(
  warrenName: string,
  lootCount: number,
  riteCount: number,
  drift: number,
): string {
  const initial = JSON.stringify({
    warren: warrenName,
    loot: lootCount,
    rites: riteCount,
    drift,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Goblintown · ${esc(warrenName)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><text y='52' font-size='52'>%F0%9F%91%B9</text></svg>" />
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1410;
    --bg-deep: #0a0e08;
    --fg: #b9d3a8;
    --fg-bright: #d8efb6;
    --accent: #8fcf52;
    --accent-hot: #c2f37a;
    --muted: #5a7042;
    --muted-deep: #2e3e22;
    --muted-deeper: #1c2614;
    --line: #1f2d18;
    --line-soft: #14201a;
    --pass: #b6f37a;
    --fail: #f3a07a;
    --warn: #f3df7a;
    --bubble-bg: #14201a;
    --bubble-border: #2e4220;
    --sky: #131c14;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--fg);
    font: 14px/1.45 ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
    background-image:
      radial-gradient(circle at 20% 0%, rgba(143,207,82,0.05), transparent 40%),
      radial-gradient(circle at 80% 30%, rgba(143,207,82,0.03), transparent 50%);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 100vh; padding: 0.45rem;
  }
  .warren {
    width: min(1560px, 99.2vw);
    height: min(900px, 97.5vh);
    background: var(--bg-deep);
    border: 2px solid var(--line);
    border-radius: 8px;
    box-shadow: inset 0 0 80px rgba(0,0,0,0.65), 0 0 0 4px var(--bg), 0 0 0 5px var(--line);
    display: grid; grid-template-rows: auto 1fr auto auto; overflow: hidden;
    position: relative;
  }
  .strip {
    border-bottom: 1px solid var(--line); padding: 0.55rem 1rem;
    display: flex; gap: 1.4rem; align-items: center;
    color: var(--muted); font-size: 0.78rem; letter-spacing: 0.06em; text-transform: uppercase;
  }
  .strip .name { color: var(--fg-bright); font-weight: 600; }
  .strip .stat { color: var(--fg); }
  .strip .stat b { color: var(--accent); font-weight: 600; }
  .strip .grow { flex: 1; }
  .strip .clock { color: var(--muted); }
  .strip .tier { color: var(--warn); }
  .provider-chip {
    border: 1px solid var(--line);
    background: var(--bg-deep);
    color: var(--fg-bright);
    border-radius: 999px;
    padding: 0.32rem 0.65rem;
    font: inherit;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .provider-chip[data-missing="true"] { border-color: var(--fail); color: var(--fail); }
  .provider-chip:hover { border-color: var(--accent); color: var(--accent-hot); }
  .provider-popover {
    position: absolute;
    right: 1rem;
    top: 2.7rem;
    width: min(420px, calc(100% - 2rem));
    z-index: 30;
    background: rgba(10,14,8,0.98);
    border: 1px solid var(--accent);
    border-radius: 8px;
    box-shadow: 0 16px 50px rgba(0,0,0,0.75);
    padding: 1rem;
    display: none;
  }
  .provider-popover.open { display: block; }
  .provider-popover h3 {
    margin: 0 0 0.8rem;
    color: var(--fg-bright);
    font-size: 0.88rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .provider-popover label {
    display: block;
    color: var(--muted);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: 0.55rem 0 0.18rem;
  }
  .provider-popover input, .provider-popover select {
    width: 100%;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.45rem 0.55rem;
    font: inherit;
    font-size: 0.78rem;
  }
  .provider-popover input:focus, .provider-popover select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .provider-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.55rem; }
  .provider-status {
    margin: 0.65rem 0 0;
    color: var(--muted);
    font-size: 0.72rem;
    line-height: 1.4;
  }
  .provider-status strong { color: var(--fg-bright); }
  .provider-advanced summary {
    cursor: pointer;
    color: var(--accent);
    margin-top: 0.8rem;
    font-size: 0.74rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .provider-actions { display: flex; gap: 0.6rem; margin-top: 0.9rem; }
  .country-chip {
    border: 1px solid var(--line);
    background: var(--bg-deep);
    color: var(--fg);
    padding: 0.18rem 0.55rem;
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .country-chip:hover { border-color: var(--accent); color: var(--accent-hot); }
  .auth-chip {
    border: 1px solid var(--line);
    background: var(--bg-deep);
    color: var(--fg);
    padding: 0.18rem 0.55rem;
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .auth-chip:hover { border-color: var(--accent); color: var(--accent-hot); }
  .mail-chip {
    border: 1px solid var(--line);
    background: var(--bg-deep);
    color: var(--fg);
    padding: 0.18rem 0.55rem;
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .mail-chip[data-unread="true"] {
    border-color: var(--warn);
    color: var(--warn);
  }
  .mail-chip:hover { border-color: var(--accent); color: var(--accent-hot); }
  .auth-popover {
    position: absolute;
    right: 14.8rem;
    top: 2.1rem;
    z-index: 30;
    width: min(420px, calc(100vw - 2rem));
    background: rgba(8, 11, 7, 0.98);
    border: 1px solid var(--accent);
    box-shadow: 0 12px 42px rgba(0,0,0,0.6);
    padding: 0.9rem 1rem;
    display: none;
  }
  .auth-popover.open { display: block; }
  .auth-popover h3 {
    margin: 0 0 0.55rem;
    font-size: 0.76rem;
    color: var(--fg-bright);
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }
  .auth-status {
    color: var(--muted);
    font-size: 0.74rem;
    margin: 0 0 0.7rem;
    line-height: 1.45;
  }
  .country-popover {
    position: absolute;
    right: 10.4rem;
    top: 2.1rem;
    z-index: 30;
    width: min(860px, calc(100vw - 2rem));
    max-height: calc(100vh - 4rem);
    overflow: auto;
    background: rgba(8, 11, 7, 0.98);
    border: 1px solid var(--accent);
    box-shadow: 0 12px 42px rgba(0,0,0,0.6);
    padding: 0.9rem 1rem;
    display: none;
  }
  .country-popover.open { display: block; }
  .country-popover h3 {
    margin: 0 0 0.55rem;
    font-size: 0.76rem;
    color: var(--fg-bright);
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }
  .country-subtle { color: var(--muted); font-size: 0.74rem; margin: 0 0 0.65rem; }
  .country-mode-row {
    display: flex;
    gap: 1rem;
    align-items: center;
    margin-bottom: 0.65rem;
    font-size: 0.74rem;
  }
  .country-mode-row label {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--fg);
  }
  .country-mode-row select {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    padding: 0.2rem 0.35rem;
    font: inherit;
    font-size: 0.72rem;
  }
  .country-mode-row input[type="checkbox"] {
    accent-color: #b6f37a;
    transform: scale(0.95);
  }
  .country-tabs {
    display: flex;
    gap: 0.45rem;
    margin-bottom: 0.65rem;
  }
  .country-tab {
    border: 1px solid var(--line);
    background: rgba(6,10,6,0.72);
    color: var(--muted);
    padding: 0.35rem 0.62rem;
    font: inherit;
    font-size: 0.68rem;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .country-tab:hover { border-color: var(--accent); color: var(--accent-hot); }
  .country-tab.active {
    border-color: var(--accent);
    background: rgba(143,207,82,0.16);
    color: var(--fg-bright);
  }
  .country-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.85rem;
  }
  .country-panel { display: none; }
  .country-panel.active { display: block; }
  .country-pane {
    border: 1px solid var(--line);
    background: rgba(12,16,10,0.75);
    padding: 0.65rem;
  }
  .country-pane h4 {
    margin: 0 0 0.55rem;
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-bright);
  }
  .country-row {
    display: flex;
    gap: 0.45rem;
    margin-bottom: 0.42rem;
  }
  .country-row input {
    background: var(--bg);
    border: 1px solid var(--line);
    color: var(--fg);
    padding: 0.38rem 0.45rem;
    font-family: inherit;
    font-size: 0.76rem;
  }
  .country-row input:focus { outline: none; border-color: var(--accent); }
  .country-row input[name="country-search-code"] { flex: 1; min-width: 0; }
  .country-row #country-search-btn { white-space: nowrap; }
  .country-list {
    max-height: 180px;
    overflow: auto;
    border: 1px solid var(--line);
    background: rgba(6,9,5,0.7);
  }
  .country-member {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.45rem;
    align-items: center;
    padding: 0.35rem 0.45rem;
    border-bottom: 1px solid rgba(43,60,35,0.55);
    font-size: 0.74rem;
  }
  .country-member:last-child { border-bottom: 0; }
  .country-member .lead { color: var(--accent); font-size: 0.64rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .country-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 0.35rem;
    vertical-align: middle;
    background: #57625b;
  }
  .country-dot.online { background: #9dff8f; }
  .country-dot.mail { background: #ffd163; box-shadow: 0 0 0 2px rgba(255,209,99,0.25); }
  .country-role-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 0.72rem;
  }
  .country-role-table th,
  .country-role-table td {
    border: 1px solid rgba(43,60,35,0.7);
    padding: 0.35rem 0.3rem;
    text-align: center;
    vertical-align: middle;
  }
  .country-role-table th:first-child,
  .country-role-table td:first-child {
    text-align: left;
    width: 6.3rem;
    color: var(--fg-bright);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .country-role-table th.member-lead {
    color: var(--accent-hot);
  }
  .country-role-table input[type="checkbox"] {
    transform: scale(0.95);
    accent-color: #b6f37a;
  }
  .country-actions { display: flex; gap: 0.6rem; margin-top: 0.75rem; align-items: center; }
  .country-status { color: var(--muted); font-size: 0.72rem; min-height: 1.05rem; }
  .country-popover .check {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.74rem;
    color: var(--fg);
  }
  .mail-popover {
    position: absolute;
    right: 5.8rem;
    top: 2.1rem;
    z-index: 30;
    width: min(860px, calc(100vw - 2rem));
    max-height: calc(100vh - 4rem);
    overflow: auto;
    background: rgba(8, 11, 7, 0.98);
    border: 1px solid var(--accent);
    box-shadow: 0 12px 42px rgba(0,0,0,0.6);
    padding: 0.9rem 1rem;
    display: none;
  }
  .mail-popover.open { display: block; }
  .mail-popover h3 {
    margin: 0 0 0.55rem;
    font-size: 0.76rem;
    color: var(--fg-bright);
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }
  .mail-subtle { color: var(--muted); font-size: 0.74rem; margin: 0 0 0.65rem; }
  .mail-grid {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 0.85rem;
  }
  .mail-pane {
    border: 1px solid var(--line);
    background: rgba(12,16,10,0.75);
    padding: 0.65rem;
  }
  .mail-pane h4 {
    margin: 0 0 0.55rem;
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-bright);
  }
  .mail-row {
    display: flex;
    gap: 0.45rem;
    margin-bottom: 0.42rem;
  }
  .mail-row input, .mail-row textarea {
    background: var(--bg);
    border: 1px solid var(--line);
    color: var(--fg);
    padding: 0.38rem 0.45rem;
    font-family: inherit;
    font-size: 0.76rem;
  }
  .mail-row input { flex: 1; min-width: 0; }
  .mail-row textarea { width: 100%; min-height: 78px; resize: vertical; }
  .mail-row input:focus, .mail-row textarea:focus { outline: none; border-color: var(--accent); }
  .mail-list {
    max-height: 200px;
    overflow: auto;
    border: 1px solid var(--line);
    background: rgba(6,9,5,0.7);
  }
  .mail-item {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.45rem;
    align-items: center;
    padding: 0.35rem 0.45rem;
    border-bottom: 1px solid rgba(43,60,35,0.55);
    font-size: 0.74rem;
  }
  .mail-item:last-child { border-bottom: 0; }
  .mail-item.active {
    background: rgba(146, 243, 122, 0.08);
    border-left: 2px solid rgba(146, 243, 122, 0.6);
  }
  .mail-item .meta { color: var(--muted); font-size: 0.68rem; }
  .mail-msg {
    border-bottom: 1px dashed rgba(43,60,35,0.65);
    padding: 0.35rem 0;
    margin-bottom: 0.3rem;
  }
  .mail-msg:last-child { border-bottom: 0; margin-bottom: 0; }
  .mail-msg .head { color: var(--muted); font-size: 0.68rem; margin-bottom: 0.2rem; }
  .mail-msg .body { white-space: pre-wrap; word-break: break-word; color: var(--fg); font-size: 0.74rem; }
  .mail-actions { display: flex; gap: 0.6rem; margin-top: 0.75rem; align-items: center; }
  .mail-status { color: var(--muted); font-size: 0.72rem; min-height: 1.05rem; }

  .workarea {
    display: grid;
    grid-template-columns: 290px 1fr;
    min-height: 0;
    border-bottom: 1px solid var(--line);
  }
  .workarea.sidebar-collapsed { grid-template-columns: 44px 1fr; }
  .ops-sidebar {
    border-right: 1px solid var(--line);
    background: rgba(8, 12, 8, 0.95);
    padding: 0.7rem;
    display: flex;
    flex-direction: column;
    min-height: 0;
    gap: 0.6rem;
    overflow: auto;
  }
  .ops-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .ops-sidebar h3 {
    margin: 0;
    font-size: 0.74rem;
    color: var(--fg-bright);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .ops-toggle {
    padding: 0.2rem 0.42rem;
    border: 1px solid var(--line);
    background: var(--bg-deep);
    color: var(--muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.7rem;
  }
  .ops-toggle:hover { border-color: var(--accent); color: var(--accent-hot); }
  .ops-main {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .ops-quick {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.3rem;
  }
  .ops-quick .btn {
    padding: 0.45rem 0.4rem;
    font-size: 0.66rem;
    letter-spacing: 0.07em;
  }
  .ops-subtle {
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.35;
  }
  .ops-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.4rem;
  }
  .ops-input, .ops-select {
    width: 100%;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.42rem 0.5rem;
    font-family: inherit;
    font-size: 0.76rem;
  }
  .ops-input:focus, .ops-select:focus { outline: none; border-color: var(--accent); }
  .ops-presets {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.3rem;
  }
  .ops-presets button {
    font-size: 0.66rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 0.35rem 0.4rem;
    border: 1px solid var(--line);
    color: var(--fg);
    background: var(--bg-deep);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ops-presets button:hover { border-color: var(--accent); color: var(--accent-hot); }
  .ops-examples summary {
    cursor: pointer;
    color: var(--accent);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 0.5rem;
  }
  .ops-examples[open] summary { margin-bottom: 0.55rem; }
  .ops-output {
    min-height: 0;
    flex: 1;
    border: 1px solid var(--line);
    background: rgba(5,8,5,0.85);
    padding: 0.5rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.72rem;
    line-height: 1.35;
    color: var(--fg);
  }
  .ops-output .err { color: var(--fail); }
  .ops-output .ok { color: var(--pass); }
  .workarea.sidebar-collapsed .ops-main { display: none; }
  .workarea.sidebar-collapsed .ops-sidebar { padding: 0.7rem 0.35rem; }
  .workarea.sidebar-collapsed .ops-head {
    flex-direction: column;
    align-items: stretch;
  }
  .workarea.sidebar-collapsed .ops-sidebar h3 {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    text-align: center;
    margin: 0 auto;
    font-size: 0.62rem;
  }
  .workarea.sidebar-collapsed .ops-toggle { width: 100%; }

  .tank {
    position: relative; overflow: hidden;
    background: linear-gradient(180deg, var(--sky) 0%, #0c1310 65%, #0a0e08 100%);
  }

  .t1, .t2, .t3, .t4 { display: none; }
  .warren[data-tier="1"] .t1 { display: block; }
  .warren[data-tier="2"] .t1, .warren[data-tier="2"] .t2 { display: block; }
  .warren[data-tier="3"] .t1, .warren[data-tier="3"] .t2, .warren[data-tier="3"] .t3 { display: block; }
  .warren[data-tier="4"] .t1, .warren[data-tier="4"] .t2,
  .warren[data-tier="4"] .t3, .warren[data-tier="4"] .t4 { display: block; }
  .warren[data-tier="2"] .t2-flex { display: flex; }
  .warren[data-tier="3"] .t2-flex,
  .warren[data-tier="3"] .t3-flex { display: flex; }
  .warren[data-tier="4"] .t2-flex,
  .warren[data-tier="4"] .t3-flex,
  .warren[data-tier="4"] .t4-flex { display: flex; }
  .t2-flex, .t3-flex, .t4-flex { display: none; }

  .star { position: absolute; color: var(--muted-deep); font-size: 0.7rem; opacity: 0.6; animation: twinkle 4s ease-in-out infinite; }
  @keyframes twinkle { 0%,100% { opacity: 0.6; } 50% { opacity: 0.2; } }

  .mountains {
    position: absolute; top: 4%; left: 0; right: 0; text-align: center;
    font-size: 3.2rem; line-height: 1; filter: brightness(0.5) saturate(0.4); letter-spacing: -0.4em;
  }
  .skyline { position: absolute; left: 0; right: 0; text-align: center; line-height: 1; letter-spacing: 0.2em; }
  .skyline.back { top: 13%; font-size: 1.7rem; filter: brightness(0.55) saturate(0.6); }
  .skyline.mid  { top: 22%; font-size: 2.5rem; filter: brightness(0.85) saturate(0.85); }

  .banner {
    position: absolute; top: 5%; left: 50%; transform: translateX(-50%);
    color: var(--warn); font-size: 0.82rem; line-height: 1.05;
    text-align: center; white-space: pre; letter-spacing: 0.05em;
    text-shadow: 0 0 6px rgba(243,223,122,0.3);
  }

  .trees { position: absolute; bottom: 18%; font-size: 2.2rem; line-height: 1; filter: brightness(0.85); }
  .trees.left { left: 2%; }
  .trees.right { right: 2%; }

  .lantern {
    position: absolute; font-size: 1.4rem; opacity: 0;
    filter: drop-shadow(0 0 8px rgba(243,223,122,0.6));
    animation: flicker 2.4s ease-in-out infinite; transition: opacity .5s;
  }
  .warren[data-tier="3"] .lantern,
  .warren[data-tier="4"] .lantern { opacity: 1; }
  @keyframes flicker { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }

  .smoke {
    position: absolute; color: var(--muted); font-size: 0.85rem;
    opacity: 0; line-height: 1; animation: smoke 4s ease-out infinite; pointer-events: none;
  }
  .warren[data-tier="2"] .smoke,
  .warren[data-tier="3"] .smoke,
  .warren[data-tier="4"] .smoke { opacity: 1; }
  @keyframes smoke {
    0%   { opacity: 0; transform: translateY(0) scale(0.9); }
    25%  { opacity: 0.6; }
    100% { opacity: 0; transform: translateY(-40px) scale(1.5); }
  }

  .ground {
    position: absolute; left: 0; right: 0; bottom: 5%; height: 4px;
    background: repeating-linear-gradient(90deg, var(--muted-deep) 0 14px, transparent 14px 22px);
  }
  .ground-shadow {
    position: absolute; left: 0; right: 0; bottom: 0; height: 5%;
    background: linear-gradient(180deg, transparent 0%, rgba(143,207,82,0.04) 100%);
  }

  .pigeon-wire { position: absolute; top: 7%; left: 4%; color: var(--muted-deep); font-size: 1.2rem; line-height: 1; white-space: pre; }
  .gremlin-perch { position: absolute; top: 12%; right: 7%; color: var(--muted-deep); font-size: 1.1rem; line-height: 1; white-space: pre; }
  .ogre-cave {
    position: absolute; top: 31%; left: 3%;
    width: 180px; height: 130px;
    border: 2px solid var(--muted-deep);
    border-radius: 90px 90px 0 0;
    background: radial-gradient(ellipse at 50% 60%, #060906 0%, #0a0e08 80%);
    box-shadow: inset 0 0 30px rgba(0,0,0,0.9);
  }
  .ogre-cave-label {
    position: absolute; top: 28%; left: 6%;
    color: var(--muted); font-size: 0.62rem; letter-spacing: 0.15em; text-transform: uppercase;
  }
  .workshop {
    position: absolute; bottom: 14%; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 0.2rem;
    color: var(--muted); font-size: 0.66rem; letter-spacing: 0.15em; text-transform: uppercase;
  }
  .workshop-fire {
    font-size: 2.2rem;
    filter: drop-shadow(0 0 12px rgba(243,160,82,0.5));
    animation: fire-flicker 0.7s ease-in-out infinite alternate;
  }
  @keyframes fire-flicker {
    from { transform: scale(1); filter: drop-shadow(0 0 12px rgba(243,160,82,0.5)); }
    to   { transform: scale(1.06); filter: drop-shadow(0 0 18px rgba(243,160,82,0.7)); }
  }
  .troll-bridge {
    position: absolute; bottom: 7%; right: 7%; width: 200px;
    color: var(--muted-deep); font-size: 0.72rem; line-height: 1.0;
    white-space: pre; text-align: center;
  }
  .raccoon-dump {
    position: absolute; bottom: 7%; left: 9%;
    font-size: 1.6rem; filter: brightness(0.7); line-height: 1;
  }

  .hoard {
    position: absolute; bottom: 22%; left: 50%; transform: translateX(-50%);
    font-size: 1.6rem; line-height: 1; opacity: 0;
    filter: drop-shadow(0 0 10px rgba(243,223,122,0.4));
    transition: opacity .5s; text-align: center; z-index: 2;
  }
  .warren[data-tier="2"] .hoard { opacity: 0.7; }
  .warren[data-tier="3"] .hoard { opacity: 0.9; }
  .warren[data-tier="4"] .hoard { opacity: 1; }

  .creature {
    position: absolute; font-size: 2.6rem; line-height: 1; z-index: 4;
    transition: filter .25s, opacity .3s; user-select: none;
  }
  .creature .emoji { display: block; line-height: 1; }
  .creature .sprite-shell { display: none; margin: 0 auto; }
  .creature.pigeon-animated { font-size: 2.2rem; }
  .creature.pigeon-animated .emoji { display: none; }
  .creature.pigeon-animated .sprite-shell { display: block; width: 92px; height: 92px; }
  .pigeon-sprite {
    width: 100%;
    height: 100%;
    display: block;
    image-rendering: auto;
  }
  .creature .label {
    display: block; margin-top: 0.15rem; text-align: center;
    color: var(--muted); font-size: 0.6rem;
    letter-spacing: 0.1em; text-transform: uppercase;
  }

  .creature[data-state="idle"] {
    animation: sway var(--sway-dur, 4s) ease-in-out infinite;
    animation-delay: var(--sway-delay, 0s);
  }
  @keyframes sway {
    0%, 100% { transform: translate(0, 0); }
    25%      { transform: translate(var(--sway-x, 2px), 0); }
    50%      { transform: translate(0, var(--sway-y, -2px)); }
    75%      { transform: translate(calc(var(--sway-x, 2px) * -1), 0); }
  }

  .creature[data-state="active"] { filter: drop-shadow(0 0 12px rgba(194,243,122,0.7)) brightness(1.2); }
  .creature[data-state="pass"]   { filter: drop-shadow(0 0 14px rgba(182,243,122,0.85)) brightness(1.25) saturate(1.2); }
  .creature[data-state="fail"]   { filter: drop-shadow(0 0 14px rgba(243,160,122,0.85)) hue-rotate(-30deg) brightness(0.95); }
  .creature[data-state="winner"] { filter: drop-shadow(0 0 18px rgba(243,223,122,0.95)) brightness(1.35) saturate(1.3); }
  .creature[data-state="cave"]   { filter: brightness(0.45) blur(0.4px); opacity: 0.7; }

  .creature.pounce-a { animation: pounce-a 0.9s ease-in-out 1; }
  .creature.pounce-b { animation: pounce-b 1.0s cubic-bezier(.4,1.4,.5,1) 1; }
  .creature.pounce-c { animation: pounce-c 0.85s ease-out 1; }
  @keyframes pounce-a {
    0%   { transform: translate(0,0) rotate(0); }
    35%  { transform: translate(var(--px, -180px), var(--py, 110px)) rotate(-8deg) scale(1.25); filter: drop-shadow(0 0 18px rgba(243,160,122,.95)); }
    65%  { transform: translate(var(--px, -180px), var(--py, 110px)) rotate(0) scale(1.05); }
    100% { transform: translate(0,0) rotate(0); }
  }
  @keyframes pounce-b {
    0%   { transform: translate(0,0) scale(1); }
    25%  { transform: translate(0, -25px) scale(1.1); }
    55%  { transform: translate(var(--px, -200px), var(--py, 90px)) scale(1.3) rotate(15deg); filter: drop-shadow(0 0 20px rgba(243,160,122,.95)); }
    80%  { transform: translate(var(--px, -200px), var(--py, 90px)) scale(1) rotate(0); }
    100% { transform: translate(0,0) scale(1); }
  }
  @keyframes pounce-c {
    0%   { transform: translate(0,0); }
    30%  { transform: translate(var(--px, -160px), var(--py, 130px)) scale(1.4) rotate(-20deg); filter: drop-shadow(0 0 22px rgba(243,160,122,1)); }
    50%  { transform: translate(var(--px, -160px), var(--py, 130px)) scale(1.05); }
    70%  { transform: translate(calc(var(--px, -160px) * 0.4), calc(var(--py, 130px) * 0.4)); }
    100% { transform: translate(0,0); }
  }

  .creature.stomp-a { animation: stomp-a 1.3s ease-out 1; }
  .creature.stomp-b { animation: stomp-b 1.5s ease-out 1; }
  @keyframes stomp-a {
    0%   { opacity: 0.45; transform: translateX(140px); filter: brightness(0.8); }
    30%  { opacity: 1; transform: translateX(50px); filter: brightness(1.1); }
    45%  { transform: translateX(0) translateY(0); }
    55%  { transform: translateX(0) translateY(-9px); }
    65%  { transform: translateX(0) translateY(0); }
    100% { transform: translateX(0); opacity: 1; filter: drop-shadow(0 0 10px rgba(194,243,122,0.6)); }
  }
  @keyframes stomp-b {
    0%   { opacity: 0.45; transform: translateX(170px) translateY(-12px); filter: brightness(0.8); }
    25%  { opacity: 1; transform: translateX(70px); }
    40%  { transform: translateX(20px) translateY(-3px); }
    50%  { transform: translateX(0) translateY(3px); }
    60%  { transform: translateX(0) translateY(-11px); }
    72%  { transform: translateX(0) translateY(2px); }
    85%  { transform: translateX(0) translateY(-3px); }
    100% { transform: translate(0,0); opacity: 1; filter: drop-shadow(0 0 10px rgba(194,243,122,0.6)); }
  }

  .creature.scurry-a { animation: scurry-a 1.6s ease-in-out 1; }
  .creature.scurry-b { animation: scurry-b 1.8s ease-in-out 1; }
  @keyframes scurry-a {
    0%   { transform: translate(0,0); }
    20%  { transform: translate(calc(var(--sx, 220px) * 0.3), calc(var(--sy, -50px) * 0.3)); }
    40%  { transform: translate(var(--sx, 220px), var(--sy, -50px)); }
    60%  { transform: translate(var(--sx, 220px), var(--sy, -50px)); }
    100% { transform: translate(0,0); }
  }
  @keyframes scurry-b {
    0%   { transform: translate(0,0); }
    15%  { transform: translate(calc(var(--sx, 220px) * 0.2), -8px); }
    30%  { transform: translate(calc(var(--sx, 220px) * 0.5), calc(var(--sy, -50px) * 0.4)); }
    50%  { transform: translate(var(--sx, 220px), var(--sy, -50px)); }
    65%  { transform: translate(var(--sx, 220px), var(--sy, -50px)); }
    100% { transform: translate(0,0); }
  }

  .creature.gavel-a { animation: gavel-a 0.8s ease-in-out 2; }
  .creature.gavel-b { animation: gavel-b 1.0s ease-in-out 2; }
  @keyframes gavel-a { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-6deg); } 75% { transform: rotate(6deg); } }
  @keyframes gavel-b {
    0%,100% { transform: rotate(0) translateY(0); }
    20% { transform: rotate(-8deg) translateY(-2px); }
    60% { transform: rotate(10deg) translateY(0); }
    80% { transform: rotate(-3deg); }
  }

  .creature.hop { animation: hop 0.55s ease-out 1; }
  @keyframes hop {
    0%   { transform: translateY(0); }
    40%  { transform: translateY(-12px); }
    70%  { transform: translateY(3px); }
    100% { transform: translateY(0); }
  }

  .pos-pigeon  { top: 4%; left: 4%; }
  .creature.pos-pigeon[data-state="idle"] { animation: none; }
  .pos-gremlin { top: 9%;  right: 8%; }
  .pos-ogre    { top: 35%; left: 7%; }
  .pos-goblins { bottom: 17%; left: 50%; transform: translateX(-50%); }
  .pos-raccoon { bottom: 8%; left: 12%; }
  .pos-troll   { bottom: 11%; right: 11%; }

  .goblin-pile { display: flex; gap: 1.2rem; align-items: flex-end; }
  .goblin-pile .creature { position: static; font-size: 2.2rem; }
  .goblin-pile .badge {
    align-self: center; margin-left: 0.4rem;
    padding: 2px 7px; border: 1px solid var(--line); background: var(--bg-deep);
    color: var(--accent); font-size: 0.7rem; border-radius: 3px; letter-spacing: 0.06em;
  }
  .goblin-wrap { display: flex; flex-direction: column; align-items: center; }
  .personality {
    margin-top: 0.15rem; font-size: 0.58rem; color: var(--muted);
    letter-spacing: 0.1em; text-transform: uppercase;
  }

  .bubble-layer { position: absolute; inset: 0; pointer-events: none; z-index: 6; }
  .bubble {
    position: absolute; max-width: 22ch;
    padding: 0.45rem 0.65rem; background: var(--bubble-bg);
    border: 1px solid var(--bubble-border); border-radius: 6px;
    color: var(--fg-bright); font-size: 0.74rem; line-height: 1.35;
    box-shadow: 0 4px 16px rgba(0,0,0,0.55);
    opacity: 0; transform: translateY(6px);
    animation: bubble-in 0.25s ease-out forwards, bubble-out 0.4s ease-in forwards;
    animation-delay: 0s, 4s;
    word-break: break-word;
  }
  .bubble.kind-attack { border-color: #5a2a14; color: var(--fail); }
  .bubble.kind-pass   { border-color: #2a5a14; color: var(--pass); }
  .bubble.kind-fail   { border-color: #5a2a14; color: var(--fail); }
  .bubble.kind-win    { border-color: #5a4a14; color: var(--warn); }
  .bubble::after { content: ""; position: absolute; width: 0; height: 0; border: 6px solid transparent; }
  .bubble[data-tail="bl"]::after { bottom: -12px; left: 14px; border-top-color: var(--bubble-border); }
  .bubble[data-tail="br"]::after { bottom: -12px; right: 14px; border-top-color: var(--bubble-border); }
  .bubble[data-tail="tl"]::after { top: -12px; left: 14px; border-bottom-color: var(--bubble-border); }
  @keyframes bubble-in  { to { opacity: 1; transform: translateY(0); } }
  @keyframes bubble-out { to { opacity: 0; transform: translateY(-4px); } }

  /* DAG side panel (Phase 3): shows plan nodes with statuses */
  .dag-panel {
    position: absolute;
    top: 30%;
    right: 1%;
    width: 210px;
    background: rgba(10,14,8,0.94);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 0.5rem 0.6rem 0.6rem;
    color: var(--fg);
    font-size: 0.7rem;
    z-index: 18;
    display: none;
    box-shadow: 0 4px 18px rgba(0,0,0,0.5);
    max-height: 38%;
    overflow-y: auto;
  }
  .dag-panel.open { display: block; }
  .dag-panel.collapsed {
    max-height: 1.6rem;
    overflow: hidden;
    padding-bottom: 0.3rem;
  }
  .dag-panel.collapsed #dag-nodes { display: none; }
  .dag-panel h4 {
    margin: 0 0 0.4rem;
    color: var(--fg-bright);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    user-select: none;
  }
  .dag-panel h4 .toggle {
    color: var(--muted);
    font-size: 0.7rem;
    margin-left: 0.4rem;
  }
  .dag-panel h4:hover .toggle { color: var(--accent-hot); }
  .dag-node {
    display: flex; gap: 0.4rem; align-items: flex-start;
    padding: 3px 0;
    border-top: 1px dashed var(--line);
    line-height: 1.3;
  }
  .dag-node:first-of-type { border-top: none; }
  .dag-node .id {
    color: var(--muted); font-weight: 600;
    min-width: 2.5em;
  }
  .dag-node .text { flex: 1; word-break: break-word; }
  .dag-node[data-status="pending"]  .id { color: var(--muted); }
  .dag-node[data-status="running"]  .id { color: var(--accent-hot); animation: pulse-dot 1s ease-in-out infinite; }
  .dag-node[data-status="done"]     .id { color: var(--pass); }
  .dag-node[data-status="failed"]   .id { color: var(--fail); }
  .dag-node[data-status="skipped"]  .id { color: var(--muted-deep); }

  /* Live "thinking" bubble: sticky, updates in place as tokens stream */
  .think-bubble {
    position: absolute;
    max-width: 32ch;
    padding: 0.5rem 0.7rem;
    background: rgba(20,32,26,0.96);
    border: 1px dashed var(--accent);
    border-radius: 6px;
    color: var(--fg-bright);
    font-size: 0.72rem;
    line-height: 1.4;
    box-shadow: 0 4px 18px rgba(0,0,0,0.6);
    pointer-events: none;
    z-index: 7;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .think-bubble::after {
    content: "▮";
    margin-left: 2px;
    color: var(--accent);
    animation: think-blink 1s steps(2) infinite;
  }
  @keyframes think-blink { 50% { opacity: 0; } }

  .ticker {
    border-top: 1px solid var(--line); padding: 0.55rem 1rem;
    color: var(--muted); font-size: 0.82rem;
    min-height: 2.3rem; display: flex; align-items: center; gap: 0.6rem;
  }
  .ticker .dot { color: var(--accent); }
  .ticker.live { color: var(--fg-bright); }
  .ticker.live .dot { color: var(--accent-hot); animation: pulse-dot 1s ease-in-out infinite; }
  @keyframes pulse-dot { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }

  .btn {
    flex: 1; padding: 0.75rem 1rem;
    border: 1px solid var(--line); background: var(--bg-deep); color: var(--fg-bright);
    font-family: inherit; font-size: 0.85rem; letter-spacing: 0.1em; text-transform: uppercase;
    cursor: pointer; text-decoration: none; text-align: center;
    transition: border-color .15s, color .15s, background .15s, transform .1s;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent-hot); transform: translateY(-1px); }
  .btn.primary { border-color: var(--accent); background: var(--accent); color: var(--bg); font-weight: 600; }
  .btn.primary:hover { background: var(--accent-hot); border-color: var(--accent-hot); color: var(--bg); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

  /* Result panel — drops in from bottom of tank */
  .result-panel {
    position: absolute; left: 0; right: 0; bottom: 0;
    background: rgba(10,14,8,0.97);
    border-top: 1px solid var(--accent);
    padding: 0.7rem 1rem 0.85rem;
    z-index: 15;
    max-height: 60%;
    transform: translateY(101%);
    transition: transform 0.35s ease-out;
    display: flex; flex-direction: column; gap: 0.45rem;
  }
  .result-panel.open { transform: translateY(0); }
  .result-header {
    display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap;
    font-size: 0.78rem;
  }
  .result-outcome {
    display: inline-block; padding: 2px 9px; border-radius: 3px;
    font-size: 0.68rem; letter-spacing: 0.1em;
    text-transform: uppercase; font-weight: 600;
  }
  .result-outcome.winner              { background: #1f3a14; color: var(--pass); }
  .result-outcome.specialist_recovery { background: #2a3a14; color: #c2f37a; }
  .result-outcome.ogre_fallback       { background: #3a2914; color: #f3c07a; }
  .result-outcome.all_failed          { background: #3a1414; color: var(--fail); }
  .result-task {
    color: var(--muted); font-style: italic; font-size: 0.78rem;
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .result-score { color: var(--warn); font-size: 0.78rem; white-space: nowrap; }
  .result-output {
    background: var(--bg-deep); padding: 0.55rem 0.75rem;
    font-size: 0.8rem; color: var(--fg-bright);
    max-height: 220px; overflow-y: auto;
    white-space: pre-wrap; word-break: break-word;
    border-left: 2px solid var(--muted); margin: 0;
    line-height: 1.45;
  }
  .result-actions {
    display: flex; gap: 0.6rem; align-items: center;
    font-size: 0.74rem;
  }
  .result-actions a { color: var(--accent); text-decoration: none; }
  .result-actions a:hover { color: var(--accent-hot); }
  .result-actions .grow { flex: 1; }
  .result-dismiss {
    padding: 3px 11px; background: var(--bg-deep);
    border: 1px solid var(--line); color: var(--muted);
    cursor: pointer; font-family: inherit; font-size: 0.7rem;
    letter-spacing: 0.08em; text-transform: uppercase;
  }
  .result-dismiss:hover { border-color: var(--accent); color: var(--accent-hot); }

  .ui-tooltip {
    position: fixed;
    z-index: 70;
    pointer-events: none;
    max-width: 34ch;
    background: rgba(8,11,7,0.97);
    border: 1px solid var(--accent);
    color: var(--fg-bright);
    font-size: 0.72rem;
    line-height: 1.4;
    padding: 0.42rem 0.55rem;
    box-shadow: 0 8px 28px rgba(0,0,0,0.6);
    opacity: 0;
    transform: translateY(4px);
    transition: opacity .12s ease, transform .12s ease;
  }
  .ui-tooltip.show { opacity: 1; transform: translateY(0); }
  .onboard-overlay {
    position: absolute;
    inset: 0;
    z-index: 65;
    background: rgba(8,11,7,0.84);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .onboard-overlay.open { display: flex; }
  .onboard-card {
    width: min(560px, calc(100% - 1.2rem));
    background: rgba(10,14,8,0.98);
    border: 1px solid var(--accent);
    box-shadow: 0 14px 44px rgba(0,0,0,0.75);
    padding: 1rem;
  }
  .onboard-title {
    margin: 0;
    color: var(--fg-bright);
    font-size: 0.9rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .onboard-body {
    margin: 0.6rem 0 0;
    color: var(--fg);
    font-size: 0.79rem;
    line-height: 1.45;
  }
  .onboard-progress {
    margin: 0.35rem 0 0;
    color: var(--muted);
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .onboard-actions {
    display: flex;
    gap: 0.55rem;
    margin-top: 0.85rem;
  }
  .onboard-focus {
    position: relative;
    z-index: 68;
    outline: 2px solid rgba(143,207,82,0.72);
    outline-offset: 2px;
  }

  /* Rite form overlay */
  .rite-overlay {
    position: absolute; inset: 0;
    background: rgba(10,14,8,0.92);
    z-index: 20;
    display: none;
    align-items: center; justify-content: center;
    padding: 2rem;
  }
  .rite-overlay.open { display: flex; }
  .rite-form {
    background: var(--bg-deep); border: 1px solid var(--accent);
    padding: 1.2rem 1.5rem; border-radius: 6px;
    width: min(560px, 100%);
    box-shadow: 0 8px 40px rgba(0,0,0,0.7);
  }
  .rite-form h2 { margin: 0 0 0.8rem; color: var(--fg-bright); font-size: 1rem; letter-spacing: 0.06em; text-transform: uppercase; }
  .rite-form label { display: block; color: var(--muted); font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.2rem; }
  .rite-form textarea, .rite-form input, .rite-form select {
    width: 100%; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); padding: 0.5rem 0.6rem;
    font-family: inherit; font-size: 0.85rem; border-radius: 3px;
    margin-bottom: 0.8rem;
  }
  .rite-form textarea:focus, .rite-form input:focus, .rite-form select:focus {
    outline: none; border-color: var(--accent);
  }
  .rite-form .row { display: flex; gap: 0.8rem; }
  .rite-form .row > * { flex: 1; }
  .rite-form .check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--fg); margin-bottom: 0.8rem; }
  .rite-form .check input { width: auto; margin: 0; }
  .rite-form .actions { display: flex; gap: 0.6rem; margin-top: 0.5rem; }
</style>
</head>
<body>

<div class="warren" id="warren" data-tier="0">

  <div class="strip">
    <span class="name">WARREN · ${esc(warrenName)}</span>
    <span class="stat"><b id="stat-loot">${lootCount}</b> loot</span>
    <span class="stat"><b id="stat-rites">${riteCount}</b> rites</span>
    <span class="stat">drift <b id="stat-drift">${drift.toFixed(3)}</b></span>
    <span class="grow"></span>
    <button class="auth-chip" id="auth-chip" type="button">Sign In ▾</button>
    <button class="country-chip" id="country-chip" type="button">Country ▾</button>
    <button class="mail-chip" id="mail-chip" type="button">Mail ▾</button>
    <button class="provider-chip" id="provider-chip" type="button">API ▾</button>
    <span class="tier" id="tier-display">tier 0 · empty plot</span>
    <span class="clock" id="clock">idle</span>
  </div>

  <div class="provider-popover" id="provider-popover">
    <h3>API Provider</h3>
    <label for="provider-preset">Preset</label>
    <select id="provider-preset"></select>
    <label for="provider-baseurl">Base URL</label>
    <input id="provider-baseurl" placeholder="https://api.example.com/v1">
    <div class="provider-grid">
      <div>
        <label for="provider-keyenv">Key env var</label>
        <input id="provider-keyenv" placeholder="OPENAI_API_KEY">
      </div>
      <div>
        <label for="provider-apikey">API key (saved locally)</label>
        <input id="provider-apikey" type="password" autocomplete="off" placeholder="sk-...">
      </div>
    </div>
    <div class="provider-grid">
      <div>
        <label for="provider-format">Forced format</label>
        <select id="provider-format">
          <option value="freeform">freeform</option>
          <option value="markdown">markdown</option>
          <option value="json">json object</option>
        </select>
      </div>
      <div>
        <label>&nbsp;</label>
        <button class="btn" type="button" id="provider-clear-key">Clear Saved Key</button>
      </div>
    </div>
    <details class="provider-advanced">
      <summary>advanced models</summary>
      <div class="provider-grid" id="provider-models"></div>
    </details>
    <p class="provider-status" id="provider-status">Loading provider...</p>
    <div class="provider-actions">
      <button class="btn primary" type="button" id="provider-save">Save</button>
      <button class="btn" type="button" id="provider-cancel">Close</button>
    </div>
  </div>

  <div class="auth-popover" id="auth-popover">
    <h3>Sign-in & Cloud Collab</h3>
    <p class="auth-status" id="auth-status">Loading auth state...</p>
    <div class="provider-actions">
      <button class="btn" type="button" id="auth-google-btn">Google</button>
      <button class="btn" type="button" id="auth-github-btn">GitHub</button>
      <button class="btn" type="button" id="auth-signout-btn">Sign Out</button>
    </div>
    <p class="country-subtle" id="auth-note">Firebase mode needs sign-in and Firebase project config in env vars.</p>
  </div>

  <div class="country-popover" id="country-popover">
    <h3>Goblin-Country</h3>
    <div class="country-mode-row">
      <label><span>Country Mode</span> <input type="checkbox" id="country-enabled"></label>
      <label><span>Backend</span>
        <select id="country-backend">
          <option value="local">Local</option>
          <option value="firebase">Firebase</option>
        </select>
      </label>
    </div>
    <p class="country-subtle" id="country-summary">Loading country...</p>
    <div class="country-tabs" id="country-tabs">
      <button class="country-tab active" type="button" data-country-tab="overview">Overview</button>
      <button class="country-tab" type="button" data-country-tab="join">Join</button>
      <button class="country-tab" type="button" data-country-tab="team">Team</button>
    </div>
    <div class="country-grid">
      <div class="country-panel active" data-country-panel="overview">
        <div class="country-pane">
          <h4>Overview</h4>
          <p class="country-subtle">Your country: <strong id="country-name">-</strong> · ID code: <strong id="country-code">-</strong></p>
          <h4 style="margin-top:0.75rem;">Online & Mail</h4>
          <div class="country-list" id="country-members"></div>
          <h4 style="margin-top:0.75rem;">Queue</h4>
          <div class="country-list" id="country-queue"></div>
        </div>
      </div>
      <div class="country-panel" data-country-panel="join">
        <div class="country-pane">
          <h4>Join A Country</h4>
          <div class="country-row">
            <input name="country-search-code" id="country-search-code" placeholder="Search by code (e.g. A7K2Q)">
            <button class="btn" type="button" id="country-search-btn">Search</button>
          </div>
          <div class="country-list" id="country-join-list"></div>
          <h4 style="margin-top:0.75rem;">Pending Join Requests</h4>
          <div class="country-list" id="country-requests"></div>
        </div>
      </div>
      <div class="country-panel" data-country-panel="team">
        <div class="country-pane">
          <h4>Role Assignment</h4>
          <p class="country-subtle">Assign each rite role to one member. Unassigned roles default to lead when enabled.</p>
          <table class="country-role-table" id="country-role-table"></table>
          <label class="check" style="margin-top:0.6rem;">
            <input type="checkbox" id="country-auto-lead" checked>
            Auto-assign unclaimed roles to lead
          </label>
        </div>
      </div>
    </div>
    <div class="country-actions">
      <button class="btn primary" type="button" id="country-save">Save Team</button>
      <span class="country-status" id="country-status"></span>
    </div>
  </div>

  <div class="mail-popover" id="mail-popover">
    <h3>Friends & Mail</h3>
    <p class="mail-subtle" id="mail-summary">Loading friends...</p>
    <div class="mail-grid">
      <div class="mail-pane">
        <h4>Add Friend</h4>
        <div class="mail-row">
          <input id="friend-target-code" placeholder="Country code (e.g. A7K2Q)">
          <button class="btn" type="button" id="friend-request-btn">Add</button>
        </div>
        <p class="mail-subtle">Use a collaborator country code. No direct URL entry needed.</p>
        <h4>Pending Requests</h4>
        <div class="mail-list" id="friend-requests-list"></div>
        <h4 style="margin-top:0.75rem;">Friends</h4>
        <div class="mail-list" id="friends-list"></div>
      </div>
      <div class="mail-pane">
        <h4>Threads</h4>
        <div class="mail-list" id="dm-threads-list"></div>
        <h4 style="margin-top:0.75rem;">Messages</h4>
        <div class="mail-list" id="dm-messages-list" style="max-height:240px;"></div>
        <div class="mail-row" style="margin-top:0.5rem;">
          <textarea id="dm-compose-body" placeholder="Write message..."></textarea>
        </div>
        <div class="mail-actions">
          <button class="btn primary" type="button" id="dm-send-btn">Send</button>
          <span class="mail-status" id="mail-status"></span>
        </div>
      </div>
    </div>
  </div>

  <div class="workarea" id="workarea">
  <aside class="ops-sidebar" id="ops-sidebar">
    <div class="ops-head">
      <h3>Command Sidebar</h3>
      <button class="ops-toggle" id="ops-toggle" type="button" aria-expanded="true">◀</button>
    </div>
    <div class="ops-main" id="ops-main">
      <div class="ops-quick">
        <button class="btn primary" id="btn-rite" type="button">NEW RITE</button>
        <button class="btn" id="btn-plan" type="button">PLAN</button>
        <a class="btn" href="/runs">RUNS</a>
      </div>
      <div class="ops-subtle">Run any Goblintown CLI command in-app. Use full syntax in the input line.</div>
      <div class="ops-row">
        <input class="ops-input" id="ops-line" placeholder='e.g. rite "Refactor planner" --pack 3 --remember'>
        <button class="btn primary" id="ops-run" type="button">Run</button>
      </div>
      <details class="ops-examples" id="ops-examples">
        <summary>Command Examples</summary>
        <div class="ops-presets" id="ops-presets">
          <button type="button" data-line='summon goblin --task "Quick analysis"'>summon</button>
          <button type="button" data-line='scavenge --task "What changed?" --scan "src/**/*.ts"'>scavenge</button>
          <button type="button" data-line='quest "Investigate bug" --pack 3'>quest</button>
          <button type="button" data-line='hoard --limit 20'>hoard</button>
          <button type="button" data-line='drift'>drift</button>
          <button type="button" data-line='route'>route</button>
          <button type="button" data-line='country run --task "Cross-check this plan" --all'>country run</button>
          <button type="button" data-line='fold --threshold 30'>fold</button>
        </div>
      </details>
      <div class="ops-output" id="ops-output">ready</div>
    </div>
  </aside>

  <div class="tank" id="tank">

    <span class="star" style="top: 5%; left: 18%;">✦</span>
    <span class="star" style="top: 8%; left: 38%; animation-delay: -1s;">✦</span>
    <span class="star" style="top: 4%; left: 62%; animation-delay: -2s;">·</span>
    <span class="star" style="top: 9%; left: 75%; animation-delay: -3s;">✦</span>
    <span class="star" style="top: 6%; left: 88%;">·</span>

    <div class="mountains t4">🏔️ 🏔️ 🏔️ 🏔️ 🏔️</div>

    <div class="skyline back t3">🛖 🛖 🏚️ 🛖 🏚️ 🛖 🏚️ 🛖</div>

    <div class="skyline mid t1">🛖</div>
    <div class="skyline mid t2-flex" style="justify-content: center; gap: 1.2rem;">
      <span>🏚️</span><span>🛖</span><span>🏠</span>
    </div>
    <div class="skyline mid t3-flex" style="justify-content: center; gap: 1rem;">
      <span>🛖</span><span>🏚️</span><span>🛖</span><span>🏠</span><span>🛖</span>
    </div>
    <div class="skyline mid t4-flex" style="justify-content: center; gap: 0.9rem;">
      <span>🏚️</span><span>🛖</span><span>🏚️</span><span>🛖</span><span>🏠</span><span>🛖</span><span>🏚️</span>
    </div>

    <span class="smoke t2" style="top: 19%; left: 47%;">~</span>
    <span class="smoke t2" style="top: 19%; left: 41%; animation-delay: -1.4s;">~</span>
    <span class="smoke t2" style="top: 19%; left: 55%; animation-delay: -2.6s;">~</span>

    <pre class="banner t2">┌──── GOBLINTOWN ────┐
└── est. 2026 · MIT ─┘</pre>

    <div class="trees left t3">🌲🌲</div>
    <div class="trees right t3">🌲🌲</div>

    <span class="lantern" style="top: 36%; left: 26%;">🏮</span>
    <span class="lantern" style="top: 36%; right: 26%;">🏮</span>
    <span class="lantern" style="top: 56%; left: 18%; animation-delay: -1s;">🏮</span>

    <div class="ground"></div>
    <div class="ground-shadow"></div>

<pre class="pigeon-wire" id="pigeon-wire">═══════════════
        │
        │</pre>

<pre class="gremlin-perch">    │
    │
 ───┴───</pre>

    <div class="ogre-cave"></div>
    <div class="ogre-cave-label">ogre's cave</div>

    <div class="workshop">
      <div class="workshop-fire">🔥</div>
      <div>workshop</div>
    </div>

<pre class="troll-bridge">▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▌
▌                  ▐
~~~~~~~~~~~~~~~~~~~~</pre>

    <div class="raccoon-dump">🗑️ 📦</div>

    <div class="hoard" id="hoard"></div>

    <div class="creature pos-pigeon" id="c-pigeon" data-state="idle"
         style="--sway-dur: 3.6s; --sway-x: 3px; --sway-delay: -0.8s;">
      <canvas class="sprite-shell pigeon-sprite" id="c-pigeon-sprite" width="128" height="128" aria-hidden="true"></canvas>
      <span class="emoji">🐦</span>
      <span class="label">pigeon</span>
    </div>
    <div class="creature pos-gremlin" id="c-gremlin" data-state="idle"
         style="--sway-dur: 3.2s; --sway-x: 4px; --sway-delay: -2.1s;">
      <span class="emoji">😈</span>
      <span class="label">gremlin</span>
    </div>
    <div class="creature pos-ogre" id="c-ogre" data-state="cave"
         style="--sway-dur: 6s; --sway-x: 1px; font-size: 3rem;">
      <span class="emoji">👹</span>
      <span class="label">ogre</span>
    </div>
    <div class="pos-goblins" id="c-goblins">
      <div class="goblin-pile" id="goblin-pile"></div>
    </div>
    <div class="creature pos-raccoon" id="c-raccoon" data-state="idle"
         style="--sway-dur: 4.4s; --sway-x: 3px; --sway-delay: -1.3s;">
      <span class="emoji">🦝</span>
      <span class="label">raccoon</span>
    </div>
    <div class="creature pos-troll" id="c-troll" data-state="idle"
         style="--sway-dur: 5.2s; --sway-x: 2px; --sway-delay: -3s; font-size: 2.8rem;">
      <span class="emoji">🧌</span>
      <span class="label">troll</span>
    </div>

    <div class="bubble-layer" id="bubble-layer"></div>

    <!-- DAG side panel (Phase 3 — only visible during a planned rite) -->
    <div class="dag-panel" id="dag-panel">
      <h4 id="dag-header"><span>plan</span><span class="toggle" id="dag-toggle">[hide]</span></h4>
      <div id="dag-nodes"></div>
    </div>

    <!-- Result panel (hidden until rite completes) -->
    <div class="result-panel" id="result-panel">
      <div class="result-header">
        <span class="result-outcome" id="result-outcome">—</span>
        <span class="result-task" id="result-task"></span>
        <span class="result-score" id="result-score"></span>
      </div>
      <pre class="result-output" id="result-output"></pre>
      <div class="result-actions">
        <a id="result-link" href="#">view full rite ↗</a>
        <span class="grow"></span>
        <button class="result-dismiss" id="result-dismiss">dismiss</button>
      </div>
    </div>

    <!-- Rite form overlay -->
    <div class="rite-overlay" id="rite-overlay">
      <form class="rite-form" id="rite-form">
        <h2>▶ New rite</h2>
        <label for="rf-task">Task</label>
        <textarea id="rf-task" name="task" rows="3" placeholder="What should the goblins solve?" required></textarea>
        <div class="row">
          <div>
            <label for="rf-pack">Pack size</label>
            <input id="rf-pack" name="packSize" type="number" value="3" min="1" max="6">
          </div>
          <div>
            <label for="rf-personality">Lead personality</label>
            <select id="rf-personality" name="personality">
              <option value="nerdy">nerdy</option>
              <option value="cynical">cynical</option>
              <option value="chipper">chipper</option>
              <option value="stoic">stoic</option>
              <option value="feral">feral</option>
            </select>
          </div>
        </div>
        <label for="rf-globs">Scan globs (one per line, optional)</label>
        <textarea id="rf-globs" name="scanGlobs" rows="2" placeholder="src/**/*.ts"></textarea>
        <div class="check">
          <input type="checkbox" id="rf-nofallback" name="noFallback">
          <label for="rf-nofallback" style="margin: 0; color: var(--fg);">skip ogre fallback</label>
        </div>
        <div class="check">
          <input type="checkbox" id="rf-debate" name="debate">
          <label for="rf-debate" style="margin: 0; color: var(--fg);">inter-agent debate round (Phase 4)</label>
        </div>
        <div class="check">
          <input type="checkbox" id="rf-troll-tools" name="trollTools">
          <label for="rf-troll-tools" style="margin: 0; color: var(--fg);">verifier tools for troll (Phase 5)</label>
        </div>
        <div class="check">
          <input type="checkbox" id="rf-remember" name="remember">
          <label for="rf-remember" style="margin: 0; color: var(--fg);">remember (load relevant prior artifacts)</label>
        </div>
        <div class="actions">
          <button type="submit" class="btn primary">Begin rite</button>
          <button type="button" class="btn" id="rf-cancel">Cancel</button>
        </div>
      </form>
    </div>

    <div class="onboard-overlay" id="onboard-overlay">
      <div class="onboard-card">
        <h4 class="onboard-title" id="onboard-title">Welcome to Goblintown</h4>
        <p class="onboard-body" id="onboard-body"></p>
        <p class="onboard-progress" id="onboard-progress">Step 1</p>
        <div class="onboard-actions">
          <button class="btn" type="button" id="onboard-back">Back</button>
          <button class="btn" type="button" id="onboard-skip">Skip</button>
          <button class="btn primary" type="button" id="onboard-next">Next</button>
        </div>
      </div>
    </div>
  </div>
  </div>

  <div class="ticker" id="ticker">
    <span class="dot">●</span> <span id="ticker-text">idle</span>
  </div>

</div>

<script>
const INITIAL = ${initial};

const $ = (id) => document.getElementById(id);
const tank = $("tank");
const ticker = $("ticker");
const tickerText = $("ticker-text");
const goblinPile = $("goblin-pile");
const bubbleLayer = $("bubble-layer");
const warren = $("warren");
const workarea = $("workarea");
const opsToggle = $("ops-toggle");
const opsLine = $("ops-line");
const opsRun = $("ops-run");
const opsOutput = $("ops-output");

const rand  = (lo, hi) => lo + Math.random() * (hi - lo);
const irand = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick  = (arr)    => arr[Math.floor(Math.random() * arr.length)];

/* Pigeon sprite renderer */
const PIGEON_SPRITE_CONFIG = {
  rightSrc: "/assets/pigeon-walk-right.png",
  leftSrc: "/assets/pigeon-walk-left.png",
  cols: 5,
  rows: 5,
  totalFrames: 25,
};
const PIGEON_PECK_CONFIG = {
  src: "/assets/pigeon-peck.png",
  cols: 5,
  rows: 5,
  totalFrames: 25,
  minIntervalMs: 40_000,
  maxIntervalMs: 120_000,
  fps: 11,
};
const PIGEON_WIRE_NUDGE_UP_PX = 12;
const pigeonSpriteCanvas = $("c-pigeon-sprite");
const pigeonSpriteCtx = pigeonSpriteCanvas ? pigeonSpriteCanvas.getContext("2d") : null;
const pigeonWire = $("pigeon-wire");
const pigeonEl = $("c-pigeon");
const pigeonSpriteState = {
  enabled: false,
  mode: "walk",
  visualState: "idle",
  facing: "right",
  frameCursor: 0,
  walkFrameOrder: [],
  peckFrameOrder: [],
  frameAccumulatorMs: 0,
  fps: 8,
  walkFps: 9,
  lastTickMs: 0,
  rafId: 0,
  images: { right: null, left: null, peck: null },
  flipLeftFromRight: false,
  railReady: false,
  railX: 0,
  railMinX: 0,
  railMaxX: 0,
  railTopPx: 0,
  railDir: 1,
  pendingTurnDir: 0,
  endPauseUntilMs: 0,
  endPauseMs: 260,
  nextPeckAtMs: 0,
  peckLoopsLeft: 0,
};

function loadPigeonSheet(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load sprite sheet: " + src));
    img.src = src;
  });
}

function setPigeonFacing(facing) {
  pigeonSpriteState.facing = facing === "left" ? "left" : "right";
}

function setPigeonFps(fps) {
  const clamped = Math.max(2, Math.min(24, Number(fps) || 8));
  pigeonSpriteState.fps = clamped;
}

function buildPigeonFrameOrder(totalFrames) {
  const n = Math.max(1, Math.floor(totalFrames || 1));
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  // SNES-like cadence: decimate frames for choppier, readable motion.
  const seq = [];
  for (let i = 0; i < n; i += 2) seq.push(i);
  // Avoid the terminal duplicate-hitch frame in many sheets.
  if (seq.length > 1 && seq[seq.length - 1] === n - 1) seq.pop();
  return seq.length ? seq : [0];
}

function buildLinearFrameOrder(totalFrames) {
  const n = Math.max(1, Math.floor(totalFrames || 1));
  return Array.from({ length: n }, (_, i) => i);
}

function frameSignatureFromSheet(sheet, frameIndex, cols, rows) {
  const frameW = Math.floor(sheet.naturalWidth / cols);
  const frameH = Math.floor(sheet.naturalHeight / rows);
  if (!frameW || !frameH) return "";
  const sx = (frameIndex % cols) * frameW;
  const sy = Math.floor(frameIndex / cols) * frameH;

  const sampleSize = 12;
  const c = document.createElement("canvas");
  c.width = sampleSize;
  c.height = sampleSize;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, sampleSize, sampleSize);
  ctx.drawImage(sheet, sx, sy, frameW, frameH, 0, 0, sampleSize, sampleSize);
  const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;

  let sig = "";
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    // Keep alpha + coarse luma to detect duplicate posed frames.
    if (a < 24) {
      sig += "00";
      continue;
    }
    const lum = ((data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8);
    sig += (a > 170 ? "2" : "1") + String((lum / 32) | 0);
  }
  return sig;
}

function dedupeAdjacentPigeonFrames(frameOrder, sheet, cols, rows) {
  if (!sheet || frameOrder.length <= 1) return frameOrder;
  const kept = [];
  let prevSig = "";
  for (const idx of frameOrder) {
    const sig = frameSignatureFromSheet(sheet, idx, cols, rows);
    if (!kept.length || sig !== prevSig) {
      kept.push(idx);
      prevSig = sig;
    }
  }
  return kept.length ? kept : frameOrder;
}

function nextPigeonPeckDelayMs() {
  return Math.floor(rand(PIGEON_PECK_CONFIG.minIntervalMs, PIGEON_PECK_CONFIG.maxIntervalMs));
}

function scheduleNextPigeonPeck(ts) {
  const now = Number.isFinite(ts) ? ts : performance.now();
  pigeonSpriteState.nextPeckAtMs = now + nextPigeonPeckDelayMs();
}

function startPigeonPeck(ts) {
  if (!pigeonSpriteState.images.peck) return false;
  if (!pigeonSpriteState.peckFrameOrder.length) return false;
  if (pigeonSpriteState.mode === "peck") return true;
  pigeonSpriteState.mode = "peck";
  pigeonSpriteState.frameCursor = 0;
  pigeonSpriteState.peckLoopsLeft = 1;
  pigeonSpriteState.pendingTurnDir = 0;
  pigeonSpriteState.endPauseUntilMs = 0;
  setPigeonFps(PIGEON_PECK_CONFIG.fps);
  pigeonSpriteState.nextPeckAtMs = Number.isFinite(ts) ? ts : performance.now();
  return true;
}

function finishPigeonPeck(ts) {
  pigeonSpriteState.mode = "walk";
  pigeonSpriteState.frameCursor = 0;
  pigeonSpriteState.peckLoopsLeft = 0;
  setPigeonFps(pigeonSpriteState.walkFps);
  scheduleNextPigeonPeck(ts);
}

function updatePigeonRailBounds(forceReset) {
  if (!tank || !pigeonWire || !pigeonEl) return false;
  const tankRect = tank.getBoundingClientRect();
  const wireRect = pigeonWire.getBoundingClientRect();
  if (!wireRect.width || !tankRect.width) return false;
  const spriteRect = pigeonSpriteCanvas ? pigeonSpriteCanvas.getBoundingClientRect() : null;
  const spriteW = spriteRect && spriteRect.width ? spriteRect.width : 92;
  const spriteH = spriteRect && spriteRect.height ? spriteRect.height : 92;
  let railMinX = wireRect.left - tankRect.left - spriteW * 0.08;
  let railMaxX = wireRect.right - tankRect.left - spriteW * 0.92;
  if (railMaxX <= railMinX) railMaxX = railMinX + Math.max(10, spriteW * 0.2);
  const railTopPx = wireRect.top - tankRect.top - spriteH * 0.62 - PIGEON_WIRE_NUDGE_UP_PX;

  pigeonSpriteState.railMinX = railMinX;
  pigeonSpriteState.railMaxX = railMaxX;
  pigeonSpriteState.railTopPx = railTopPx;
  if (!pigeonSpriteState.railReady || forceReset) {
    pigeonSpriteState.railX = railMinX;
    pigeonSpriteState.railDir = 1;
    pigeonSpriteState.pendingTurnDir = 0;
    pigeonSpriteState.endPauseUntilMs = 0;
    pigeonSpriteState.railReady = true;
    setPigeonFacing("right");
  } else {
    pigeonSpriteState.railX = Math.max(railMinX, Math.min(railMaxX, pigeonSpriteState.railX));
  }
  pigeonEl.style.left = pigeonSpriteState.railX.toFixed(2) + "px";
  pigeonEl.style.top = railTopPx.toFixed(2) + "px";
  return true;
}

function getPigeonRailStepPx() {
  const span = Math.max(1, pigeonSpriteState.railMaxX - pigeonSpriteState.railMinX);
  const frameCount = Math.max(2, pigeonSpriteState.walkFrameOrder.length || 2);
  return span / (frameCount - 1);
}

function isAtPigeonEdgeForDirection() {
  const epsilon = 0.5;
  if (pigeonSpriteState.railDir > 0) {
    return pigeonSpriteState.railX >= pigeonSpriteState.railMaxX - epsilon;
  }
  return pigeonSpriteState.railX <= pigeonSpriteState.railMinX + epsilon;
}

function handlePigeonBoundaryPause(ts) {
  if (!pigeonSpriteState.enabled || !pigeonSpriteState.railReady) return false;
  if (pigeonSpriteState.frameCursor !== 0) return false;
  if (!isAtPigeonEdgeForDirection()) return false;

  if (pigeonSpriteState.pendingTurnDir === 0) {
    pigeonSpriteState.pendingTurnDir = pigeonSpriteState.railDir > 0 ? -1 : 1;
    pigeonSpriteState.endPauseUntilMs = ts + pigeonSpriteState.endPauseMs;
    return true;
  }

  if (ts < pigeonSpriteState.endPauseUntilMs) return true;

  pigeonSpriteState.railDir = pigeonSpriteState.pendingTurnDir;
  pigeonSpriteState.pendingTurnDir = 0;
  setPigeonFacing(pigeonSpriteState.railDir < 0 ? "left" : "right");
  return false;
}

function advancePigeonRailByFrame() {
  if (!pigeonSpriteState.enabled || !pigeonSpriteState.railReady || !pigeonEl) return;
  const step = getPigeonRailStepPx();
  pigeonSpriteState.railX += pigeonSpriteState.railDir * step;
  if (pigeonSpriteState.railDir > 0) {
    pigeonSpriteState.railX = Math.min(pigeonSpriteState.railMaxX, pigeonSpriteState.railX);
  } else {
    pigeonSpriteState.railX = Math.max(pigeonSpriteState.railMinX, pigeonSpriteState.railX);
  }
  pigeonEl.style.left = pigeonSpriteState.railX.toFixed(2) + "px";
}

function drawPigeonFrame() {
  if (!pigeonSpriteState.enabled || !pigeonSpriteCtx || !pigeonSpriteCanvas) return;
  const wantLeft = pigeonSpriteState.facing === "left";
  let sheet = null;
  let frameOrder = [0];
  let cols = PIGEON_SPRITE_CONFIG.cols;
  let rows = PIGEON_SPRITE_CONFIG.rows;
  let usingFallbackFlip = false;

  if (pigeonSpriteState.mode === "peck" && pigeonSpriteState.images.peck) {
    sheet = pigeonSpriteState.images.peck;
    frameOrder = pigeonSpriteState.peckFrameOrder.length
      ? pigeonSpriteState.peckFrameOrder
      : [0];
    cols = PIGEON_PECK_CONFIG.cols;
    rows = PIGEON_PECK_CONFIG.rows;
    usingFallbackFlip = wantLeft;
  } else {
    usingFallbackFlip = wantLeft && pigeonSpriteState.flipLeftFromRight;
    sheet = wantLeft
      ? (pigeonSpriteState.images.left || pigeonSpriteState.images.right)
      : (pigeonSpriteState.images.right || pigeonSpriteState.images.left);
    frameOrder = pigeonSpriteState.walkFrameOrder.length
      ? pigeonSpriteState.walkFrameOrder
      : [0];
  }
  if (!sheet) return;

  const frameIndex = ((Math.floor(pigeonSpriteState.frameCursor) % frameOrder.length) + frameOrder.length) % frameOrder.length;
  const frame = frameOrder[frameIndex];
  const frameW = Math.floor(sheet.naturalWidth / cols);
  const frameH = Math.floor(sheet.naturalHeight / rows);
  if (!frameW || !frameH) return;
  const sx = (frame % cols) * frameW;
  const sy = Math.floor(frame / cols) * frameH;
  const dw = pigeonSpriteCanvas.width;
  const dh = pigeonSpriteCanvas.height;

  pigeonSpriteCtx.clearRect(0, 0, dw, dh);
  pigeonSpriteCtx.imageSmoothingEnabled = true;
  if (usingFallbackFlip) {
    pigeonSpriteCtx.save();
    pigeonSpriteCtx.translate(dw, 0);
    pigeonSpriteCtx.scale(-1, 1);
    pigeonSpriteCtx.drawImage(sheet, sx, sy, frameW, frameH, 0, 0, dw, dh);
    pigeonSpriteCtx.restore();
  } else {
    pigeonSpriteCtx.drawImage(sheet, sx, sy, frameW, frameH, 0, 0, dw, dh);
  }
}

function applyPigeonStateVisual(state) {
  if (!pigeonSpriteState.enabled) return;
  pigeonSpriteState.visualState = state;
  switch (state) {
    case "active":
      pigeonSpriteState.walkFps = 12;
      break;
    case "winner":
      pigeonSpriteState.walkFps = 10;
      break;
    case "fail":
      pigeonSpriteState.walkFps = 8;
      break;
    default:
      pigeonSpriteState.walkFps = 9;
      break;
  }
  if (pigeonSpriteState.mode !== "peck") {
    setPigeonFps(pigeonSpriteState.walkFps);
  }
}

function animatePigeonSprite(ts) {
  if (!pigeonSpriteState.enabled) return;
  if (!pigeonSpriteState.lastTickMs) {
    pigeonSpriteState.lastTickMs = ts;
    drawPigeonFrame();
  } else {
    const deltaMs = Math.max(0, ts - pigeonSpriteState.lastTickMs);
    pigeonSpriteState.lastTickMs = ts;

    if (
      pigeonSpriteState.mode !== "peck" &&
      pigeonSpriteState.images.peck &&
      pigeonSpriteState.peckFrameOrder.length &&
      ts >= pigeonSpriteState.nextPeckAtMs &&
      pigeonSpriteState.visualState === "idle"
    ) {
      startPigeonPeck(ts);
    }

    const frameMs = 1000 / pigeonSpriteState.fps;
    pigeonSpriteState.frameAccumulatorMs += deltaMs;
    let advanced = 0;
    while (pigeonSpriteState.frameAccumulatorMs >= frameMs && advanced < 6) {
      if (pigeonSpriteState.mode !== "peck" && handlePigeonBoundaryPause(ts)) {
        pigeonSpriteState.frameAccumulatorMs = Math.min(pigeonSpriteState.frameAccumulatorMs, frameMs);
        break;
      }
      pigeonSpriteState.frameAccumulatorMs -= frameMs;
      const prevCursor = pigeonSpriteState.frameCursor;
      const currentFrameOrder =
        pigeonSpriteState.mode === "peck"
          ? (pigeonSpriteState.peckFrameOrder.length ? pigeonSpriteState.peckFrameOrder : [0])
          : (pigeonSpriteState.walkFrameOrder.length ? pigeonSpriteState.walkFrameOrder : [0]);
      pigeonSpriteState.frameCursor =
        (pigeonSpriteState.frameCursor + 1) %
        Math.max(1, currentFrameOrder.length);

      if (pigeonSpriteState.mode === "peck") {
        if (pigeonSpriteState.frameCursor === 0 && prevCursor !== 0) {
          pigeonSpriteState.peckLoopsLeft = Math.max(0, pigeonSpriteState.peckLoopsLeft - 1);
          if (pigeonSpriteState.peckLoopsLeft <= 0) {
            finishPigeonPeck(ts);
          }
        }
      } else {
        advancePigeonRailByFrame();
      }
      advanced += 1;
    }
    drawPigeonFrame();
  }
  pigeonSpriteState.rafId = requestAnimationFrame(animatePigeonSprite);
}

async function bootPigeonSprite() {
  if (!pigeonSpriteCanvas || !pigeonSpriteCtx) return;
  try {
    let right = null;
    let left = null;
    let peck = null;
    let flipLeftFromRight = false;
    try {
      right = await loadPigeonSheet(PIGEON_SPRITE_CONFIG.rightSrc);
    } catch {}
    try {
      left = await loadPigeonSheet(PIGEON_SPRITE_CONFIG.leftSrc);
    } catch {
      if (right) flipLeftFromRight = true;
    }
    try {
      peck = await loadPigeonSheet(PIGEON_PECK_CONFIG.src);
    } catch {}
    if (!right && left) right = left;
    if (!right && !left) throw new Error("pigeon sprite sheets not found");
    pigeonSpriteState.images.right = right;
    pigeonSpriteState.images.left = left;
    pigeonSpriteState.images.peck = peck;
    pigeonSpriteState.flipLeftFromRight = flipLeftFromRight;
    const walkBaseOrder = buildPigeonFrameOrder(PIGEON_SPRITE_CONFIG.totalFrames);
    const walkSheet = right || left;
    pigeonSpriteState.walkFrameOrder = dedupeAdjacentPigeonFrames(
      walkBaseOrder,
      walkSheet,
      PIGEON_SPRITE_CONFIG.cols,
      PIGEON_SPRITE_CONFIG.rows
    );
    const peckBaseOrder = buildLinearFrameOrder(PIGEON_PECK_CONFIG.totalFrames);
    pigeonSpriteState.peckFrameOrder = peck
      ? dedupeAdjacentPigeonFrames(
          peckBaseOrder,
          peck,
          PIGEON_PECK_CONFIG.cols,
          PIGEON_PECK_CONFIG.rows
        )
      : [];
    pigeonSpriteState.frameCursor = 0;
    pigeonSpriteState.frameAccumulatorMs = 0;
    pigeonSpriteState.lastTickMs = 0;
    pigeonSpriteState.mode = "walk";
    pigeonSpriteState.walkFps = 9;
    setPigeonFps(pigeonSpriteState.walkFps);
    pigeonSpriteState.enabled = true;
    scheduleNextPigeonPeck(performance.now());
    if (pigeonEl) pigeonEl.classList.add("pigeon-animated");
    updatePigeonRailBounds(true);
    drawPigeonFrame();
    if (pigeonSpriteState.rafId) cancelAnimationFrame(pigeonSpriteState.rafId);
    pigeonSpriteState.rafId = requestAnimationFrame(animatePigeonSprite);
  } catch (err) {
    console.warn("pigeon-sprite-disabled", err);
  }
}
void bootPigeonSprite();
window.addEventListener("resize", () => {
  if (pigeonSpriteState.enabled) updatePigeonRailBounds(false);
});

function setSidebarCollapsed(collapsed) {
  workarea.classList.toggle("sidebar-collapsed", collapsed);
  opsToggle.textContent = collapsed ? "▶" : "◀";
  opsToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  try { localStorage.setItem("goblintown.sidebarCollapsed", collapsed ? "1" : "0"); } catch {}
}
opsToggle.onclick = () => {
  const collapsed = !workarea.classList.contains("sidebar-collapsed");
  setSidebarCollapsed(collapsed);
};
try {
  setSidebarCollapsed(localStorage.getItem("goblintown.sidebarCollapsed") === "1");
} catch {
  setSidebarCollapsed(false);
}

/* Tooltips (delegated, works for dynamic content too) */
const tooltipEl = document.createElement("div");
tooltipEl.className = "ui-tooltip";
document.body.appendChild(tooltipEl);
let tooltipTarget = null;
window.addEventListener("securitypolicyviolation", (event) => {
  try {
    const statusEl = document.getElementById("auth-status");
    const blocked = event.blockedURI ? " from " + event.blockedURI : "";
    const msg = "CSP blocked " + event.violatedDirective + blocked;
    if (statusEl) statusEl.textContent = msg;
  } catch {
    // no-op
  }
});
function setTip(id, text) {
  const el = $(id);
  if (el && text) el.setAttribute("data-tip", text);
}
function setTipIfMissing(el, text) {
  if (!el || !text) return;
  if (!el.getAttribute("data-tip")) el.setAttribute("data-tip", text);
}
function applyFallbackTips() {
  document.querySelectorAll("button, input, select, textarea, a.btn, summary").forEach((el) => {
    if (el.getAttribute("data-tip")) return;
    const fromLabel = (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || "").trim();
    const fromText = (el.textContent || "").trim().replace(/\s+/g, " ");
    const tip = fromLabel || fromText;
    if (tip) el.setAttribute("data-tip", tip);
  });
}
function placeTooltip(target) {
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, left));
  let top = rect.bottom + 8;
  if (top + tipRect.height > window.innerHeight - 8) top = rect.top - tipRect.height - 8;
  top = Math.max(8, top);
  tooltipEl.style.left = left + "px";
  tooltipEl.style.top = top + "px";
}
function showTooltip(target) {
  if (!target) return;
  const text = target.getAttribute("data-tip");
  if (!text) return;
  tooltipTarget = target;
  tooltipEl.textContent = text;
  tooltipEl.classList.add("show");
  placeTooltip(target);
}
function hideTooltip() {
  tooltipTarget = null;
  tooltipEl.classList.remove("show");
}
document.addEventListener("mouseover", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const target = ev.target.closest("[data-tip]");
  if (!target) return;
  showTooltip(target);
});
document.addEventListener("mouseout", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const from = ev.target.closest("[data-tip]");
  if (!from) return;
  const related = ev.relatedTarget instanceof Element ? ev.relatedTarget.closest("[data-tip]") : null;
  if (from !== related) hideTooltip();
});
document.addEventListener("focusin", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const target = ev.target.closest("[data-tip]");
  if (target) showTooltip(target);
});
document.addEventListener("focusout", () => hideTooltip());
window.addEventListener("scroll", () => {
  if (tooltipTarget) placeTooltip(tooltipTarget);
}, true);
window.addEventListener("resize", () => {
  if (tooltipTarget) placeTooltip(tooltipTarget);
});

/* Static tooltip copy */
[
  ["auth-chip", "Sign in with Firebase for cloud collaboration mode."],
  ["country-chip", "Open Goblin-Country settings and collaboration panels."],
  ["mail-chip", "Open friends, requests, and direct-message threads."],
  ["provider-chip", "Configure local provider, model slots, and API key storage."],
  ["btn-rite", "Start a new rite run immediately."],
  ["btn-plan", "Create a planned multi-step rite."],
  ["ops-toggle", "Collapse or expand the command sidebar."],
  ["ops-line", "Type a Goblintown CLI command here."],
  ["ops-run", "Run the command currently entered in the sidebar."],
  ["country-enabled", "Enable or disable country-mode collaboration."],
  ["country-backend", "Choose Local peer mode or Firebase cloud mode."],
  ["country-search-code", "Search countries by short country ID code."],
  ["country-search-btn", "Find countries to join using the typed code."],
  ["country-save", "Save country-mode settings and role assignments."],
  ["country-auto-lead", "If enabled, unassigned rite roles go to the team lead."],
  ["friend-target-code", "Enter a collaborator country code to add as friend."],
  ["friend-request-btn", "Send a friend request using the provided country code."],
  ["dm-compose-body", "Write a direct message to the selected friend."],
  ["dm-send-btn", "Send the current direct message."],
  ["auth-google-btn", "Sign in with Google via Firebase Authentication."],
  ["auth-github-btn", "Sign in with GitHub via Firebase Authentication."],
  ["auth-signout-btn", "Sign out from Firebase and disable cloud write operations."],
  ["provider-preset", "Select a provider preset (OpenAI, LM Studio, Ollama, etc.)."],
  ["provider-baseurl", "Base API URL for the active provider preset."],
  ["provider-keyenv", "Environment variable name used for this provider key."],
  ["provider-apikey", "Optional key saved in a local secret file on this machine."],
  ["provider-format", "Force response format mode for downstream parsing."],
  ["provider-save", "Save provider settings to local config."],
  ["provider-cancel", "Close provider settings without applying changes now."],
  ["provider-clear-key", "Delete the locally stored provider API key."],
  ["rf-task", "Describe the task for this rite."],
  ["rf-pack", "How many goblins should run in the pack."],
  ["rf-personality", "Lead goblin personality style for the run."],
  ["rf-globs", "Optional file globs for scavenger context scan."],
  ["rf-nofallback", "Prevent ogre fallback if all goblins fail."],
  ["rf-debate", "Enable an inter-agent debate round before review."],
  ["rf-troll-tools", "Allow verifier tool usage in troll review."],
  ["rf-remember", "Load relevant previous artifacts into context."],
  ["rf-cancel", "Close the rite form."],
  ["result-link", "Open the full rite detail page."],
  ["result-dismiss", "Hide the result panel."],
  ["onboard-back", "Go to the previous onboarding step."],
  ["onboard-skip", "Dismiss onboarding and continue directly to the app."],
  ["onboard-next", "Advance to the next onboarding step."],
].forEach((entry) => setTip(entry[0], entry[1]));
document.querySelectorAll("[data-country-tab]").forEach((btn) => setTipIfMissing(btn, "Switch country panel."));
document.querySelectorAll("#ops-presets button[data-line]").forEach((btn) => setTipIfMissing(btn, "Run this example command."));
applyFallbackTips();

function renderOpsResult(result) {
  const ok = result.ok ? "ok" : "error";
  const header = "[" + ok + "] " + result.command + " (exit " + result.code + ")";
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  let text = header;
  if (stdout) text += "\\n\\n" + stdout;
  if (stderr) text += "\\n\\n[stderr]\\n" + stderr;
  opsOutput.textContent = text;
  opsOutput.classList.toggle("err", !result.ok);
  opsOutput.classList.toggle("ok", !!result.ok);
}

async function runOpsLine() {
  const line = (opsLine.value || "").trim();
  if (!line) return;
  opsOutput.textContent = "running: " + line;
  opsRun.disabled = true;
  try {
    const r = await fetch("/api/cli", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line }),
    });
    const payload = await r.json().catch(() => ({}));
    if (!r.ok) {
      opsOutput.textContent = "error: " + (payload.error || "command failed");
      opsOutput.classList.add("err");
      opsOutput.classList.remove("ok");
      return;
    }
    renderOpsResult(payload);
    setTicker("command: " + line, true);
    setTimeout(() => { refreshStats(); }, 350);
  } catch (err) {
    opsOutput.textContent = "error: " + (err.message || err);
    opsOutput.classList.add("err");
    opsOutput.classList.remove("ok");
  } finally {
    opsRun.disabled = false;
  }
}

opsRun.onclick = runOpsLine;
opsLine.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runOpsLine();
  }
});
$("ops-presets").querySelectorAll("button[data-line]").forEach((btn) => {
  btn.onclick = () => {
    opsLine.value = btn.getAttribute("data-line") || "";
    runOpsLine();
  };
});

/* Town tier from real warren stats */
function tierOf(rites) {
  if (rites >= 12) return 4;
  if (rites >= 6)  return 3;
  if (rites >= 2)  return 2;
  if (rites >= 1)  return 1;
  return 0;
}
const tierName = ["empty plot","settlement","camp","village","town"];
function applyStats(stats) {
  const t = tierOf(stats.rites);
  warren.dataset.tier = t;
  $("stat-loot").textContent = stats.loot;
  $("stat-rites").textContent = stats.rites;
  $("stat-drift").textContent = (stats.drift ?? 0).toFixed(3);
  $("tier-display").textContent = "tier " + t + " · " + tierName[t];
  const piles = ["", "💰", "💰💰", "💰💰💰", "💰💰💰💰💎"];
  $("hoard").textContent = piles[t] || "";
  if (stats.rites === 0) setTicker("idle — empty plot, awaiting first rite");
  else if (!ticker.classList.contains("live")) setTicker("idle — " + stats.rites + " rites in this town");
}
applyStats(INITIAL);

async function refreshStats() {
  try {
    const r = await fetch("/api/warren/stats");
    if (r.ok) applyStats(await r.json());
  } catch {}
}

/* Provider menu */
let providerPresets = [];
let modelSlots = [];
const providerChip = $("provider-chip");
const providerPopover = $("provider-popover");
const providerPreset = $("provider-preset");
const providerBaseUrl = $("provider-baseurl");
const providerKeyEnv = $("provider-keyenv");
const providerApiKey = $("provider-apikey");
const providerFormat = $("provider-format");
const providerModels = $("provider-models");
const providerStatus = $("provider-status");
let countryPopover = null;

function providerById(id) {
  return providerPresets.find((p) => p.id === id) || providerPresets[0];
}
function renderProviderModels(models) {
  providerModels.innerHTML = "";
  for (const slot of modelSlots) {
    const wrap = document.createElement("div");
    const label = document.createElement("label");
    label.textContent = slot;
    const input = document.createElement("input");
    input.dataset.slot = slot;
    input.value = (models && models[slot]) || "";
    wrap.appendChild(label);
    wrap.appendChild(input);
    providerModels.appendChild(wrap);
  }
}
function applyProviderPayload(payload) {
  const config = payload.config || {};
  const runtime = payload.runtime || {};
  providerPreset.value = config.preset || runtime.id || "openai";
  providerBaseUrl.value = config.baseURL || runtime.baseURL || "";
  providerKeyEnv.value = config.apiKeyEnv || runtime.apiKeyEnv || "OPENAI_API_KEY";
  providerFormat.value = config.outputFormat || runtime.outputFormat || "freeform";
  renderProviderModels({ ...(runtime.models || {}), ...(config.models || {}) });
  const missing = runtime.missingApiKey;
  providerChip.textContent = (runtime.label || "API") + " ▾";
  providerChip.dataset.missing = missing ? "true" : "false";
  providerApiKey.value = "";
  if (missing) {
    providerStatus.innerHTML = "Missing key: set <strong>" + missing + "</strong> in env or save locally.";
    return;
  }
  let source = "available";
  if (runtime.apiKeySource === "env") source = "from environment";
  else if (runtime.apiKeySource === "stored") source = "from local secret file";
  else if (runtime.apiKeySource === "dummy") source = "using local dummy key";
  providerStatus.innerHTML = "Using <strong>" + (runtime.label || "provider") + "</strong>, key " + source + ".";
}
async function loadProviderMenu() {
  try {
    const [providersRes, providerRes] = await Promise.all([
      fetch("/api/providers"),
      fetch("/api/provider"),
    ]);
    if (providersRes.ok) {
      const data = await providersRes.json();
      providerPresets = data.presets || [];
      modelSlots = data.modelSlots || [];
      providerPreset.innerHTML = "";
      for (const preset of providerPresets) {
        const option = document.createElement("option");
        option.value = preset.id;
        option.textContent = preset.label;
        providerPreset.appendChild(option);
      }
    }
    if (providerRes.ok) applyProviderPayload(await providerRes.json());
  } catch {
    providerStatus.textContent = "Provider menu unavailable.";
  }
}
providerPreset.onchange = () => {
  const preset = providerById(providerPreset.value);
  if (!preset) return;
  providerBaseUrl.value = preset.baseURL || "";
  providerKeyEnv.value = preset.apiKeyEnv || "OPENAI_API_KEY";
  renderProviderModels(preset.models || {});
};
providerChip.onclick = () => {
  const authPanel = document.getElementById("auth-popover");
  if (authPanel) authPanel.classList.remove("open");
  if (countryPopover) countryPopover.classList.remove("open");
  const mailPanel = document.getElementById("mail-popover");
  if (mailPanel) mailPanel.classList.remove("open");
  providerPopover.classList.toggle("open");
};
$("provider-cancel").onclick = () => providerPopover.classList.remove("open");
$("provider-save").onclick = async () => {
  const models = {};
  providerModels.querySelectorAll("input[data-slot]").forEach((input) => {
    const value = input.value.trim();
    if (value) models[input.dataset.slot] = value;
  });
  const payload = {
    preset: providerPreset.value,
    baseURL: providerBaseUrl.value.trim(),
    apiKeyEnv: providerKeyEnv.value.trim(),
    outputFormat: providerFormat.value,
    models,
  };
  const enteredApiKey = providerApiKey.value.trim();
  if (enteredApiKey) payload.apiKey = enteredApiKey;
  providerStatus.textContent = "Saving...";
  try {
    const r = await fetch("/api/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(await r.text());
    applyProviderPayload(await r.json());
    providerPopover.classList.remove("open");
    setTicker("provider saved: " + providerChip.textContent.replace(" ▾", ""));
  } catch (err) {
    providerStatus.textContent = "Save failed: " + (err.message || err);
  }
};
$("provider-clear-key").onclick = async () => {
  providerStatus.textContent = "Clearing saved key...";
  try {
    const r = await fetch("/api/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: providerPreset.value,
        baseURL: providerBaseUrl.value.trim(),
        apiKeyEnv: providerKeyEnv.value.trim(),
        outputFormat: providerFormat.value,
        clearApiKey: true,
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    applyProviderPayload(await r.json());
    setTicker("saved key cleared");
  } catch (err) {
    providerStatus.textContent = "Clear failed: " + (err.message || err);
  }
};
loadProviderMenu();

/* Auth + Firebase collab */
const authChip = $("auth-chip");
const authPopover = $("auth-popover");
const authStatus = $("auth-status");
const authNote = $("auth-note");
const authGoogleBtn = $("auth-google-btn");
const authGithubBtn = $("auth-github-btn");
const authSignoutBtn = $("auth-signout-btn");
const FIREBASE_JS_VERSION = "10.12.5";
const COUNTRY_DISCOVERY_MEMBER_LIMIT = 3;
const COUNTRY_DISCOVERY_SAMPLE_LIMIT = 10;
const MEMBERSHIP_STATE_VALUES = new Set(["solo", "pending", "member", "owner"]);
let firebaseState = {
  enabled: false,
  initialized: false,
  app: null,
  auth: null,
  db: null,
  user: null,
  userProfile: null,
  sdk: null,
  chatKeys: null,
  bootPromise: null,
};
let countryMenuReload = null;
let mailMenuReload = null;
let redirectResultChecked = false;

function isFirebaseBackendSelected() {
  const select = $("country-backend");
  return !!select && select.value === "firebase";
}
function randomAlphaNum(length) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function maybeName(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  return s.slice(0, 48);
}
function normalizeMembershipState(value) {
  const state = String(value || "").trim().toLowerCase();
  return MEMBERSHIP_STATE_VALUES.has(state) ? state : "";
}
function inferMembershipState(profile) {
  const explicit = normalizeMembershipState(profile && profile.membershipState);
  if (explicit) return explicit;
  if (String((profile && profile.pendingCountryId) || "").trim()) return "pending";
  if (String((profile && profile.countryId) || "").trim()) return "member";
  return "solo";
}
function makeCountryName() {
  const left = ["Amber", "Briar", "Cinder", "Dawn", "Ember", "Frost", "Gloom", "Hearth", "Iron", "Juniper", "Kite", "Lumen", "Moss", "Night", "Oak", "Pine", "Quartz", "Rune", "Silver", "Thorn", "Umber", "Vale", "Wild", "Yarrow", "Zephyr"];
  const right = ["Borough", "Hold", "Roost", "Keep", "March", "Vale", "Harbor", "Crest", "Forge", "Crossing", "Grove", "Hollow", "Spire", "Reach", "Dunes", "Watch"];
  return left[Math.floor(Math.random() * left.length)] + " " + right[Math.floor(Math.random() * right.length)];
}
function shuffleArray(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}
function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let out = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    out += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(out);
}
function base64ToBytes(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function updateAuthUi() {
  const signedIn = !!firebaseState.user;
  const enabled = !!firebaseState.enabled;
  authGoogleBtn.disabled = !enabled;
  authGithubBtn.disabled = !enabled;
  authSignoutBtn.disabled = !enabled || !signedIn;
  if (!enabled) {
    authChip.textContent = "Sign In ▾";
    authStatus.textContent = "Firebase is not configured on this server.";
    authNote.textContent =
      "Set FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID, and FIREBASE_APP_ID, then reload.";
    return;
  }
  if (!signedIn) {
    authChip.textContent = "Sign In ▾";
    authStatus.textContent = "Signed out.";
    authNote.textContent = "Sign in to use Firebase collaboration and cloud friend/code flows.";
    return;
  }
  const profileName = maybeName(firebaseState.userProfile && firebaseState.userProfile.username);
  const display = profileName || maybeName(firebaseState.user.displayName) || "user";
  const code = firebaseState.userProfile && firebaseState.userProfile.friendCode
    ? " · code " + firebaseState.userProfile.friendCode
    : "";
  const state = normalizeMembershipState(firebaseState.userProfile && firebaseState.userProfile.membershipState);
  const stateText = state ? " · " + state : "";
  authChip.textContent = display + " ▾";
  authStatus.textContent = "Signed in as " + display + code + stateText;
  authNote.textContent = "Cloud mode stores usernames, membership/discovery metadata, and encrypted DM payloads.";
}

async function loadFirebaseSdk() {
  if (firebaseState.sdk) return firebaseState.sdk;
  const appMod = await import(
    "https://www.gstatic.com/firebasejs/" + FIREBASE_JS_VERSION + "/firebase-app.js"
  );
  const authMod = await import(
    "https://www.gstatic.com/firebasejs/" + FIREBASE_JS_VERSION + "/firebase-auth.js"
  );
  const storeMod = await import(
    "https://www.gstatic.com/firebasejs/" + FIREBASE_JS_VERSION + "/firebase-firestore.js"
  );
  firebaseState.sdk = {
    app: appMod,
    auth: authMod,
    store: storeMod,
  };
  return firebaseState.sdk;
}

async function ensureFirebaseReady() {
  if (firebaseState.bootPromise) return firebaseState.bootPromise;
  firebaseState.bootPromise = (async () => {
    const configRes = await fetch("/api/firebase/config");
    const cfg = await configRes.json().catch(() => ({ enabled: false, config: null }));
    firebaseState.enabled = !!cfg.enabled && !!cfg.config;
    if (!firebaseState.enabled) {
      updateAuthUi();
      return false;
    }
    const sdk = await loadFirebaseSdk();
    const app = sdk.app.initializeApp(cfg.config);
    const auth = sdk.auth.getAuth(app);
    const db = sdk.store.getFirestore(app);
    try {
      if (sdk.auth.browserLocalPersistence) {
        await sdk.auth.setPersistence(auth, sdk.auth.browserLocalPersistence);
      }
    } catch (err) {
      console.warn("firebase-persistence-setup-failed", err);
    }
    firebaseState.app = app;
    firebaseState.auth = auth;
    firebaseState.db = db;
    sdk.auth.onAuthStateChanged(auth, async (user) => {
      firebaseState.user = user || null;
      firebaseState.chatKeys = null;
      if (firebaseState.user) {
        try {
          await ensureFirebaseProfile(false);
        } catch (err) {
          console.error("firebase-profile-init-failed", err);
        }
      } else {
        firebaseState.userProfile = null;
      }
      updateAuthUi();
      if (countryMenuReload) void countryMenuReload();
      if (mailMenuReload) void mailMenuReload(true);
    });
    if (!redirectResultChecked) {
      redirectResultChecked = true;
      try {
        const redirectResult = await sdk.auth.getRedirectResult(auth);
        if (redirectResult && redirectResult.user) {
          const providerId = (redirectResult.providerId || "provider").replace(".com", "");
          authStatus.textContent = "Redirect sign-in complete (" + providerId + ").";
        }
      } catch (err) {
        const code = err && err.code ? String(err.code) : "";
        const hint = authErrorHint(code);
        authStatus.textContent =
          "Redirect sign-in failed" + (code ? " (" + code + ")" : "") + (hint ? " — " + hint : "");
      }
    }
    firebaseState.initialized = true;
    updateAuthUi();
    return true;
  })().catch((err) => {
    firebaseState.enabled = false;
    firebaseState.initialized = false;
    firebaseState.bootPromise = null;
    updateAuthUi();
    throw err;
  });
  return firebaseState.bootPromise;
}

async function ensureChatKeys() {
  if (!firebaseState.user) return null;
  if (firebaseState.chatKeys) return firebaseState.chatKeys;
  const sdk = firebaseState.sdk;
  if (!sdk) return null;
  const storageKey = "goblintown.chat-ecdh.v1." + firebaseState.user.uid;
  const saved = localStorage.getItem(storageKey);
  let privateKey = null;
  let publicKey = null;
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      privateKey = await crypto.subtle.importKey(
        "jwk",
        parsed.privateJwk,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      publicKey = await crypto.subtle.importKey(
        "jwk",
        parsed.publicJwk,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        [],
      );
      firebaseState.chatKeys = {
        privateKey,
        publicKey,
        publicJwk: parsed.publicJwk,
      };
      return firebaseState.chatKeys;
    } catch {
      localStorage.removeItem(storageKey);
    }
  }
  const generated = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  privateKey = generated.privateKey;
  publicKey = generated.publicKey;
  const privateJwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", publicKey);
  localStorage.setItem(storageKey, JSON.stringify({ privateJwk, publicJwk }));
  firebaseState.chatKeys = { privateKey, publicKey, publicJwk };
  return firebaseState.chatKeys;
}

async function ensureFirebaseProfile(forceRefresh) {
  if (!firebaseState.user || !firebaseState.db || !firebaseState.sdk) return null;
  if (firebaseState.userProfile && !forceRefresh) return firebaseState.userProfile;
  const store = firebaseState.sdk.store;
  const uid = firebaseState.user.uid;
  const ref = store.doc(firebaseState.db, "users", uid);
  const snap = await store.getDoc(ref);
  const usernameFallback = maybeName(firebaseState.user.displayName) || maybeName(INITIAL.warren) || "goblin";
  let profile = null;
  const chatKeys = await ensureChatKeys();
  const publicJwk = chatKeys ? chatKeys.publicJwk : null;
  if (!snap.exists()) {
    profile = {
      uid,
      username: usernameFallback,
      friendCode: randomAlphaNum(6),
      countryId: "",
      countryName: "",
      countryCode: "",
      pendingCountryId: "",
      pendingCountryName: "",
      pendingCountryCode: "",
      membershipState: "solo",
      countryModeEnabled: false,
      chatPublicJwk: publicJwk,
    };
    await store.setDoc(ref, {
      ...profile,
      createdAt: store.serverTimestamp(),
      updatedAt: store.serverTimestamp(),
    });
  } else {
    profile = snap.data();
    const patch = {};
    if (!profile.username) patch.username = usernameFallback;
    if (!profile.friendCode) patch.friendCode = randomAlphaNum(6);
    if (!Object.prototype.hasOwnProperty.call(profile, "countryModeEnabled")) patch.countryModeEnabled = false;
    if (!profile.countryId) patch.countryId = "";
    if (!profile.countryName) patch.countryName = "";
    if (!profile.countryCode) patch.countryCode = "";
    if (typeof profile.pendingCountryId !== "string") patch.pendingCountryId = "";
    if (typeof profile.pendingCountryName !== "string") patch.pendingCountryName = "";
    if (typeof profile.pendingCountryCode !== "string") patch.pendingCountryCode = "";
    const membershipState = inferMembershipState(profile);
    if (normalizeMembershipState(profile.membershipState) !== membershipState) {
      patch.membershipState = membershipState;
    }
    if (publicJwk && JSON.stringify(profile.chatPublicJwk || null) !== JSON.stringify(publicJwk)) {
      patch.chatPublicJwk = publicJwk;
    }
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = store.serverTimestamp();
      await store.updateDoc(ref, patch);
      profile = { ...profile, ...patch };
    }
  }
  profile = {
    ...profile,
    membershipState: inferMembershipState(profile),
    pendingCountryId: String(profile.pendingCountryId || ""),
    pendingCountryName: String(profile.pendingCountryName || ""),
    pendingCountryCode: String(profile.pendingCountryCode || ""),
  };
  firebaseState.userProfile = profile;
  updateAuthUi();
  return profile;
}

async function encryptDmBody(plainText, recipientPublicJwk) {
  if (!recipientPublicJwk) return { mode: "plain", body: plainText };
  const keys = await ensureChatKeys();
  if (!keys) return { mode: "plain", body: plainText };
  const recipientPublicKey = await crypto.subtle.importKey(
    "jwk",
    recipientPublicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipientPublicKey },
    keys.privateKey,
    256,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"],
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode("goblintown-dm-v1"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(plainText),
  );
  return {
    mode: "ecdh-aes-gcm-v1",
    ciphertext: bytesToBase64(new Uint8Array(cipherBuf)),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(salt),
    body: "",
  };
}

async function decryptDmBody(message, senderPublicJwk) {
  if (!message || message.mode !== "ecdh-aes-gcm-v1") return message && message.body ? message.body : "";
  if (!senderPublicJwk) return "[encrypted]";
  const keys = await ensureChatKeys();
  if (!keys) return "[encrypted]";
  try {
    const senderPublicKey = await crypto.subtle.importKey(
      "jwk",
      senderPublicJwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: senderPublicKey },
      keys.privateKey,
      256,
    );
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      sharedBits,
      "HKDF",
      false,
      ["deriveKey"],
    );
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: base64ToBytes(message.salt),
        info: new TextEncoder().encode("goblintown-dm-v1"),
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(message.iv) },
      aesKey,
      base64ToBytes(message.ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return "[encrypted]";
  }
}

authChip.onclick = () => {
  providerPopover.classList.remove("open");
  if (countryPopover) countryPopover.classList.remove("open");
  const mailPanel = document.getElementById("mail-popover");
  if (mailPanel) mailPanel.classList.remove("open");
  authPopover.classList.toggle("open");
};
function authErrorHint(code) {
  if (code === "auth/unauthorized-domain") {
    return "Add localhost to Firebase Auth authorized domains.";
  }
  if (code === "auth/operation-not-allowed") {
    return "Enable this provider in Firebase Authentication > Sign-in method.";
  }
  if (code === "auth/configuration-not-found") {
    return "Firebase Auth is not provisioned. In Firebase Console open Authentication, click Get started, then enable Google/GitHub.";
  }
  if (code === "auth/popup-blocked") {
    return "Allow popups for localhost, or use redirect sign-in fallback.";
  }
  if (code === "auth/popup-closed-by-user") {
    return "Popup closed before completion; trying redirect sign-in may help.";
  }
  if (code === "auth/cancelled-popup-request") {
    return "Another popup was already open. Retry once.";
  }
  if (code === "auth/auth-domain-config-required") {
    return "Auth domain config is missing or invalid.";
  }
  if (code === "auth/network-request-failed") {
    return "Network failure during auth flow.";
  }
  return "";
}
function isPopupHostileRuntime() {
  const ua = (navigator.userAgent || "").toLowerCase();
  return ua.includes("wv") ||
    ua.includes("fban") ||
    ua.includes("fbav") ||
    ua.includes("instagram") ||
    ua.includes("line/") ||
    ua.includes("electron") ||
    ua.includes("codex");
}
async function signInWithProvider(kind) {
  const ready = await ensureFirebaseReady();
  if (!ready || !firebaseState.auth || !firebaseState.sdk) return;
  const provider = kind === "github"
    ? new firebaseState.sdk.auth.GithubAuthProvider()
    : new firebaseState.sdk.auth.GoogleAuthProvider();
  const label = kind === "github" ? "GitHub" : "Google";
  const shouldRedirectFirst = isPopupHostileRuntime() || !firebaseState.initialized;
  if (shouldRedirectFirst) {
    authStatus.textContent = label + " sign-in via redirect...";
    await firebaseState.sdk.auth.signInWithRedirect(firebaseState.auth, provider);
    return;
  }
  try {
    await firebaseState.sdk.auth.signInWithPopup(firebaseState.auth, provider);
    return;
  } catch (err) {
    const code = (err && err.code) ? String(err.code) : "";
    const hint = authErrorHint(code);
    const message = err && err.message ? String(err.message) : "";
    authStatus.textContent = label + " popup failed" + (code ? " (" + code + ")" : "") +
      (hint ? " — " + hint : "");
    if (message && !code) authStatus.textContent += " — " + message;
    const fatal = new Set([
      "auth/unauthorized-domain",
      "auth/operation-not-allowed",
      "auth/auth-domain-config-required",
    ]);
    if (!fatal.has(code)) {
      authStatus.textContent += " Redirecting...";
      await firebaseState.sdk.auth.signInWithRedirect(firebaseState.auth, provider);
      return;
    }
  }
}
authGoogleBtn.onclick = () => signInWithProvider("google");
authGithubBtn.onclick = () => signInWithProvider("github");
authSignoutBtn.onclick = async () => {
  try {
    if (!firebaseState.auth || !firebaseState.sdk) return;
    await firebaseState.sdk.auth.signOut(firebaseState.auth);
  } catch (err) {
    authStatus.textContent = "Sign-out failed: " + (err.message || err);
  }
};
updateAuthUi();
void ensureFirebaseReady().catch((err) => {
  authStatus.textContent = "Firebase init failed: " + (err && err.message ? err.message : String(err));
});

/* Country / team menu */
try {
let countryData = null;
let countryPeers = [];
let countryRoles = [];
let countryMembers = [];
let countryMaxMembers = 6;
let countryDiscover = [];
const countryChip = $("country-chip");
countryPopover = $("country-popover");
const countrySummary = $("country-summary");
const countryNameEl = $("country-name");
const countryCodeEl = $("country-code");
const countryEnabled = $("country-enabled");
const countryRequestsEl = $("country-requests");
const countryQueueEl = $("country-queue");
const countryJoinListEl = $("country-join-list");
const countryMembersEl = $("country-members");
const countryRoleTable = $("country-role-table");
const countryAutoLead = $("country-auto-lead");
const countryStatus = $("country-status");
const countryBackendSelect = $("country-backend");
const countryTabButtons = [...document.querySelectorAll("[data-country-tab]")];
const countryPanels = [...document.querySelectorAll("[data-country-panel]")];

function canonicalName(s) { return (s || "").trim().toLowerCase(); }
function escHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderCountryMembers() {
  countryMembersEl.innerHTML = "";
  for (const m of countryMembers) {
    const row = document.createElement("div");
    row.className = "country-member";
    const dot = '<span class="country-dot ' + (m.online ? "online" : "") + " " + (m.hasMail ? "mail" : "") + '"></span>';
    const badge = (m.online ? "online" : "offline") + (m.hasMail ? " • mail" : "");
    row.innerHTML =
      '<span>' + dot + escHtml(m.name) + (m.url ? ' <span class="muted">(' + escHtml(m.url) + ')</span>' : "") + "</span>" +
      '<span class="lead">' + (m.lead ? "lead" : badge) + "</span><span></span>";
    countryMembersEl.appendChild(row);
  }
}

function rebuildCountryMembers() {
  const lead = countryData?.lead || "lead";
  const byName = new Map((countryData?.members || []).map((m) => [canonicalName(m.name), m]));
  const leadKnown = byName.get(canonicalName(lead));
  countryMembers = [{
    name: lead,
    lead: true,
    online: leadKnown ? !!leadKnown.online : true,
    hasMail: leadKnown ? !!leadKnown.hasMail : false,
  }];
  countryPeers.forEach((p) => {
    const known = byName.get(canonicalName(p.name));
    countryMembers.push({
      name: p.name,
      url: p.url,
      lead: false,
      online: known ? !!known.online : false,
      hasMail: known ? !!known.hasMail : false,
    });
  });
  const count = countryMembers.length;
  countrySummary.textContent =
    count + "/" + countryMaxMembers + " members · " +
    countryMembers.filter((m) => m.online).length + " online · queue " +
    ((countryData?.riteQueue || []).length || 0);
  countryChip.textContent = "Country " + count + "/" + countryMaxMembers + " ▾";
}

function currentRoleOwners() {
  const owners = {};
  countryRoles.forEach((role) => {
    const checked = countryRoleTable.querySelector('input[type="checkbox"][data-role="' + role + '"]:checked');
    if (checked) owners[role] = checked.getAttribute("data-member");
  });
  return owners;
}

function renderCountryRoleTable() {
  const owners = countryData?.config?.roleOwners || {};
  let html = "<thead><tr><th>Role</th>";
  for (const m of countryMembers) {
    html += '<th class="' + (m.lead ? "member-lead" : "") + '">' + escHtml(m.name) + "</th>";
  }
  html += "</tr></thead><tbody>";
  for (const role of countryRoles) {
    html += "<tr><td>" + escHtml(role) + "</td>";
    for (const m of countryMembers) {
      const checked = canonicalName(owners[role]) === canonicalName(m.name);
      const tip = "Assign " + role + " to " + m.name + ".";
      html += '<td><input type="checkbox" data-role="' + escHtml(role) + '" data-member="' + escHtml(m.name) + '" data-tip="' + escHtml(tip) + '"' + (checked ? " checked" : "") + "></td>";
    }
    html += "</tr>";
  }
  html += "</tbody>";
  countryRoleTable.innerHTML = html;
  countryRoleTable.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.onchange = () => {
      if (!cb.checked) return;
      const role = cb.getAttribute("data-role");
      countryRoleTable
        .querySelectorAll('input[type="checkbox"][data-role="' + role + '"]')
        .forEach((other) => {
          if (other !== cb) other.checked = false;
        });
    };
  });
}

function renderCountryQueue() {
  const queue = countryData?.riteQueue || [];
  if (!queue.length) {
    countryQueueEl.innerHTML = '<div class="country-member"><span class="muted">No queued rites.</span><span></span><span></span></div>';
    return;
  }
  countryQueueEl.innerHTML = queue
    .slice()
    .reverse()
    .map((q) =>
      '<div class="country-member"><span>' + escHtml(q.mode.toUpperCase()) + " · " + escHtml(q.task) +
      '</span><span class="lead">' + new Date(q.createdAt).toLocaleTimeString() + "</span><span></span></div>")
    .join("");
}

function renderPendingJoinRequests() {
  const list = countryData?.pendingJoinRequests || [];
  if (!list.length) {
    countryRequestsEl.innerHTML = '<div class="country-member"><span class="muted">No pending requests.</span><span></span><span></span></div>';
    return;
  }
  countryRequestsEl.innerHTML = list.map((r) =>
    '<div class="country-member">' +
      '<span>' + escHtml(r.fromName) + ' <span class="muted">(' + escHtml(r.fromUrl) + ")</span></span>" +
      '<span class="lead">' + new Date(r.createdAt).toLocaleTimeString() + "</span>" +
      '<span>' +
        '<button class="btn" data-join-approve="' + escHtml(r.id) + '" type="button" data-tip="Approve this join request">Approve</button> ' +
        '<button class="btn" data-join-deny="' + escHtml(r.id) + '" type="button" data-tip="Reject this join request">Deny</button>' +
      "</span>" +
    "</div>"
  ).join("");
  countryRequestsEl.querySelectorAll("button[data-join-approve]").forEach((btn) => {
    btn.onclick = () => resolveJoinRequest(btn.getAttribute("data-join-approve"), true);
  });
  countryRequestsEl.querySelectorAll("button[data-join-deny]").forEach((btn) => {
    btn.onclick = () => resolveJoinRequest(btn.getAttribute("data-join-deny"), false);
  });
}

function renderJoinList(list) {
  if (!list.length) {
    countryJoinListEl.innerHTML = '<div class="country-member"><span class="muted">No open countries found.</span><span></span><span></span></div>';
    return;
  }
  countryJoinListEl.innerHTML = list.map((c) =>
    '<div class="country-member">' +
      '<span><strong>' + escHtml(c.countryName) + '</strong> <span class="muted">[' + escHtml(c.countryCode) + ']</span></span>' +
      '<span class="lead">' + c.memberCount + "/6</span>" +
      '<span><button class="btn" data-join-country="' + escHtml(c.countryId) + '" type="button" data-tip="Send a join request to this country">Join</button></span>' +
    "</div>"
  ).join("");
  countryJoinListEl.querySelectorAll("button[data-join-country]").forEach((btn) => {
    btn.onclick = () => requestJoinCountry(btn.getAttribute("data-join-country"));
  });
}

function applyCountryPayload(payload) {
  countryData = payload || {};
  countryPeers = [...(payload.peers || [])];
  countryNameEl.textContent = payload.countryName || "-";
  countryCodeEl.textContent = payload.countryCode || "-";
  countryEnabled.checked = payload.modeEnabled === true;
  if (countryBackendSelect && payload.collabBackend) {
    countryBackendSelect.value = payload.collabBackend;
  }
  countryRoles = payload.roles || [];
  countryMaxMembers = payload.maxMembers || 6;
  countryAutoLead.checked = payload.config?.autoAssignLeadExtras !== false;
  rebuildCountryMembers();
  renderCountryMembers();
  renderPendingJoinRequests();
  renderCountryQueue();
  renderCountryRoleTable();
  countryStatus.textContent = "";
}

countryEnabled.onchange = () => {
  countryStatus.textContent = "Country mode " + (countryEnabled.checked ? "enabled" : "disabled") + ". Save to persist.";
};

function setCountryTab(tab) {
  const selected = tab || "overview";
  countryTabButtons.forEach((btn) => {
    const active = btn.getAttribute("data-country-tab") === selected;
    btn.classList.toggle("active", active);
  });
  countryPanels.forEach((panel) => {
    const active = panel.getAttribute("data-country-panel") === selected;
    panel.classList.toggle("active", active);
  });
}
countryTabButtons.forEach((btn) => {
  btn.onclick = () => setCountryTab(btn.getAttribute("data-country-tab") || "overview");
});

async function loadCountryMenuLocal() {
  const countryRes = await fetch("/api/country");
  if (!countryRes.ok) throw new Error(await countryRes.text());
  const payload = await countryRes.json();
  applyCountryPayload(payload);
}

async function loadCountryMenuFirebase() {
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user) throw new Error("Sign in to use Firebase country mode.");
  if (!firebaseState.sdk || !firebaseState.db) throw new Error("Firebase SDK not ready.");
  const store = firebaseState.sdk.store;
  let profile = await ensureFirebaseProfile(true);
  const localRes = await fetch("/api/country");
  if (!localRes.ok) throw new Error(await localRes.text());
  const localPayload = await localRes.json();
  const uid = firebaseState.user.uid;

  if (!profile.countryId) {
    const approvedQ = store.query(
      store.collection(firebaseState.db, "countryJoinRequests"),
      store.where("fromUid", "==", uid),
      store.where("status", "==", "approved"),
      store.orderBy("resolvedAt", "desc"),
      store.limit(1),
    );
    const approvedRows = await store.getDocs(approvedQ);
    if (!approvedRows.empty) {
      const row = approvedRows.docs[0].data();
      if (row.countryId && row.countryName && row.countryCode) {
        await store.updateDoc(
          store.doc(firebaseState.db, "users", uid),
          {
            countryId: row.countryId,
            countryName: row.countryName,
            countryCode: row.countryCode,
            pendingCountryId: "",
            pendingCountryName: "",
            pendingCountryCode: "",
            membershipState: "member",
            updatedAt: store.serverTimestamp(),
          },
        );
        profile = await ensureFirebaseProfile(true);
      }
    }
  }

  let members = [{
    name: profile.username || maybeName(firebaseState.user.displayName) || localPayload.lead || "lead",
    lead: true,
    online: true,
    hasMail: false,
  }];
  let pendingJoinRequests = [];
  let queue = [];
  let ownerUid = uid;
  let roleOwners = localPayload.config?.roleOwners || {};
  let autoAssignLeadExtras = localPayload.config?.autoAssignLeadExtras !== false;
  let countryName = profile.countryName || "";
  let countryCode = profile.countryCode || "";
  let countryId = profile.countryId || "";
  let membershipState = inferMembershipState(profile);
  let discoverable = true;

  if (countryId) {
    const countryRef = store.doc(firebaseState.db, "countries", countryId);
    const countrySnap = await store.getDoc(countryRef);
    if (countrySnap.exists()) {
      const c = countrySnap.data();
      ownerUid = c.ownerUid || ownerUid;
      countryName = c.countryName || countryName;
      countryCode = c.countryCode || countryCode;
      discoverable = c.discoverable !== false;
      roleOwners = c.roleOwners || roleOwners;
      autoAssignLeadExtras = c.autoAssignLeadExtras !== false;
      queue = Array.isArray(c.riteQueue) ? c.riteQueue : [];
      membershipState = ownerUid === uid ? "owner" : "member";
    }
    const memberSnap = await store.getDocs(
      store.query(
        store.collection(firebaseState.db, "countries", countryId, "members"),
        store.orderBy("joinedAt", "asc"),
        store.limit(12),
      ),
    );
    if (!memberSnap.empty) {
      members = memberSnap.docs.map((d) => {
        const row = d.data();
        const isLead = row.uid === ownerUid;
        return {
          name: row.username || row.uid,
          lead: isLead,
          online: true,
          hasMail: false,
          uid: row.uid,
        };
      });
    }
    const pendingSnap = await store.getDocs(
      store.query(
        store.collection(firebaseState.db, "countryJoinRequests"),
        store.where("countryId", "==", countryId),
        store.where("status", "==", "pending"),
        store.where("toOwnerUid", "==", uid),
        store.orderBy("createdAt", "desc"),
        store.limit(20),
      ),
    );
    pendingJoinRequests = pendingSnap.docs.map((d) => {
      const row = d.data();
      return {
        id: d.id,
        countryId: row.countryId,
        countryCode: row.countryCode,
        fromName: row.fromName || row.fromUid || "member",
        fromUrl: row.fromCode ? ("code:" + row.fromCode) : "firebase",
        fromPublicKey: row.fromUid || "",
        createdAt: row.createdAt && row.createdAt.toDate ? row.createdAt.toDate().toISOString() : new Date().toISOString(),
        signature: "firebase",
      };
    });
  }
  if (!countryId && membershipState !== "pending") {
    membershipState = "solo";
  }
  const membershipPatch = {};
  if (normalizeMembershipState(profile.membershipState) !== membershipState) {
    membershipPatch.membershipState = membershipState;
  }
  if (membershipState !== "pending") {
    const pendingId = String(profile.pendingCountryId || "");
    const pendingName = String(profile.pendingCountryName || "");
    const pendingCode = String(profile.pendingCountryCode || "");
    if (pendingId || pendingName || pendingCode) {
      membershipPatch.pendingCountryId = "";
      membershipPatch.pendingCountryName = "";
      membershipPatch.pendingCountryCode = "";
    }
  }
  if (Object.keys(membershipPatch).length > 0) {
    membershipPatch.updatedAt = store.serverTimestamp();
    await store.updateDoc(store.doc(firebaseState.db, "users", uid), membershipPatch);
    profile = await ensureFirebaseProfile(true);
  }

  const lead = members.find((m) => m.lead) || members[0];
  const peers = members
    .filter((m) => m.name !== lead.name)
    .map((m) => ({ name: m.name, url: "" }));
  const modeEnabled = profile.countryModeEnabled === true;
  applyCountryPayload({
    ...localPayload,
    collabBackend: "firebase",
    modeEnabled,
    countryId,
    countryName,
    countryCode,
    discoverable,
    lead: lead ? lead.name : localPayload.lead,
    members,
    peers,
    pendingJoinRequests,
    riteQueue: queue,
    config: {
      autoAssignLeadExtras,
      roleOwners,
    },
  });
}

async function loadCountryMenu() {
  try {
    if (isFirebaseBackendSelected()) {
      await loadCountryMenuFirebase();
      return;
    }
    await loadCountryMenuLocal();
  } catch (err) {
    countrySummary.textContent = "Team menu unavailable.";
    countryStatus.textContent = String(err && err.message ? err.message : err);
  }
}

async function loadCountryDiscoverLocal(code) {
  const q = code ? ("?code=" + encodeURIComponent(code)) : "";
  const r = await fetch("/api/country/discover" + q);
  if (!r.ok) throw new Error(await r.text());
  const d = await r.json();
  countryDiscover = d.countries || [];
  renderJoinList(code ? countryDiscover : (d.randomOpen || []));
}

async function loadCountryDiscoverFirebase(code) {
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user || !firebaseState.sdk || !firebaseState.db) {
    throw new Error("Sign in to discover countries.");
  }
  await ensureFirebaseProfile(false);
  const store = firebaseState.sdk.store;
  let rows = [];
  if (code) {
    const byCode = await store.getDocs(
      store.query(
        store.collection(firebaseState.db, "countries"),
        store.where("countryCode", "==", code),
        store.limit(10),
      ),
    );
    rows = byCode.docs;
  } else {
    const openRows = await store.getDocs(
      store.query(
        store.collection(firebaseState.db, "countries"),
        store.where("discoverable", "==", true),
        store.limit(100),
      ),
    );
    rows = openRows.docs;
  }
  const mapped = rows.map((d) => {
    const row = d.data();
    return {
      source: "firebase",
      countryId: d.id,
      countryName: row.countryName || "Unnamed Country",
      countryCode: row.countryCode || "",
      memberCount: Number(row.memberCount || 0),
      discoverable: row.discoverable !== false,
      leadName: row.ownerName || "lead",
      ownerUid: row.ownerUid || "",
      targetUrl: "",
    };
  }).filter((c) => c.discoverable && c.memberCount <= COUNTRY_DISCOVERY_MEMBER_LIMIT);
  countryDiscover = mapped;
  if (code) {
    renderJoinList(mapped);
  } else {
    renderJoinList(shuffleArray(mapped).slice(0, COUNTRY_DISCOVERY_SAMPLE_LIMIT));
  }
}

async function loadCountryDiscover(code) {
  if (isFirebaseBackendSelected()) {
    await loadCountryDiscoverFirebase(code);
    return;
  }
  await loadCountryDiscoverLocal(code);
}

countryChip.onclick = () => {
  const authPanel = document.getElementById("auth-popover");
  if (authPanel) authPanel.classList.remove("open");
  providerPopover.classList.remove("open");
  const mailPanel = document.getElementById("mail-popover");
  if (mailPanel) mailPanel.classList.remove("open");
  const willOpen = !countryPopover.classList.contains("open");
  countryPopover.classList.toggle("open");
  if (willOpen) {
    setCountryTab("overview");
    countryStatus.textContent = "Loading countries...";
    loadCountryDiscover("")
      .then(() => { countryStatus.textContent = ""; })
      .catch((err) => {
        countryStatus.textContent = "Discovery failed: " + (err.message || err);
      });
  }
};
async function requestJoinCountry(countryId) {
  if (isFirebaseBackendSelected()) {
    await requestJoinCountryFirebase(countryId);
    return;
  }
  const target = (countryDiscover || []).find((c) => c.countryId === countryId);
  if (!target) {
    countryStatus.textContent = "Country not available.";
    return;
  }
  if (!target.targetUrl) {
    countryStatus.textContent = "Country leader URL unavailable.";
    return;
  }
  countryStatus.textContent = "Sending join request...";
  try {
    const r = await fetch("/api/country/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetUrl: target.targetUrl,
        countryId: target.countryId,
        countryCode: target.countryCode,
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    countryStatus.textContent = "Join request sent: " + (data.requestId || "?");
  } catch (err) {
    countryStatus.textContent = "Join failed: " + (err.message || err);
  }
}

async function requestJoinCountryFirebase(countryId) {
  const target = (countryDiscover || []).find((c) => c.countryId === countryId);
  if (!target) {
    countryStatus.textContent = "Country not available.";
    return;
  }
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user || !firebaseState.sdk || !firebaseState.db) {
    throw new Error("Sign in before joining a country.");
  }
  const profile = await ensureFirebaseProfile(false);
  if (profile.countryId) {
    countryStatus.textContent = "Leave current country before joining another.";
    return;
  }
  if (!target.ownerUid) {
    countryStatus.textContent = "Country owner unavailable.";
    return;
  }
  const store = firebaseState.sdk.store;
  const dupe = await store.getDocs(
    store.query(
      store.collection(firebaseState.db, "countryJoinRequests"),
      store.where("countryId", "==", target.countryId),
      store.where("fromUid", "==", firebaseState.user.uid),
      store.where("status", "==", "pending"),
      store.limit(1),
    ),
  );
  if (!dupe.empty) {
    countryStatus.textContent = "Join request already pending.";
    return;
  }
  await store.addDoc(
    store.collection(firebaseState.db, "countryJoinRequests"),
    {
      countryId: target.countryId,
      countryCode: target.countryCode || "",
      countryName: target.countryName || "",
      toOwnerUid: target.ownerUid,
      fromUid: firebaseState.user.uid,
      fromName: profile.username || maybeName(firebaseState.user.displayName) || "member",
      fromCode: profile.friendCode || "",
      status: "pending",
      createdAt: store.serverTimestamp(),
      resolvedAt: null,
    },
  );
  await store.updateDoc(store.doc(firebaseState.db, "users", firebaseState.user.uid), {
    membershipState: "pending",
    pendingCountryId: target.countryId || "",
    pendingCountryName: target.countryName || "",
    pendingCountryCode: target.countryCode || "",
    updatedAt: store.serverTimestamp(),
  });
  await ensureFirebaseProfile(true);
  countryStatus.textContent = "Join request sent.";
}

async function resolveJoinRequest(requestId, approve) {
  if (isFirebaseBackendSelected()) {
    await resolveJoinRequestFirebase(requestId, approve);
    return;
  }
  if (!requestId) return;
  countryStatus.textContent = approve ? "Approving..." : "Denying...";
  try {
    const r = await fetch("/api/country/join-approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, approve }),
    });
    if (!r.ok) throw new Error(await r.text());
    const payload = await r.json();
    applyCountryPayload(payload);
    if (approve && payload.delivery && payload.delivery.delivered === false) {
      countryStatus.textContent =
        "Approved locally, callback failed: " + (payload.delivery.error || "unknown");
      return;
    }
    countryStatus.textContent = approve ? "Request approved." : "Request denied.";
  } catch (err) {
    countryStatus.textContent = "Request failed: " + (err.message || err);
  }
}

async function resolveJoinRequestFirebase(requestId, approve) {
  if (!requestId) return;
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user || !firebaseState.sdk || !firebaseState.db) {
    throw new Error("Sign in before resolving requests.");
  }
  const store = firebaseState.sdk.store;
  const db = firebaseState.db;
  const uid = firebaseState.user.uid;
  const requestRef = store.doc(db, "countryJoinRequests", requestId);
  countryStatus.textContent = approve ? "Approving..." : "Denying...";
  if (!approve) {
    const reqSnap = await store.getDoc(requestRef);
    const reqRow = reqSnap.exists() ? reqSnap.data() : null;
    await store.updateDoc(requestRef, {
      status: "denied",
      resolvedAt: store.serverTimestamp(),
      resolvedBy: uid,
    });
    if (reqRow && reqRow.fromUid) {
      const requesterRef = store.doc(db, "users", reqRow.fromUid);
      const requesterSnap = await store.getDoc(requesterRef);
      if (requesterSnap.exists()) {
        const requester = requesterSnap.data();
        const pendingCountryId = String(requester.pendingCountryId || "");
        if (pendingCountryId && pendingCountryId === String(reqRow.countryId || "")) {
          await store.updateDoc(requesterRef, {
            membershipState: requester.countryId ? "member" : "solo",
            pendingCountryId: "",
            pendingCountryName: "",
            pendingCountryCode: "",
            updatedAt: store.serverTimestamp(),
          });
        }
      }
    }
    await loadCountryMenu();
    countryStatus.textContent = "Request denied.";
    return;
  }
  await store.runTransaction(db, async (tx) => {
    const reqSnap = await tx.get(requestRef);
    if (!reqSnap.exists()) throw new Error("request not found");
    const reqRow = reqSnap.data();
    if (reqRow.status !== "pending") throw new Error("request already resolved");
    if (reqRow.toOwnerUid !== uid) throw new Error("only country owner can approve");
    const countryRef = store.doc(db, "countries", reqRow.countryId);
    const countrySnap = await tx.get(countryRef);
    if (!countrySnap.exists()) throw new Error("country not found");
    const country = countrySnap.data();
    const memberCount = Number(country.memberCount || 0);
    if (memberCount >= 6) throw new Error("team full");
    const memberRef = store.doc(db, "countries", reqRow.countryId, "members", reqRow.fromUid);
    tx.set(memberRef, {
      uid: reqRow.fromUid,
      username: reqRow.fromName || reqRow.fromUid,
      friendCode: reqRow.fromCode || "",
      joinedAt: store.serverTimestamp(),
    }, { merge: true });
    tx.update(countryRef, {
      memberCount: store.increment(1),
      updatedAt: store.serverTimestamp(),
    });
    tx.update(store.doc(db, "users", reqRow.fromUid), {
      countryId: reqRow.countryId,
      countryName: reqRow.countryName || country.countryName || "",
      countryCode: reqRow.countryCode || country.countryCode || "",
      membershipState: "member",
      pendingCountryId: "",
      pendingCountryName: "",
      pendingCountryCode: "",
      countryModeEnabled: true,
      updatedAt: store.serverTimestamp(),
    });
    tx.update(requestRef, {
      status: "approved",
      resolvedAt: store.serverTimestamp(),
      resolvedBy: uid,
    });
    const ownProfile = firebaseState.userProfile || {};
    const myFriendRef = store.doc(db, "users", uid, "friends", reqRow.fromUid);
    const theirFriendRef = store.doc(db, "users", reqRow.fromUid, "friends", uid);
    tx.set(myFriendRef, {
      id: reqRow.fromUid,
      name: reqRow.fromName || reqRow.fromUid,
      friendCode: reqRow.fromCode || "",
      createdAt: store.serverTimestamp(),
    }, { merge: true });
    tx.set(theirFriendRef, {
      id: uid,
      name: ownProfile.username || maybeName(firebaseState.user.displayName) || "lead",
      friendCode: ownProfile.friendCode || "",
      createdAt: store.serverTimestamp(),
    }, { merge: true });
  });
  await loadCountryMenu();
  countryStatus.textContent = "Request approved.";
}
$("country-search-btn").onclick = async () => {
  const code = ($("country-search-code").value || "").trim().toUpperCase();
  setCountryTab("join");
  countryStatus.textContent = code ? "Searching..." : "Loading countries...";
  try {
    await loadCountryDiscover(code);
    countryStatus.textContent = "";
  } catch (err) {
    countryStatus.textContent = "Search failed: " + (err.message || err);
  }
};
$("country-search-code").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    $("country-search-btn").click();
  }
});
$("country-save").onclick = async () => {
  countryStatus.textContent = "Saving...";
  try {
    if (isFirebaseBackendSelected()) {
      await saveCountryFirebase();
    } else {
      const payload = {
        peers: countryPeers,
        enabled: countryEnabled.checked,
        countryId: countryData?.countryId,
        countryName: countryData?.countryName,
        countryCode: countryData?.countryCode,
        autoAssignLeadExtras: countryAutoLead.checked,
        roleOwners: currentRoleOwners(),
        collabBackend: "local",
      };
      const r = await fetch("/api/country", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await r.text());
      applyCountryPayload(await r.json());
    }
    countryPopover.classList.remove("open");
    setTicker("team policy saved");
  } catch (err) {
    countryStatus.textContent = "Save failed: " + (err.message || err);
  }
};

async function saveCountryFirebase() {
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user || !firebaseState.sdk || !firebaseState.db) {
    throw new Error("Sign in before saving country mode.");
  }
  const store = firebaseState.sdk.store;
  const db = firebaseState.db;
  const uid = firebaseState.user.uid;
  let profile = await ensureFirebaseProfile(false);
  const roleOwners = currentRoleOwners();
  const localSync = await fetch("/api/country", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: countryEnabled.checked,
      collabBackend: "firebase",
      autoAssignLeadExtras: countryAutoLead.checked,
      roleOwners,
    }),
  });
  if (!localSync.ok) throw new Error(await localSync.text());
  if (!countryEnabled.checked) {
    await store.updateDoc(store.doc(db, "users", uid), {
      countryModeEnabled: false,
      updatedAt: store.serverTimestamp(),
    });
    await ensureFirebaseProfile(true);
    await loadCountryMenu();
    return;
  }
  if (!profile.countryId) {
    const countryName = makeCountryName();
    let countryCode = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = randomAlphaNum(5);
      const existing = await store.getDocs(
        store.query(
          store.collection(db, "countries"),
          store.where("countryCode", "==", candidate),
          store.limit(1),
        ),
      );
      if (existing.empty) {
        countryCode = candidate;
        break;
      }
    }
    if (!countryCode) countryCode = randomAlphaNum(5);
    const countryRef = store.doc(store.collection(db, "countries"));
    await store.setDoc(countryRef, {
      countryName,
      countryCode,
      ownerUid: uid,
      ownerName: profile.username || maybeName(firebaseState.user.displayName) || "lead",
      discoverable: true,
      memberCount: 1,
      autoAssignLeadExtras: countryAutoLead.checked,
      roleOwners,
      riteQueue: [],
      createdAt: store.serverTimestamp(),
      updatedAt: store.serverTimestamp(),
    });
    await store.setDoc(
      store.doc(db, "countries", countryRef.id, "members", uid),
      {
        uid,
        username: profile.username || maybeName(firebaseState.user.displayName) || "lead",
        friendCode: profile.friendCode || "",
        joinedAt: store.serverTimestamp(),
      },
    );
    await store.updateDoc(store.doc(db, "users", uid), {
      countryId: countryRef.id,
      countryName,
      countryCode,
      membershipState: "owner",
      pendingCountryId: "",
      pendingCountryName: "",
      pendingCountryCode: "",
      countryModeEnabled: true,
      updatedAt: store.serverTimestamp(),
    });
  } else {
    const countryRef = store.doc(db, "countries", profile.countryId);
    let membershipState = "member";
    const countrySnap = await store.getDoc(countryRef);
    if (countrySnap.exists()) {
      const country = countrySnap.data();
      if (country.ownerUid === uid) {
        membershipState = "owner";
        await store.updateDoc(countryRef, {
          autoAssignLeadExtras: countryAutoLead.checked,
          roleOwners,
          updatedAt: store.serverTimestamp(),
        });
      }
    }
    await store.updateDoc(store.doc(db, "users", uid), {
      membershipState,
      pendingCountryId: "",
      pendingCountryName: "",
      pendingCountryCode: "",
      countryModeEnabled: true,
      updatedAt: store.serverTimestamp(),
    });
  }
  profile = await ensureFirebaseProfile(true);
  await loadCountryMenu();
}

if (countryBackendSelect) {
  countryBackendSelect.onchange = () => {
    const mode = countryBackendSelect.value === "firebase" ? "Firebase" : "Local";
    countryStatus.textContent = "Backend set to " + mode + ". Save to persist.";
    void loadCountryMenu();
  };
}

countryMenuReload = loadCountryMenu;

loadCountryMenu();
} catch (err) {
  console.error("country-ui-init-failed", err);
}

/* Friends + Mail */
try {
let socialState = { friends: [], pendingRequests: [], threads: [] };
let activeThreadId = "";
let activeFriendId = "";
let activeThreadFriendName = "";
const mailChip = $("mail-chip");
const mailPopover = $("mail-popover");
const mailSummary = $("mail-summary");
const mailStatus = $("mail-status");
const friendsListEl = $("friends-list");
const friendRequestsListEl = $("friend-requests-list");
const threadsListEl = $("dm-threads-list");
const messagesListEl = $("dm-messages-list");

function socialEsc(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setMailStatus(msg) {
  mailStatus.textContent = msg || "";
}

function threadIdForUsers(a, b) {
  return [String(a || ""), String(b || "")].sort().join("__");
}

function toIso(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === "string") return value;
  if (value.toDate) return value.toDate().toISOString();
  return new Date().toISOString();
}

async function loadMailStateLocal(silent) {
  const r = await fetch("/api/friends");
  if (!r.ok) throw new Error(await r.text());
  applyMailState(await r.json());
  if (!silent) setMailStatus("");
}

async function loadMailStateFirebase(silent) {
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user || !firebaseState.sdk || !firebaseState.db) {
    throw new Error("Sign in to use cloud friends and mail.");
  }
  const store = firebaseState.sdk.store;
  const db = firebaseState.db;
  const uid = firebaseState.user.uid;
  await ensureFirebaseProfile(true);
  const friendsSnap = await store.getDocs(
    store.query(
      store.collection(db, "users", uid, "friends"),
      store.limit(200),
    ),
  );
  const friends = friendsSnap.docs.map((d) => {
    const row = d.data();
    return {
      id: d.id,
      name: row.name || d.id,
      friendCode: row.friendCode || "",
      chatPublicJwk: row.chatPublicJwk || null,
      createdAt: toIso(row.createdAt),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const friendById = new Map(friends.map((f) => [f.id, f]));

  const reqSnap = await store.getDocs(
    store.query(
      store.collection(db, "friendRequests"),
      store.where("toUid", "==", uid),
      store.where("status", "==", "pending"),
      store.orderBy("createdAt", "desc"),
      store.limit(100),
    ),
  );
  const pendingRequests = reqSnap.docs.map((d) => {
    const row = d.data();
    return {
      id: d.id,
      fromName: row.fromName || row.fromUid || "member",
      fromUrl: row.fromCode ? ("code:" + row.fromCode) : "firebase",
      fromUid: row.fromUid || "",
      fromCode: row.fromCode || "",
      fromChatPublicJwk: row.fromChatPublicJwk || null,
      createdAt: toIso(row.createdAt),
    };
  });

  const threadsSnap = await store.getDocs(
    store.query(
      store.collection(db, "threads"),
      store.where("participants", "array-contains", uid),
      store.limit(300),
    ),
  );
  const threads = threadsSnap.docs.map((d) => {
    const row = d.data();
    const participants = Array.isArray(row.participants) ? row.participants : [];
    const friendId = participants.find((id) => id !== uid) || "";
    const friend = friendById.get(friendId);
    const unread = row.unreadBy && typeof row.unreadBy[uid] === "number" ? row.unreadBy[uid] : 0;
    return {
      id: d.id,
      friendId,
      friendName: friend ? friend.name : (row.friendNames && row.friendNames[friendId]) || "unknown",
      lastMessagePreview: row.lastMessagePreview || "Encrypted message",
      unread,
      updatedAt: toIso(row.updatedAt),
    };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  applyMailState({ friends, pendingRequests, threads });
  if (!silent) setMailStatus("");
}

async function firebaseSendFriendRequestByCode(code) {
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user || !firebaseState.sdk || !firebaseState.db) {
    throw new Error("Sign in before sending a friend request.");
  }
  const store = firebaseState.sdk.store;
  const db = firebaseState.db;
  const uid = firebaseState.user.uid;
  const profile = await ensureFirebaseProfile(false);
  const byCode = await store.getDocs(
    store.query(
      store.collection(db, "users"),
      store.where("friendCode", "==", code),
      store.limit(1),
    ),
  );
  if (byCode.empty) throw new Error("No user found for that code.");
  const targetDoc = byCode.docs[0];
  if (targetDoc.id === uid) throw new Error("That is your own code.");
  const target = targetDoc.data();
  const existing = await store.getDocs(
    store.query(
      store.collection(db, "friendRequests"),
      store.where("fromUid", "==", uid),
      store.where("toUid", "==", targetDoc.id),
      store.where("status", "==", "pending"),
      store.limit(1),
    ),
  );
  if (!existing.empty) throw new Error("Request already pending.");
  const reverse = await store.getDocs(
    store.query(
      store.collection(db, "friendRequests"),
      store.where("fromUid", "==", targetDoc.id),
      store.where("toUid", "==", uid),
      store.where("status", "==", "pending"),
      store.limit(1),
    ),
  );
  if (!reverse.empty) throw new Error("They already sent you a request. Approve it from pending requests.");
  await store.addDoc(
    store.collection(db, "friendRequests"),
    {
      fromUid: uid,
      fromName: profile.username || maybeName(firebaseState.user.displayName) || "member",
      fromCode: profile.friendCode || "",
      fromChatPublicJwk: profile.chatPublicJwk || null,
      toUid: targetDoc.id,
      toName: target.username || "member",
      status: "pending",
      createdAt: store.serverTimestamp(),
      resolvedAt: null,
    },
  );
}

async function firebaseRespondFriendRequest(requestId, approve) {
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user || !firebaseState.sdk || !firebaseState.db) {
    throw new Error("Sign in before responding.");
  }
  const store = firebaseState.sdk.store;
  const db = firebaseState.db;
  const uid = firebaseState.user.uid;
  const ownProfile = await ensureFirebaseProfile(false);
  const reqRef = store.doc(db, "friendRequests", requestId);
  if (!approve) {
    await store.updateDoc(reqRef, {
      status: "denied",
      resolvedAt: store.serverTimestamp(),
      resolvedBy: uid,
    });
    return;
  }
  await store.runTransaction(db, async (tx) => {
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists()) throw new Error("Request not found.");
    const req = reqSnap.data();
    if (req.status !== "pending") throw new Error("Request already resolved.");
    if (req.toUid !== uid) throw new Error("Request recipient mismatch.");
    const friendRefA = store.doc(db, "users", uid, "friends", req.fromUid);
    const friendRefB = store.doc(db, "users", req.fromUid, "friends", uid);
    tx.set(friendRefA, {
      id: req.fromUid,
      name: req.fromName || req.fromUid,
      friendCode: req.fromCode || "",
      chatPublicJwk: req.fromChatPublicJwk || null,
      createdAt: store.serverTimestamp(),
    }, { merge: true });
    tx.set(friendRefB, {
      id: uid,
      name: ownProfile.username || maybeName(firebaseState.user.displayName) || "member",
      friendCode: ownProfile.friendCode || "",
      chatPublicJwk: ownProfile.chatPublicJwk || null,
      createdAt: store.serverTimestamp(),
    }, { merge: true });
    tx.update(reqRef, {
      status: "approved",
      resolvedAt: store.serverTimestamp(),
      resolvedBy: uid,
    });
  });
}

async function firebaseRemoveFriend(friendId) {
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user || !firebaseState.sdk || !firebaseState.db) {
    throw new Error("Sign in before removing a friend.");
  }
  const store = firebaseState.sdk.store;
  const db = firebaseState.db;
  const uid = firebaseState.user.uid;
  const batch = store.writeBatch(db);
  batch.delete(store.doc(db, "users", uid, "friends", friendId));
  batch.delete(store.doc(db, "users", friendId, "friends", uid));
  await batch.commit();
}

async function loadThreadMessagesFirebase(threadId) {
  if (!threadId) {
    renderMessages([]);
    return;
  }
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user || !firebaseState.sdk || !firebaseState.db) {
    throw new Error("Sign in to open cloud threads.");
  }
  const store = firebaseState.sdk.store;
  const db = firebaseState.db;
  const uid = firebaseState.user.uid;
  const friend = (socialState.friends || []).find((f) => f.id === activeFriendId);
  const counterpartJwk = friend ? friend.chatPublicJwk : null;
  const snap = await store.getDocs(
    store.query(
      store.collection(db, "threads", threadId, "messages"),
      store.orderBy("createdAt", "asc"),
      store.limit(300),
    ),
  );
  const rows = [];
  for (const d of snap.docs) {
    const row = d.data();
    const decrypted = await decryptDmBody(row, counterpartJwk);
    rows.push({
      id: d.id,
      threadId,
      fromName: row.fromName || (row.fromUid === uid ? "you" : activeThreadFriendName || "friend"),
      body: decrypted,
      createdAt: toIso(row.createdAt),
      readAt: row.readAt ? toIso(row.readAt) : null,
      fromUid: row.fromUid || "",
      toUid: row.toUid || "",
    });
  }
  renderMessages(rows);
}

async function markThreadReadFirebase(threadId, silent) {
  if (!threadId) return;
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user || !firebaseState.sdk || !firebaseState.db) {
    throw new Error("Sign in to mark read.");
  }
  const store = firebaseState.sdk.store;
  const db = firebaseState.db;
  const uid = firebaseState.user.uid;
  const unreadRows = await store.getDocs(
    store.query(
      store.collection(db, "threads", threadId, "messages"),
      store.where("toUid", "==", uid),
      store.where("readAt", "==", null),
      store.limit(300),
    ),
  );
  const batch = store.writeBatch(db);
  unreadRows.docs.forEach((d) => {
    batch.update(d.ref, { readAt: store.serverTimestamp() });
  });
  const patch = {};
  patch["unreadBy." + uid] = 0;
  batch.set(store.doc(db, "threads", threadId), patch, { merge: true });
  await batch.commit();
  if (!silent) setMailStatus("Marked read.");
}

async function firebaseSendDm(friendId, body) {
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user || !firebaseState.sdk || !firebaseState.db) {
    throw new Error("Sign in before sending messages.");
  }
  const store = firebaseState.sdk.store;
  const db = firebaseState.db;
  const uid = firebaseState.user.uid;
  const ownProfile = await ensureFirebaseProfile(false);
  const friend = (socialState.friends || []).find((f) => f.id === friendId);
  if (!friend) throw new Error("Friend not found.");
  const threadId = threadIdForUsers(uid, friendId);
  const encrypted = await encryptDmBody(body, friend.chatPublicJwk || null);
  const threadRef = store.doc(db, "threads", threadId);
  const msgRef = store.doc(store.collection(db, "threads", threadId, "messages"));
  const unreadPatch = {};
  unreadPatch["unreadBy." + uid] = 0;
  unreadPatch["unreadBy." + friendId] = (socialState.threads.find((t) => t.id === threadId)?.unread || 0) + 1;
  const friendNames = {};
  friendNames[uid] = ownProfile.username || maybeName(firebaseState.user.displayName) || "you";
  friendNames[friendId] = friend.name || friendId;
  await store.setDoc(threadRef, {
    id: threadId,
    participants: [uid, friendId].sort(),
    friendNames,
    lastMessagePreview: "Encrypted message",
    updatedAt: store.serverTimestamp(),
    ...unreadPatch,
  }, { merge: true });
  await store.setDoc(msgRef, {
    id: msgRef.id,
    threadId,
    fromUid: uid,
    toUid: friendId,
    fromName: ownProfile.username || maybeName(firebaseState.user.displayName) || "you",
    toName: friend.name || friendId,
    mode: encrypted.mode || "plain",
    body: encrypted.body || "",
    ciphertext: encrypted.ciphertext || "",
    iv: encrypted.iv || "",
    salt: encrypted.salt || "",
    createdAt: store.serverTimestamp(),
    readAt: null,
  });
  return threadId;
}

function renderFriends() {
  const rows = (socialState.friends || []).map((f) =>
    '<div class="mail-item">' +
      '<span><strong>' + socialEsc(f.name) + '</strong> <span class="meta">[' + socialEsc(f.id) + ']</span></span>' +
      '<span>' +
        '<button class="btn" type="button" data-dm-friend="' + socialEsc(f.id) + '" data-tip="Open composer for this friend">DM</button> ' +
        '<button class="btn" type="button" data-rm-friend="' + socialEsc(f.id) + '" data-tip="Remove this friend connection">Remove</button>' +
      "</span>" +
    "</div>"
  ).join("");
  friendsListEl.innerHTML = rows || '<div class="mail-item"><span class="meta">No friends yet.</span><span></span></div>';
  friendsListEl.querySelectorAll("button[data-dm-friend]").forEach((btn) => {
    btn.onclick = async () => {
      activeFriendId = btn.getAttribute("data-dm-friend") || "";
      const friend = (socialState.friends || []).find((f) => f.id === activeFriendId);
      activeThreadFriendName = friend ? friend.name : "";
      setMailStatus(activeThreadFriendName ? ("Composing to " + activeThreadFriendName) : "Compose message");
    };
  });
  friendsListEl.querySelectorAll("button[data-rm-friend]").forEach((btn) => {
    btn.onclick = async () => {
      const friendId = btn.getAttribute("data-rm-friend");
      if (!friendId) return;
      setMailStatus("Removing friend...");
      try {
        if (isFirebaseBackendSelected()) {
          await firebaseRemoveFriend(friendId);
        } else {
          const r = await fetch("/api/friends/" + encodeURIComponent(friendId) + "/remove", { method: "POST" });
          if (!r.ok) throw new Error(await r.text());
        }
        await loadMailState(true);
        setMailStatus("Friend removed.");
      } catch (err) {
        setMailStatus("Remove failed: " + (err.message || err));
      }
    };
  });
}

function renderFriendRequests() {
  const rows = (socialState.pendingRequests || []).map((req) =>
    '<div class="mail-item">' +
      '<span><strong>' + socialEsc(req.fromName) + '</strong> <span class="meta">(' + socialEsc(req.fromUrl) + ')</span></span>' +
      '<span>' +
        '<button class="btn" type="button" data-friend-approve="' + socialEsc(req.id) + '" data-tip="Accept this friend request">Approve</button> ' +
        '<button class="btn" type="button" data-friend-deny="' + socialEsc(req.id) + '" data-tip="Reject this friend request">Deny</button>' +
      "</span>" +
    "</div>"
  ).join("");
  friendRequestsListEl.innerHTML = rows || '<div class="mail-item"><span class="meta">No pending requests.</span><span></span></div>';
  friendRequestsListEl.querySelectorAll("button[data-friend-approve],button[data-friend-deny]").forEach((btn) => {
    btn.onclick = async () => {
      const requestId = btn.getAttribute("data-friend-approve") || btn.getAttribute("data-friend-deny") || "";
      const approve = btn.hasAttribute("data-friend-approve");
      if (!requestId) return;
      setMailStatus(approve ? "Approving..." : "Denying...");
      try {
        if (isFirebaseBackendSelected()) {
          await firebaseRespondFriendRequest(requestId, approve);
        } else {
          const r = await fetch("/api/friends/respond", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId, approve }),
          });
          if (!r.ok) throw new Error(await r.text());
          const data = await r.json();
          if (approve && data.callback && data.callback.delivered === false) {
            setMailStatus("Approved locally, callback failed: " + (data.callback.error || "unknown"));
          } else {
            setMailStatus(approve ? "Friend approved." : "Friend denied.");
          }
        }
        await loadMailState(true);
        if (isFirebaseBackendSelected()) setMailStatus(approve ? "Friend approved." : "Friend denied.");
      } catch (err) {
        setMailStatus("Request update failed: " + (err.message || err));
      }
    };
  });
}

function renderThreads() {
  const rows = (socialState.threads || []).map((t) => {
    const unread = t.unread || 0;
    const active = activeThreadId === t.id ? " active" : "";
    const badge = unread > 0 ? ('<span class="meta">unread ' + unread + "</span>") : '<span class="meta">read</span>';
    return (
      '<div class="mail-item' + active + '">' +
        '<span><strong>' + socialEsc(t.friendName || "unknown") + '</strong> <span class="meta">' + socialEsc(t.lastMessagePreview || "") + "</span></span>" +
        '<span>' +
          badge + ' <button class="btn" type="button" data-open-thread="' + socialEsc(t.id) + '" data-open-friend="' + socialEsc(t.friendId || "") + '" data-tip="Open this thread and mark unread messages as read">Open</button>' +
        "</span>" +
      "</div>"
    );
  }).join("");
  threadsListEl.innerHTML = rows || '<div class="mail-item"><span class="meta">No threads yet.</span><span></span></div>';
  threadsListEl.querySelectorAll("button[data-open-thread]").forEach((btn) => {
    btn.onclick = async () => {
      activeThreadId = btn.getAttribute("data-open-thread") || "";
      activeFriendId = btn.getAttribute("data-open-friend") || "";
      const row = (socialState.threads || []).find((t) => t.id === activeThreadId);
      activeThreadFriendName = row ? (row.friendName || "") : "";
      await loadThreadMessages(activeThreadId);
      await markThreadRead(activeThreadId, true);
      await loadMailState(true);
      renderThreads();
    };
  });
}

function renderMessages(list) {
  const rows = (list || []).map((m) => (
    '<div class="mail-msg">' +
      '<div class="head">' + socialEsc(m.fromName) + " · " + socialEsc(new Date(m.createdAt).toLocaleString()) + (m.readAt ? " · read" : "") + "</div>" +
      '<div class="body">' + socialEsc(m.body) + "</div>" +
    "</div>"
  )).join("");
  messagesListEl.innerHTML = rows || '<div class="mail-item"><span class="meta">No messages in this thread.</span><span></span></div>';
}

async function loadThreadMessages(threadId) {
  if (!threadId) {
    renderMessages([]);
    return;
  }
  try {
    if (isFirebaseBackendSelected()) {
      await loadThreadMessagesFirebase(threadId);
    } else {
      const r = await fetch("/api/dm/" + encodeURIComponent(threadId) + "?limit=200");
      if (!r.ok) throw new Error(await r.text());
      const rows = await r.json();
      renderMessages(rows);
    }
    setMailStatus(activeThreadFriendName ? ("Thread: " + activeThreadFriendName) : "Thread loaded.");
  } catch (err) {
    setMailStatus("Load messages failed: " + (err.message || err));
  }
}

async function markThreadRead(threadId, silent) {
  if (!threadId) return;
  try {
    if (isFirebaseBackendSelected()) {
      await markThreadReadFirebase(threadId, silent);
      return;
    }
    const r = await fetch("/api/dm/" + encodeURIComponent(threadId) + "/read", {
      method: "POST",
    });
    if (!r.ok) throw new Error(await r.text());
    if (!silent) setMailStatus("Marked read.");
  } catch (err) {
    if (!silent) setMailStatus("Mark read failed: " + (err.message || err));
  }
}

function applyMailState(payload) {
  socialState = payload || { friends: [], pendingRequests: [], threads: [] };
  const unread = (socialState.threads || []).reduce((n, t) => n + (t.unread || 0), 0);
  mailChip.textContent = "Mail" + (unread > 0 ? (" •" + unread) : "") + " ▾";
  if (unread > 0) mailChip.setAttribute("data-unread", "true");
  else mailChip.removeAttribute("data-unread");
  mailSummary.textContent =
    (socialState.friends || []).length + " friends · " +
    (socialState.pendingRequests || []).length + " requests · " +
    (socialState.threads || []).length + " threads";
  renderFriends();
  renderFriendRequests();
  renderThreads();
}

async function loadMailState(silent) {
  try {
    if (isFirebaseBackendSelected()) {
      await loadMailStateFirebase(silent);
    } else {
      await loadMailStateLocal(silent);
    }
  } catch (err) {
    setMailStatus("Mail unavailable: " + (err.message || err));
  }
}

$("friend-request-btn").onclick = async () => {
  const countryCode = ($("friend-target-code").value || "").trim().toUpperCase();
  if (!countryCode) {
    setMailStatus("Country code required.");
    return;
  }
  setMailStatus("Sending request...");
  try {
    if (isFirebaseBackendSelected()) {
      await firebaseSendFriendRequestByCode(countryCode);
    } else {
      const r = await fetch("/api/friends/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ countryCode }),
      });
      if (!r.ok) throw new Error(await r.text());
    }
    $("friend-target-code").value = "";
    setMailStatus("Friend request sent.");
    await loadMailState(true);
  } catch (err) {
    setMailStatus("Friend request failed: " + (err.message || err));
  }
};
$("friend-target-code").addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  $("friend-request-btn").click();
});

$("dm-send-btn").onclick = async () => {
  const body = ($("dm-compose-body").value || "").trim();
  if (!activeFriendId) {
    setMailStatus("Pick a friend or open a thread first.");
    return;
  }
  if (!body) {
    setMailStatus("Message body required.");
    return;
  }
  setMailStatus("Sending message...");
  try {
    if (isFirebaseBackendSelected()) {
      activeThreadId = await firebaseSendDm(activeFriendId, body);
    } else {
      const r = await fetch("/api/dm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ friendId: activeFriendId, body }),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      activeThreadId = data.threadId || activeThreadId;
    }
    $("dm-compose-body").value = "";
    await loadMailState(true);
    await loadThreadMessages(activeThreadId);
    setMailStatus("Message sent.");
  } catch (err) {
    setMailStatus("Send failed: " + (err.message || err));
  }
};

mailChip.onclick = () => {
  const authPanel = document.getElementById("auth-popover");
  if (authPanel) authPanel.classList.remove("open");
  providerPopover.classList.remove("open");
  countryPopover.classList.remove("open");
  const willOpen = !mailPopover.classList.contains("open");
  mailPopover.classList.toggle("open");
  if (willOpen) {
    setMailStatus("Loading...");
    loadMailState(true).then(() => setMailStatus("")).catch(() => {});
  }
};

setInterval(() => {
  if (!mailPopover.classList.contains("open")) loadMailState(true);
}, 15000);

mailMenuReload = loadMailState;
loadMailState(true);
} catch (err) {
  console.error("mail-ui-init-failed", err);
}

/* Onboarding */
try {
const onboardOverlay = $("onboard-overlay");
const onboardTitle = $("onboard-title");
const onboardBody = $("onboard-body");
const onboardProgress = $("onboard-progress");
const onboardBack = $("onboard-back");
const onboardSkip = $("onboard-skip");
const onboardNext = $("onboard-next");
const onboardingStorageKey = "goblintown.onboarding.v2";
const onboardingSteps = [
  {
    title: "Command Sidebar",
    body: "This sidebar runs Goblintown CLI commands directly in-app, including examples and quick rite controls.",
    targetId: "ops-sidebar",
  },
  {
    title: "Start a Rite",
    body: "Use New Rite for direct execution, or Plan to decompose larger work before running.",
    targetId: "btn-rite",
  },
  {
    title: "Goblin-Country",
    body: "Country mode handles team membership, join discovery, and per-role assignment across collaborators.",
    targetId: "country-chip",
    popover: "country",
  },
  {
    title: "Friends and Mail",
    body: "Friend requests and DM threads are here. Opening a thread auto-marks unread messages as read.",
    targetId: "mail-chip",
    popover: "mail",
  },
  {
    title: "Provider Settings",
    body: "Choose your local provider, set model slots, and store an API key in the local secret file.",
    targetId: "provider-chip",
    popover: "provider",
  },
  {
    title: "You are ready",
    body: "Run rites from the sidebar and use country + mail to coordinate distributed compute with teammates.",
    targetId: "ops-run",
  },
];
let onboardingIndex = 0;
let onboardingFocusEl = null;
function setTopPopover(name) {
  const countryPanel = countryPopover || document.getElementById("country-popover");
  const mailPanel = document.getElementById("mail-popover");
  providerPopover.classList.remove("open");
  if (countryPanel) countryPanel.classList.remove("open");
  if (mailPanel) mailPanel.classList.remove("open");
  if (name === "provider") providerPopover.classList.add("open");
  if (name === "country" && countryPanel) countryPanel.classList.add("open");
  if (name === "mail" && mailPanel) mailPanel.classList.add("open");
}
function clearOnboardingFocus() {
  if (onboardingFocusEl) onboardingFocusEl.classList.remove("onboard-focus");
  onboardingFocusEl = null;
}
function renderOnboardingStep() {
  const step = onboardingSteps[onboardingIndex];
  if (!step) return;
  setTopPopover(step.popover || "");
  clearOnboardingFocus();
  const focusEl = step.targetId ? $(step.targetId) : null;
  if (focusEl) {
    onboardingFocusEl = focusEl;
    onboardingFocusEl.classList.add("onboard-focus");
    onboardingFocusEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  onboardTitle.textContent = step.title;
  onboardBody.textContent = step.body;
  onboardProgress.textContent = "Step " + (onboardingIndex + 1) + " of " + onboardingSteps.length;
  onboardBack.disabled = onboardingIndex === 0;
  onboardNext.textContent = onboardingIndex === onboardingSteps.length - 1 ? "Finish" : "Next";
}
function closeOnboarding(markDone) {
  clearOnboardingFocus();
  setTopPopover("");
  onboardOverlay.classList.remove("open");
  if (markDone) {
    try { localStorage.setItem(onboardingStorageKey, "done"); } catch {}
  }
}
function maybeStartOnboarding() {
  let done = false;
  try { done = localStorage.getItem(onboardingStorageKey) === "done"; } catch {}
  const params = new URLSearchParams(window.location.search);
  const forced = params.get("onboarding") === "1";
  if (done && !forced) return;
  onboardingIndex = 0;
  onboardOverlay.classList.add("open");
  renderOnboardingStep();
}
onboardBack.onclick = () => {
  if (onboardingIndex <= 0) return;
  onboardingIndex -= 1;
  renderOnboardingStep();
};
onboardNext.onclick = () => {
  if (onboardingIndex >= onboardingSteps.length - 1) {
    closeOnboarding(true);
    return;
  }
  onboardingIndex += 1;
  renderOnboardingStep();
};
onboardSkip.onclick = () => closeOnboarding(true);
setTimeout(maybeStartOnboarding, 120);
} catch (err) {
  console.error("onboarding-ui-init-failed", err);
}

/* Bubbles */
const MAX_BUBBLES = 3;
const activeBubbles = [];
function dispatchBubble(creatureEl, text, kind, lifetime) {
  if (!creatureEl) return;
  kind = kind || "say";
  lifetime = lifetime || 4400;
  const tankRect = tank.getBoundingClientRect();
  const cRect = creatureEl.getBoundingClientRect();
  const cx = cRect.left - tankRect.left + cRect.width / 2;
  const cy = cRect.top  - tankRect.top;
  const onLeft = cx < tankRect.width / 2;

  const b = document.createElement("div");
  b.className = "bubble kind-" + kind;
  b.textContent = text;
  bubbleLayer.appendChild(b);

  const bw = 200;
  let left = onLeft ? cx + 14 : cx - bw + 14;
  left = Math.max(8, Math.min(tankRect.width - bw - 8, left));
  let top = cy - 56;
  if (top < 8) top = cy + cRect.height + 12;
  b.style.left = left + "px";
  b.style.top = top + "px";
  b.dataset.tail = (top < cy) ? (onLeft ? "bl" : "br") : "tl";

  activeBubbles.push(b);
  if (activeBubbles.length > MAX_BUBBLES) {
    const old = activeBubbles.shift();
    old.style.animation = "bubble-out 0.3s ease-in forwards";
    setTimeout(() => old.remove(), 350);
  }
  setTimeout(() => { b.remove(); const i = activeBubbles.indexOf(b); if (i >= 0) activeBubbles.splice(i, 1); }, lifetime + 400);
}

/* Animations w/ variance */
function setState(id, state) {
  const el = $(id);
  if (!el) return;
  el.dataset.state = state;
  if (id === "c-pigeon") applyPigeonStateVisual(state);
}
function playVariantAnim(id, variants, ms, varsObj) {
  const el = $(id);
  variants.forEach(v => el.classList.remove(v));
  if (varsObj) Object.keys(varsObj).forEach(k => el.style.setProperty(k, varsObj[k]));
  void el.offsetWidth;
  const chosen = pick(variants);
  el.classList.add(chosen);
  setTimeout(() => el.classList.remove(chosen), ms);
}
function pounceVariant() {
  playVariantAnim("c-gremlin", ["pounce-a","pounce-b","pounce-c"], 1100, {
    "--px": -irand(150, 230) + "px", "--py": irand(80, 140) + "px"
  });
}
function stompVariant() { playVariantAnim("c-ogre", ["stomp-a","stomp-b"], 1500); }
function scurryVariant() {
  playVariantAnim("c-raccoon", ["scurry-a","scurry-b"], 1800, {
    "--sx": irand(180, 260) + "px", "--sy": -irand(40, 80) + "px"
  });
}
function gavelVariant() { playVariantAnim("c-troll", ["gavel-a","gavel-b"], 1600); }
function hopGoblin(el) {
  if (el.id === "c-pigeon" && pigeonSpriteState.enabled) {
    setPigeonFps(Math.max(14, pigeonSpriteState.fps));
    setTimeout(() => applyPigeonStateVisual(pigeonSpriteState.visualState || "idle"), 480);
    return;
  }
  el.classList.remove("hop");
  void el.offsetWidth;
  el.classList.add("hop");
  setTimeout(() => el.classList.remove("hop"), 700);
}

function setTicker(text, live) {
  tickerText.textContent = text;
  ticker.classList.toggle("live", !!live);
}

/* Goblin pile w/ personality labels (set per goblin from pack:goblin event) */
const goblinByIndex = {};
const goblinByLootId = {};
const specialistByIndex = {};
const specialistByLootId = {};

/* Live "thinking" bubbles (one per slot, updated in place) */
const thinkingBubbles = {};
function resolveThinkingTarget(slot) {
  if (slot === "ogre") return $("c-ogre");
  if (slot === "scribe") return $("c-pigeon");
  if (slot.indexOf("goblin#") === 0) {
    const idx = +slot.slice("goblin#".length);
    return goblinByIndex[idx] ? goblinByIndex[idx].el : null;
  }
  if (slot.indexOf("specialist#") === 0) {
    const idx = +slot.slice("specialist#".length);
    return specialistByIndex[idx] ? specialistByIndex[idx].el : null;
  }
  return null;
}
function updateThinkingBubble(slot, text) {
  const target = resolveThinkingTarget(slot);
  if (!target) return;
  let b = thinkingBubbles[slot];
  if (!b) {
    b = document.createElement("div");
    b.className = "think-bubble";
    bubbleLayer.appendChild(b);
    thinkingBubbles[slot] = b;
  }
  const tankRect = tank.getBoundingClientRect();
  const cRect = target.getBoundingClientRect();
  const cx = cRect.left - tankRect.left + cRect.width / 2;
  const cy = cRect.top  - tankRect.top;
  const onLeft = cx < tankRect.width / 2;
  const bw = 280;
  let left = onLeft ? cx + 14 : cx - bw + 14;
  left = Math.max(8, Math.min(tankRect.width - bw - 8, left));
  let top = cy - 90;
  if (top < 8) top = cy + cRect.height + 12;
  b.style.left = left + "px";
  b.style.top = top + "px";
  // Show tail of streaming text so the bubble doesn't grow unbounded
  const tail = text.length > 240 ? "…" + text.slice(-240) : text;
  b.textContent = tail;
}
function clearThinkingBubble(slot) {
  const b = thinkingBubbles[slot];
  if (b) {
    b.remove();
    delete thinkingBubbles[slot];
  }
}
function clearAllThinkingBubbles() {
  Object.keys(thinkingBubbles).forEach(clearThinkingBubble);
}
function renderGoblinSlots(packSize) {
  goblinPile.innerHTML = "";
  Object.keys(goblinByIndex).forEach(k => delete goblinByIndex[k]);
  Object.keys(goblinByLootId).forEach(k => delete goblinByLootId[k]);
  const visible = Math.min(packSize, 3);
  for (let i = 0; i < visible; i++) {
    const wrap = document.createElement("div");
    wrap.className = "goblin-wrap";
    const div = document.createElement("div");
    div.className = "creature goblin";
    div.dataset.state = "idle";
    div.style.setProperty("--sway-dur", (3 + Math.random() * 2.5).toFixed(2) + "s");
    div.style.setProperty("--sway-x", irand(2,4) + "px");
    div.style.setProperty("--sway-delay", (-Math.random() * 3).toFixed(2) + "s");
    div.innerHTML = '<span class="emoji">👺</span>';
    const tag = document.createElement("span");
    tag.className = "personality";
    tag.textContent = "—";
    wrap.appendChild(div);
    wrap.appendChild(tag);
    goblinPile.appendChild(wrap);
    goblinByIndex[i] = { el: div, tag, lootId: null, personality: null };
  }
  if (packSize > 3) {
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = "+" + (packSize - 3);
    goblinPile.appendChild(badge);
  }
}

function setGoblinAll(state) {
  Object.values(goblinByIndex).forEach(g => g.el.dataset.state = state);
}

function renderSpecialistSlots(count) {
  goblinPile.innerHTML = "";
  Object.keys(specialistByIndex).forEach(k => delete specialistByIndex[k]);
  Object.keys(specialistByLootId).forEach(k => delete specialistByLootId[k]);
  const visible = Math.min(Math.max(1, count || 1), 3);
  for (let i = 0; i < visible; i++) {
    const wrap = document.createElement("div");
    wrap.className = "goblin-wrap";
    const div = document.createElement("div");
    div.className = "creature goblin";
    div.dataset.state = "idle";
    div.style.setProperty("--sway-dur", (3 + Math.random() * 2.5).toFixed(2) + "s");
    div.style.setProperty("--sway-x", irand(2,4) + "px");
    div.style.setProperty("--sway-delay", (-Math.random() * 3).toFixed(2) + "s");
    div.innerHTML = '<span class="emoji">🧐</span>';
    const tag = document.createElement("span");
    tag.className = "personality";
    tag.textContent = "specialist";
    wrap.appendChild(div);
    wrap.appendChild(tag);
    goblinPile.appendChild(wrap);
    specialistByIndex[i] = { el: div, tag, lootId: null };
  }
}

function resetCreatures() {
  ["c-raccoon","c-gremlin","c-troll","c-pigeon"].forEach(id => setState(id,"idle"));
  setState("c-ogre","cave");
  setGoblinAll("idle");
}

/* First-line snippet helper */
function firstLine(s, max) {
  if (!s) return "";
  const line = s.split(/\\r?\\n/).find(l => l.trim().length > 0) || s.slice(0, max);
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

const lootSnippetCache = new Map();

async function fetchLootSnippet(id, max) {
  const cached = lootSnippetCache.get(id);
  if (typeof cached === "string") {
    return firstLine(cached, max || 80);
  }
  try {
    const r = await fetch("/api/loot/" + id);
    if (!r.ok) return null;
    const loot = await r.json();
    const out = typeof loot.output === "string" ? loot.output : "";
    lootSnippetCache.set(id, out);
    return firstLine(out, max || 80);
  } catch { return null; }
}

/* Result panel */
let lastTask = null;
function showResultPanel(opts) {
  $("result-outcome").textContent = (opts.outcome || "result").replace("_", " ");
  $("result-outcome").className = "result-outcome " + (opts.outcome || "");
  $("result-task").textContent = opts.task || "(unknown task)";
  $("result-task").title = opts.task || "";
  $("result-output").textContent = opts.output || "(no output)";
  $("result-score").textContent = (opts.score != null) ? opts.score.toFixed(2) + " shinies" : "";
  $("result-link").href = opts.riteId ? "/rite/" + opts.riteId : "#";
  $("result-panel").classList.add("open");
}
function hideResultPanel() { $("result-panel").classList.remove("open"); }
$("result-dismiss").onclick = hideResultPanel;

async function showResultFromIds(riteId, lootId, outcome, task) {
  if (!lootId) {
    showResultPanel({ outcome, task, riteId, output: "(no winner loot recorded)" });
    return;
  }
  try {
    const r = await fetch("/api/loot/" + lootId);
    if (!r.ok) {
      showResultPanel({ outcome, task, riteId, lootId, output: "(loot not found)" });
      return;
    }
    const loot = await r.json();
    showResultPanel({
      outcome, task, riteId, lootId,
      output: loot.output,
      score: loot.reward,
    });
  } catch (e) {
    showResultPanel({ outcome, task, riteId, lootId, output: "(fetch failed: " + e.message + ")" });
  }
}

async function loadLastResult() {
  try {
    const r = await fetch("/api/runs");
    if (!r.ok) return;
    const runs = await r.json();
    const last = runs.find((rr) => rr.done && rr.finalRiteId);
    if (!last) return;
    let winnerLootId = null;
    try {
      const full = await fetch("/api/runs/" + last.runId + "?full=1");
      if (full.ok) {
        const record = await full.json();
        const doneEv = (record.events || []).slice().reverse().find((e) => e.kind === "done");
        winnerLootId = doneEv && doneEv.data && doneEv.data.winnerLootId;
      }
    } catch {}
    showResultFromIds(last.finalRiteId, winnerLootId, last.outcome || "winner", last.task);
  } catch {}
}

/* DAG side panel (Phase 3) */
const dagPanel = $("dag-panel");
const dagNodesEl = $("dag-nodes");
const dagNodeEls = {};
function showDag(plan) {
  dagNodesEl.innerHTML = "";
  Object.keys(dagNodeEls).forEach(k => delete dagNodeEls[k]);
  for (const n of plan.nodes) {
    const row = document.createElement("div");
    row.className = "dag-node";
    row.dataset.status = n.status || "pending";
    const id = document.createElement("span");
    id.className = "id"; id.textContent = n.id;
    const text = document.createElement("span");
    text.className = "text";
    const inputs = (n.inputs || []).length ? " ← " + n.inputs.join(",") : "";
    text.textContent = n.task + inputs;
    row.appendChild(id); row.appendChild(text);
    dagNodesEl.appendChild(row);
    dagNodeEls[n.id] = row;
  }
  dagPanel.classList.add("open");
}
function setDagNodeStatus(nodeId, status) {
  const el = dagNodeEls[nodeId];
  if (el) el.dataset.status = status;
}
function hideDag() { dagPanel.classList.remove("open"); dagPanel.classList.remove("collapsed"); }
$("dag-header").onclick = () => {
  const c = dagPanel.classList.toggle("collapsed");
  $("dag-toggle").textContent = c ? "[show]" : "[hide]";
};

/* Rite form overlay wiring */
let planMode = false;
function openRiteForm(asPlan) {
  planMode = !!asPlan;
  $("rite-overlay").classList.add("open");
  $("rf-task").placeholder = planMode
    ? "What complex task should the planner decompose?"
    : "What should the goblins solve?";
  setTimeout(() => $("rf-task").focus(), 50);
}
function closeRiteForm() { $("rite-overlay").classList.remove("open"); }
$("btn-rite").onclick = () => openRiteForm(false);
$("btn-plan").onclick = () => openRiteForm(true);
$("rf-cancel").onclick = closeRiteForm;
$("rite-overlay").addEventListener("click", (e) => { if (e.target === $("rite-overlay")) closeRiteForm(); });

/* Rite/plan submission */
let activeStream = null;
$("rite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const scanGlobs = (fd.get("scanGlobs") || "").toString()
    .split(/\\r?\\n/).map(s => s.trim()).filter(Boolean);
  const isPlan = planMode;
  const payload = isPlan
    ? {
        task: fd.get("task"),
        maxNodes: 6,
        maxReplan: 2,
        remember: !!fd.get("remember"),
      }
    : {
        task: fd.get("task"),
        packSize: Number(fd.get("packSize") || 3),
        personality: fd.get("personality"),
        noFallback: !!fd.get("noFallback"),
        debate: !!fd.get("debate"),
        trollTools: !!fd.get("trollTools"),
        remember: !!fd.get("remember"),
        scanGlobs,
      };
  closeRiteForm();
  hideResultPanel();
  hideDag();
  lastTask = payload.task;
  $("btn-rite").disabled = true;
  $("btn-plan").disabled = true;
  $("clock").textContent = isPlan ? "plan running" : "rite running";
  resetCreatures();
  bubbleLayer.innerHTML = "";
  activeBubbles.length = 0;
  Object.keys(thinkingBubbles).forEach(s => delete thinkingBubbles[s]);
  renderGoblinSlots(isPlan ? 3 : payload.packSize);
  setTicker(isPlan ? "POSTing plan ..." : "POSTing rite ...", true);

  try {
    const startRes = await fetch(isPlan ? "/api/plan" : "/api/rite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!startRes.ok) throw new Error(await startRes.text());
    const { runId } = await startRes.json();
    setTicker((isPlan ? "plan " : "rite ") + runId + " started", true);
    openStream(runId, isPlan);
  } catch (err) {
    setTicker("error: " + (err.message || err));
    $("btn-rite").disabled = false;
    $("btn-plan").disabled = false;
    $("clock").textContent = "idle";
  }
});

/* When attaching to an existing run, we replay history first then go live.
 * During replay, skip thinking-token deltas (4000+ would thrash the DOM)
 * and just keep the latest text per slot for a one-shot bubble update. */
let replaying = false;
const replayLatestThinking = {};
function openStream(runId, isPlan, opts) {
  if (activeStream) { activeStream.close(); activeStream = null; }
  const isAttach = !!(opts && opts.attach);
  replaying = isAttach;
  Object.keys(replayLatestThinking).forEach(k => delete replayLatestThinking[k]);

  const es = new EventSource("/api/rite/" + runId + "/stream");
  activeStream = es;

  es.addEventListener("replay-end", () => {
    replaying = false;
    // Flush the last thinking text per slot once, so the user sees where each
    // creature got to during the replayed period.
    Object.keys(replayLatestThinking).forEach((slot) => {
      updateThinkingBubble(slot, replayLatestThinking[slot]);
    });
    setTicker("(live) — caught up", true);
  });

  es.addEventListener("step", async (ev) => {
    const data = JSON.parse(ev.data);
    if (isPlan && data && data.nodeId && data.step) {
      // plan-wrapped sub-rite step: surface node id in ticker
      if (!replaying) setTicker("[" + data.nodeId + "] " + (data.step.kind || ""), true);
      if (replaying && data.step.kind === "thinking") {
        replayLatestThinking[data.step.slot] = data.step.text;
        return;
      }
      handleStep(data.step, { replay: replaying });
    } else {
      if (replaying && data && data.kind === "thinking") {
        replayLatestThinking[data.slot] = data.text;
        return;
      }
      handleStep(data, { replay: replaying });
    }
  });
  es.addEventListener("plan:planning", () => setTicker("planner thinking...", true));
  es.addEventListener("plan:built", (ev) => {
    const d = JSON.parse(ev.data);
    showDag(d.plan);
    setTicker("plan: " + d.plan.nodes.length + " node(s)", true);
  });
  es.addEventListener("plan:start", () => {});
  es.addEventListener("plan:node:start", (ev) => {
    const d = JSON.parse(ev.data);
    setDagNodeStatus(d.nodeId, "running");
    setTicker("plan node " + d.nodeId + " starting", true);
  });
  es.addEventListener("plan:node:done", (ev) => {
    const d = JSON.parse(ev.data);
    setDagNodeStatus(d.nodeId, "done");
    setTicker("plan node " + d.nodeId + " done · " + d.outcome, true);
  });
  es.addEventListener("plan:node:failed", (ev) => {
    const d = JSON.parse(ev.data);
    setDagNodeStatus(d.nodeId, "failed");
    setTicker("plan node " + d.nodeId + " failed: " + d.reason, true);
  });
  es.addEventListener("plan:replan", (ev) => {
    const d = JSON.parse(ev.data);
    setTicker("replanning (depth " + d.depth + ")", true);
  });
  es.addEventListener("plan:done", (ev) => {
    const d = JSON.parse(ev.data);
    setTicker("plan " + d.outcome, true);
  });
  es.addEventListener("done", async (ev) => {
    const d = JSON.parse(ev.data);
    const label = isPlan ? "plan done" : "rite done";
    setTicker(label + " · " + d.outcome + (d.riteId ? " · " + d.riteId : ""));
    es.close();
    activeStream = null;
    $("btn-rite").disabled = false;
    $("btn-plan").disabled = false;
    $("clock").textContent = "idle";
    setTimeout(refreshStats, 400);
    setTimeout(() => {
      ["c-raccoon","c-gremlin","c-troll","c-pigeon"].forEach(id => setState(id,"idle"));
      setState("c-ogre","cave");
      hideDag();
    }, 4000);
    if (d.riteId) {
      // For plans: prefer the final synthesize node's loot if present.
      let lootId = d.winnerLootId;
      if (!lootId && d.finalArtifactId) {
        try {
          const r = await fetch("/api/artifact/" + d.finalArtifactId);
          if (r.ok) {
            const a = await r.json();
            lootId = a.winnerLootId;
          }
        } catch {}
      }
      showResultFromIds(d.riteId, lootId, d.outcome, lastTask);
    }
  });
  es.addEventListener("error", (ev) => {
    let msg = "(connection error)";
    try { msg = JSON.parse(ev.data).message; } catch {}
    setTicker("error: " + msg);
    es.close();
    activeStream = null;
    $("btn-rite").disabled = false;
    $("btn-plan").disabled = false;
    $("clock").textContent = "idle";
  });
}

async function handleStep(step, opts) {
  const replay = !!(opts && opts.replay);
  switch (step.kind) {
    case "thinking":
      updateThinkingBubble(step.slot, step.text);
      return;
    case "scavenge:start":
      setState("c-raccoon","active");
      setTicker("raccoon scanning corpus", true);
      dispatchBubble($("c-raccoon"), "foraging " + (step.globs || []).join(", "));
      break;
    case "scavenge:done":
      scurryVariant();
      setTicker("raccoon → goblins", true);
      dispatchBubble($("c-raccoon"), "scanned " + step.fileCount + " file" + (step.fileCount === 1 ? "" : "s"));
      break;
    case "artifacts:loaded":
      setTicker("raccoon recalled " + step.count + " prior artifact" + (step.count === 1 ? "" : "s"), true);
      dispatchBubble($("c-raccoon"), "📜 loaded " + step.count + " prior artifact" + (step.count === 1 ? "" : "s"));
      break;
    case "pack:start":
      setTicker("pack of " + step.size + " dispatched", true);
      setGoblinAll("active");
      break;
    case "pack:goblin": {
      const slot = goblinByIndex[step.index] || goblinByIndex[step.index % 3];
      if (slot) {
        slot.lootId = step.lootId;
        goblinByLootId[step.lootId] = slot;
        if (step.personality) {
          slot.personality = step.personality;
          slot.tag.textContent = step.personality;
        }
        if (!replay) hopGoblin(slot.el);
        clearThinkingBubble("goblin#" + step.index);
        if (!replay) {
          const snippet = await fetchLootSnippet(step.lootId, 70);
          if (snippet) dispatchBubble(slot.el, snippet);
        }
      }
      break;
    }
    case "debate:start":
      setTicker("debate round " + step.round + " · " + step.size + " goblins exchanging", true);
      Object.values(goblinByIndex).forEach((g) => { g.el.dataset.state = "active"; hopGoblin(g.el); });
      break;
    case "debate:goblin": {
      const slot = goblinByIndex[step.index];
      if (slot) {
        slot.lootId = step.lootId;
        goblinByLootId[step.lootId] = slot;
        clearThinkingBubble("goblin#" + step.index);
        if (!replay) {
          const snippet = await fetchLootSnippet(step.lootId, 70);
          if (snippet) dispatchBubble(slot.el, "↻ " + snippet);
        }
      }
      break;
    }
    case "debate:done":
      setTicker("debate round " + step.round + " concluded", true);
      break;
    case "chaos:start":
      setState("c-gremlin","active");
      pounceVariant();
      setTicker("gremlin attacking", true);
      break;
    case "chaos:done": {
      if (!replay) {
        const snippet = await fetchLootSnippet(step.gremlinId, 70);
        if (snippet) dispatchBubble($("c-gremlin"), snippet, "attack");
      }
      setState("c-gremlin","idle");
      break;
    }
    case "review:start":
      setState("c-troll","active");
      gavelVariant();
      setTicker("troll reviewing", true);
      dispatchBubble($("c-troll"), "weighing the verdict...");
      break;
    case "tool:calls":
      setTicker("troll invoking " + step.calls.length + " tool(s)", true);
      dispatchBubble($("c-troll"), "🔧 " + step.calls.map(function(c){return c.name;}).join(", "));
      break;
    case "tool:results":
      setTicker("tool results received", true);
      dispatchBubble($("c-troll"), "🔧 " + step.results.map(function(r){return r.name+"="+(r.ok?"ok":"err");}).join(", "));
      break;
    case "review:verdict": {
      const v = step.verdict;
      const passed = v.passed;
      setState("c-troll", passed ? "pass" : "fail");
      setTicker("troll: " + (passed ? "PASS" : "FAIL") + " · " + v.score.toFixed(2), true);
      const text = (v.critique || (passed ? "passes spec" : "rejected")) + " · " + v.score.toFixed(2);
      dispatchBubble($("c-troll"), text, passed ? "pass" : "fail");
      // Mark winning goblin if known
      const slot = goblinByLootId[v.lootId];
      if (slot && passed) {
        slot.el.dataset.state = "winner";
        dispatchBubble(slot.el, "👑 winner · " + v.score.toFixed(2) + " shinies", "win");
      } else if (slot && !passed) {
        slot.el.dataset.state = "fail";
      }
      break;
    }
    case "specialist:cluster:start":
      setTicker("clustering failure modes 🔬", true);
      dispatchBubble($("c-troll"), "the pack has failed me. analyzing...", "fail");
      break;
    case "specialist:cluster:done": {
      const names = (step.clusters || []).map((c) => c.name).join(", ");
      setTicker("clusters: " + names, true);
      // Replace the failed pack with specialist 🧐 sprites
      renderSpecialistSlots(step.clusters.length);
      break;
    }
    case "specialist:spawn": {
      const slot = specialistByIndex[step.index];
      if (slot) {
        slot.tag.textContent = "specialist";
        slot.el.dataset.state = "active";
        if (!replay) {
          hopGoblin(slot.el);
          dispatchBubble(slot.el, "focus: " + step.focus.slice(0, 60));
        }
      }
      setTicker("specialist #" + (step.index + 1) + " spawned", true);
      break;
    }
    case "specialist:done": {
      const slot = specialistByIndex[step.index];
      specialistByLootId[step.lootId] = slot;
      clearThinkingBubble("specialist#" + step.index);
      if (!replay && slot) {
        const snippet = await fetchLootSnippet(step.lootId, 70);
        if (snippet) dispatchBubble(slot.el, snippet);
      }
      break;
    }
    case "specialist:verdict": {
      const slot = specialistByIndex[step.index];
      if (slot) {
        if (step.verdict.passed) {
          slot.el.dataset.state = "winner";
          dispatchBubble(slot.el, "👑 specialist won · " + step.verdict.score.toFixed(2), "win");
        } else {
          slot.el.dataset.state = "fail";
        }
      }
      setTicker(
        "specialist #" + (step.index + 1) + " " + (step.verdict.passed ? "PASS" : "FAIL") +
          " · " + step.verdict.score.toFixed(2),
        true,
      );
      break;
    }
    case "fallback:start":
      stompVariant();
      setState("c-ogre","active");
      setTicker("ogre fallback — synthesizing...", true);
      // Seed the live thinking bubble so the user sees the ogre is working,
      // even before the first token chunk arrives. (Streaming will overwrite it.)
      updateThinkingBubble("ogre", "synthesizing…");
      break;
    case "fallback:done": {
      clearThinkingBubble("ogre");
      if (!replay) {
        const snippet = await fetchLootSnippet(step.lootId, 80);
        if (snippet) dispatchBubble($("c-ogre"), snippet);
      }
      setTicker("ogre synthesized result", true);
      break;
    }
    case "scribe:start":
      setState("c-pigeon","active");
      hopGoblin($("c-pigeon"));
      setTicker("pigeon-scribe writing artifact 📜", true);
      dispatchBubble($("c-pigeon"), "📜 scribing this rite...");
      break;
    case "scribe:done":
      setTicker("artifact " + step.artifactId + " stashed", true);
      dispatchBubble($("c-pigeon"), "📜 " + step.artifactId);
      break;
    case "scribe:error":
      setState("c-pigeon", "fail");
      setTicker("scribe failed: " + step.message, true);
      dispatchBubble($("c-pigeon"), "⚠ " + step.message.slice(0, 60), "fail");
      break;
    case "budget:exceeded":
      setTicker("budget exceeded · " + step.phase + " · used=" + step.used + "/" + step.cap);
      break;
    case "rite:done":
      setTicker("rite complete · outcome=" + step.outcome);
      break;
  }
}

renderGoblinSlots(3);

/* Attach to an existing run if ?run=<id> is in the URL (e.g. when arriving
 * from the /runs page after a refresh). Otherwise restore the last result
 * panel as before. */
async function attachToRunFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const runId = params.get("run");
  if (!runId) {
    loadLastResult();
    return;
  }
  try {
    const r = await fetch("/api/runs/" + runId + "?full=1");
    if (!r.ok) {
      setTicker("run " + runId + " not found");
      loadLastResult();
      return;
    }
    const record = await r.json();
    lastTask = record.task;
    // Detect plan vs rite from event history.
    const isPlan = (record.events || []).some((e) =>
      typeof e.kind === "string" && e.kind.indexOf("plan:") === 0,
    );
    // Determine pack size: explicit on rite records, or read from a pack:start event.
    let packSize = record.packSize;
    if (!packSize || packSize < 1) {
      const ps = (record.events || []).find((e) =>
        e.kind === "step" && e.data && e.data.kind === "pack:start",
      );
      if (ps && ps.data && typeof ps.data.size === "number") packSize = ps.data.size;
    }
    renderGoblinSlots(Math.max(1, packSize || 3));
    hideResultPanel();
    hideDag();
    bubbleLayer.innerHTML = "";
    activeBubbles.length = 0;
    Object.keys(thinkingBubbles).forEach(s => delete thinkingBubbles[s]);

    const status = record.done
      ? (record.error ? "error" : "done")
      : "watching live";
    $("clock").textContent = isPlan ? "plan · " + status : "rite · " + status;
    setTicker((isPlan ? "plan " : "rite ") + runId + " · " + status, true);
    $("btn-rite").disabled = !record.done;
    $("btn-plan").disabled = !record.done;
    openStream(runId, isPlan, { attach: true });
  } catch (e) {
    setTicker("attach failed: " + (e.message || e));
    loadLastResult();
  }
}
attachToRunFromUrl();

/* Periodic light stats refresh in case of background activity */
setInterval(() => { if (!activeStream) refreshStats(); }, 30000);
</script>
</body>
</html>`;
}
