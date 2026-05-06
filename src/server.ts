import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { verifyInbox } from "./federation.js";
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
  type CreatureKind,
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
import { loadWarren, saveWarrenManifest, type Warren } from "./warren.js";

export interface ServeOptions {
  cwd: string;
  port: number;
}

interface RunState {
  record: RunRecord;
  subscribers: Set<Response>;
}

export async function serve(opts: ServeOptions): Promise<void> {
  const warren = await loadWarren(opts.cwd);
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
  app.use((_req, res, next) => {
    res.setHeader("X-Goblintown-Warren", warren.manifest.name);
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
        .map((r) => r.record)
        .sort((a, b) => b.startedAt - a.startedAt),
    ),
  );
  app.get("/api/runs/:runId", (req, res) => {
    const state = runs.get(req.params.runId);
    if (!state) {
      res.status(404).json({ error: "no such run" });
      return;
    }
    res.json(state.record);
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
  app.post("/api/provider", async (req, res) => {
    const config = normalizeProviderConfig(req.body);
    warren.manifest.provider = config;
    await saveWarrenManifest(warren);
    res.json(providerPayload(warren));
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
    hasApiKey: boolean;
    missingApiKey?: string;
    outputFormat: OutputFormat;
    models: Record<string, string>;
  };
} {
  const config = normalizeProviderConfig(warren.manifest.provider);
  const runtime = resolveProviderRuntime(config);
  return {
    config,
    runtime: {
      id: runtime.id,
      label: runtime.label,
      baseURL: runtime.baseURL,
      apiKeyEnv: runtime.apiKeyEnv,
      hasApiKey: runtime.apiKey.length > 0 && !runtime.missingApiKey,
      missingApiKey: runtime.missingApiKey,
      outputFormat: runtime.outputFormat,
      models: runtime.models,
    },
  };
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
    min-height: 100vh; padding: 1rem;
  }
  .warren {
    width: min(1200px, 97vw);
    height: min(780px, 94vh);
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

  .pos-pigeon  { top: 4%;  left: 4%; }
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

  .controls { border-top: 1px solid var(--line); padding: 0.7rem 1rem; display: flex; gap: 0.6rem; background: var(--bg); }
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
        <label for="provider-format">Forced format</label>
        <select id="provider-format">
          <option value="freeform">freeform</option>
          <option value="markdown">markdown</option>
          <option value="json">json object</option>
        </select>
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

<pre class="pigeon-wire">═══════════════
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
        <a id="result-loot-link" href="#">view loot ↗</a>
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
  </div>

  <div class="ticker" id="ticker">
    <span class="dot">●</span> <span id="ticker-text">idle</span>
  </div>

  <div class="controls">
    <button class="btn primary" id="btn-rite">▶ NEW RITE</button>
    <button class="btn" id="btn-plan">▶ PLAN</button>
    <a class="btn" href="/runs">RUNS</a>
    <a class="btn" href="/drift">DRIFT</a>
    <a class="btn" href="/inbox">INBOX</a>
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

const rand  = (lo, hi) => lo + Math.random() * (hi - lo);
const irand = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick  = (arr)    => arr[Math.floor(Math.random() * arr.length)];

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
const providerFormat = $("provider-format");
const providerModels = $("provider-models");
const providerStatus = $("provider-status");

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
  providerStatus.innerHTML = missing
    ? "Missing key: set <strong>" + missing + "</strong> in your environment. Keys are not stored here."
    : "Using <strong>" + (runtime.label || "provider") + "</strong>. Keys stay in environment variables.";
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
loadProviderMenu();

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
function setState(id, state) { $(id).dataset.state = state; }
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

async function fetchLootSnippet(id, max) {
  try {
    const r = await fetch("/api/loot/" + id);
    if (!r.ok) return null;
    const loot = await r.json();
    return firstLine(loot.output, max || 80);
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
  $("result-loot-link").href = opts.lootId ? "/loot/" + opts.lootId : "#";
  $("result-loot-link").style.display = opts.lootId ? "" : "none";
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
    const doneEv = (last.events || []).slice().reverse().find((e) => e.kind === "done");
    const winnerLootId = doneEv && doneEv.data && doneEv.data.winnerLootId;
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
      handleStep(data.step);
    } else {
      if (replaying && data && data.kind === "thinking") {
        replayLatestThinking[data.slot] = data.text;
        return;
      }
      handleStep(data);
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

async function handleStep(step) {
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
        hopGoblin(slot.el);
        clearThinkingBubble("goblin#" + step.index);
        const snippet = await fetchLootSnippet(step.lootId, 70);
        if (snippet) dispatchBubble(slot.el, snippet);
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
        const snippet = await fetchLootSnippet(step.lootId, 70);
        if (snippet) dispatchBubble(slot.el, "↻ " + snippet);
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
      const snippet = await fetchLootSnippet(step.gremlinId, 70);
      if (snippet) dispatchBubble($("c-gremlin"), snippet, "attack");
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
        hopGoblin(slot.el);
        dispatchBubble(slot.el, "focus: " + step.focus.slice(0, 60));
      }
      setTicker("specialist #" + (step.index + 1) + " spawned", true);
      break;
    }
    case "specialist:done": {
      const slot = specialistByIndex[step.index];
      specialistByLootId[step.lootId] = slot;
      clearThinkingBubble("specialist#" + step.index);
      if (slot) {
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
      const snippet = await fetchLootSnippet(step.lootId, 80);
      if (snippet) dispatchBubble($("c-ogre"), snippet);
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
    const r = await fetch("/api/runs/" + runId);
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
