import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { BabbleEngine, type BabbleEvent } from "./babble.js";
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
  type CreatureKind,
  type InboxMessage,
  type Personality,
} from "./types.js";
import { loadWarren, type Warren } from "./warren.js";

export interface ServeOptions {
  cwd: string;
  port: number;
  host?: string;
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
  // Static assets (CSS, future JS). The site/ folder ships next to dist/.
  const here = dirname(fileURLToPath(import.meta.url));
  app.use("/static", express.static(join(here, "..", "site", "static"), { maxAge: "1h" }));

  // Ambient babble — drives the /town live-chatter view.
  const babble = new BabbleEngine({ goblinCount: 8 });
  babble.start();

  app.get("/", async (_req, res) => renderHome(warren, runs, res));
  app.get("/welcome", (_req, res) =>
    res.send(layout("Welcome", warren, renderWelcome(warren))),
  );
  app.get("/town", (_req, res) =>
    res.send(layout("Town Square", warren, renderTown(babble))),
  );
  app.get("/api/town/stream", (req, res) => streamBabble(babble, req, res));
  app.get("/rite/new", (_req, res) =>
    res.send(layout("New Rite", warren, newRiteForm())),
  );
  app.get("/rite/:id", async (req, res) => renderRite(warren, req, res));
  app.get("/quest/:id", async (req, res) => renderQuest(warren, req, res));
  app.get("/loot/:id", async (req, res) => renderLoot(warren, req, res));
  app.get("/drift", async (_req, res) => renderDrift(warren, res));
  app.get("/hoard", async (req, res) => renderHoard(warren, req, res));
  app.get("/inbox", async (_req, res) => renderInbox(warren, res));
  app.get("/outbox", async (_req, res) => renderOutbox(warren, res));
  app.get("/runs", async (_req, res) => renderRuns(warren, runs, res));
  app.get("/run/:runId", async (req, res) => renderRunDetail(warren, runs, req, res));

  app.post("/api/rite", async (req, res) =>
    startRiteRun(warren, runs, runDir, babble, req, res),
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
  app.post("/api/inbox", async (req, res) => receiveInboxOverHttp(warren, req, res));

  app.use((_req, res) =>
    res
      .status(404)
      .send(layout("Not Found", warren, "<h1>404</h1><p>The Hoard does not contain that.</p>")),
  );

  await new Promise<void>((resolve) => {
    const host = opts.host ?? "127.0.0.1";
    app.listen(opts.port, host, () => {
      const display = host === "0.0.0.0" ? "localhost" : host;
      process.stdout.write(
        `Hoard UI listening on http://${display}:${opts.port}/  (bound ${host})\n` +
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
  babble: BabbleEngine,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as {
    task?: unknown;
    packSize?: unknown;
    scanGlobs?: unknown;
    personality?: unknown;
    noFallback?: unknown;
    budgetTokens?: unknown;
    maxOutputTokens?: unknown;
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
  const budgetTokens =
    typeof body.budgetTokens === "number" && body.budgetTokens > 0
      ? body.budgetTokens
      : undefined;
  const maxOutputTokens =
    typeof body.maxOutputTokens === "number" && body.maxOutputTokens > 0
      ? body.maxOutputTokens
      : undefined;

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

  performRite({
    task: body.task,
    packSize,
    scanGlobs,
    cwd: warren.root,
    hoard: warren.hoard,
    personality,
    rewardFn: rewardPlugin.fn,
    noFallback,
    budgetTokens,
    maxOutputTokensPerCall: maxOutputTokens,
    onStep: (step: RiteStep) => {
      emit("step", step);
      // Surface a few notable steps as town-square news so spectators see life.
      const k = (step as { kind?: string }).kind ?? "";
      if (k === "raccoon:done") babble.news("raccoon", "scavenge complete — facts on the table");
      else if (k === "pack:goblin") babble.news("goblin", `draft #${(step as { index?: number }).index ?? "?"} delivered`);
      else if (k === "troll:verdict") {
        const passed = (step as { passed?: boolean }).passed;
        babble.news("troll", passed ? "this one passes!" : "rejected. next.");
      }
      else if (k === "ogre:done") babble.news("ogre", "fallback synthesized");
    },
  })
    .then(async (result) => {
      state.record.finalRiteId = result.rite.id;
      state.record.outcome = result.rite.outcome;
      emit("done", {
        riteId: result.rite.id,
        outcome: result.rite.outcome,
        winnerLootId: result.rite.winnerLootId,
      });
      babble.news("town", `rite ${result.rite.id} complete — ${result.rite.outcome}`);
      await finish();
    })
    .catch(async (err: unknown) => {
      state.record.error =
        err instanceof Error ? err.message : String(err);
      emit("error", { message: state.record.error });
      babble.news("town", `a rite has gone dark: ${state.record.error}`);
      await finish();
    });

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
  res.write(`data: ${JSON.stringify(ev.data)}\n\n`);}

function streamBabble(babble: BabbleEngine, req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  // Replay recent buffer so visitors see history immediately.
  for (const ev of babble.recent()) writeBabbleSse(res, ev);
  // Heartbeat keeps proxies / browsers from closing idle connections.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);
  const unsub = babble.subscribe((ev) => writeBabbleSse(res, ev));
  req.on("close", () => {
    clearInterval(heartbeat);
    unsub();
  });
}

function writeBabbleSse(res: Response, ev: BabbleEvent): void {
  res.write(`id: ${ev.id}\n`);
  res.write(`event: ${ev.kind}\n`);
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

async function renderRuns(
  warren: Warren,
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
          ? `<span class="tag tag-error">error</span>`
          : `<span class="tag tag-done">done</span>`
        : `<span class="tag tag-running">running</span>`;
      const link = r.finalRiteId
        ? `<a href="/rite/${esc(r.finalRiteId)}">${esc(r.finalRiteId)}</a>`
        : `<a href="/run/${esc(r.runId)}">view</a>`;
      return `<tr>
        <td><a href="/run/${esc(r.runId)}">${esc(r.runId)}</a></td>
        <td>${status}</td>
        <td>${link}</td>
        <td>${r.events.length}</td>
        <td>${esc(new Date(r.startedAt).toISOString())}</td>
        <td><pre>${esc(r.task.slice(0, 200))}</pre></td>
      </tr>`;
    })
    .join("");
  const body = `
    <h1>Runs (${records.length})</h1>
    <table>
      <tr><th>runId</th><th>status</th><th>rite</th><th>events</th><th>started</th><th>task</th></tr>
      ${rows || `<tr><td colspan="6" class="muted">none</td></tr>`}
    </table>
  `;
  res.send(layout("Runs", warren, body));
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


async function renderHome(
  warren: Warren,
  runs: Map<string, RunState>,
  res: Response,
): Promise<void> {
  const [rites, quests, loot, inbox] = await Promise.all([
    warren.hoard.allRites(),
    warren.hoard.allQuests(),
    warren.hoard.allLoot(),
    warren.hoard.allInbox(),
  ]);
  rites.sort((a, b) => b.startedAt - a.startedAt);
  quests.sort((a, b) => b.startedAt - a.startedAt);

  // Empty Warren? Show a welcoming first-run experience instead of a wall of zeroes.
  if (loot.length === 0 && rites.length === 0 && quests.length === 0) {
    res.send(layout("Welcome", warren, renderWelcome(warren)));
    return;
  }

  const stats = creatureCounts(loot);
  const activeRuns = [...runs.values()].filter((r) => !r.record.done).length;
  const totalTokens = loot.reduce((s, l) => s + (l.usage?.totalTokens ?? 0), 0);
  const totalShinies = loot.reduce((s, l) => s + (l.reward ?? 0), 0);
  const passedRites = rites.filter((r) => r.outcome === "winner").length;
  const successRate =
    rites.length > 0 ? Math.round((passedRites / rites.length) * 100) : 0;

  // Combined recent activity feed — interleave rites and quests by time.
  type FeedItem =
    | { kind: "rite"; id: string; ts: number; outcome: string; pack: number; task: string }
    | { kind: "quest"; id: string; ts: number; pack: number; task: string };
  const feed: FeedItem[] = [
    ...rites.map((r) => ({
      kind: "rite" as const,
      id: r.id,
      ts: r.startedAt,
      outcome: r.outcome,
      pack: r.packSize,
      task: r.task,
    })),
    ...quests.map((q) => ({
      kind: "quest" as const,
      id: q.id,
      ts: q.startedAt,
      pack: q.packSize,
      task: q.task,
    })),
  ]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 12);

  const feedHtml = feed
    .map((f) => {
      if (f.kind === "rite") {
        return `<li>
          <span class="feed-icon">${glyph("rite", 14)}</span>
          <span class="tag tag-${esc(f.outcome)}">${esc(f.outcome)}</span>
          <a class="feed-task" href="/rite/${esc(f.id)}" title="${esc(f.task)}">${esc(truncate(f.task, 90))}</a>
          <span class="feed-meta">pack=${f.pack} · ${esc(timeAgo(f.ts))}</span>
        </li>`;
      }
      return `<li>
        <span class="feed-icon">${glyph("quest", 14)}</span>
        <span class="tag tag-done">quest</span>
        <a class="feed-task" href="/quest/${esc(f.id)}" title="${esc(f.task)}">${esc(truncate(f.task, 90))}</a>
        <span class="feed-meta">pack=${f.pack} · ${esc(timeAgo(f.ts))}</span>
      </li>`;
    })
    .join("");

  const creatureCardsHtml = CREATURE_KINDS.map(
    (k) => `<a class="stat-card clickable" href="/hoard?kind=${esc(k)}">
      <span class="label">${esc(k)}</span>
      <span class="value">${stats[k] ?? 0}</span>
    </a>`,
  ).join("");

  const body = `
    <div class="hero" style="padding:1.4rem 1.6rem;">
      <h1 style="font-size:1.6rem;">${esc(warren.manifest.name)}</h1>
      <p class="tagline" style="font-size:1rem;margin-bottom:.4rem;">
        Six creatures collaborate on your prompts. Goblins draft, Gremlins audit, Trolls judge —
        and everything they make lands in your hoard.
        <a href="/welcome" class="muted">Learn more →</a>
      </p>
      <p class="muted" style="font-size:.85rem;margin:.2rem 0 1rem;">
        ${loot.length} loot · ${rites.length} rites · ${quests.length} quests
        ${activeRuns > 0 ? ` · <strong style="color:var(--gold);">${activeRuns} running now</strong>` : ""}
      </p>
      <div class="cta-row">
        <a class="btn" href="/rite/new">+ Start a rite</a>
        <a class="btn btn-ghost" href="/town">Visit the square</a>
        <a class="btn btn-ghost" href="/hoard">Browse hoard</a>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <span class="label">Total loot</span>
        <span class="value">${loot.length}</span>
      </div>
      <div class="stat-card">
        <span class="label">Rite success</span>
        <span class="value">${successRate}%</span>
        <span class="sub">${passedRites} / ${rites.length} passed</span>
      </div>
      <div class="stat-card">
        <span class="label">Total tokens</span>
        <span class="value">${formatNumber(totalTokens)}</span>
      </div>
      <div class="stat-card">
        <span class="label">Shinies earned</span>
        <span class="value">${totalShinies.toFixed(2)}</span>
      </div>
    </div>

    <div class="split">
      <section>
        <h2>Recent activity</h2>
        ${
          feed.length === 0
            ? `<div class="empty-state"><h3>Nothing yet</h3><p><a class="btn" href="/rite/new">+ Start your first rite</a></p></div>`
            : `<ul class="feed">${feedHtml}</ul>`
        }
      </section>

      <aside>
        <details class="aside-section">
          <summary>By creature <span class="muted">(${CREATURE_KINDS.length} kinds)</span></summary>
          <div class="stat-grid stat-grid-compact">${creatureCardsHtml}</div>
        </details>

        <h2>More</h2>
        <ul>
          <li><a href="/runs">All runs</a></li>
          <li><a href="/drift">Drift report</a></li>
          <li><a href="/inbox">Inbox (${inbox.length})</a></li>
          <li><a href="/outbox">Outbox</a></li>
          <li><a href="/welcome">What is this?</a></li>
        </ul>
      </aside>
    </div>
  `;
  res.send(layout(esc(warren.manifest.name), warren, body));
}

function renderWelcome(warren: Warren): string {
  return `
    <div class="hero">
      <h1>Goblintown</h1>
      <p class="tagline">
        A multi-agent OpenAI orchestration playground. Six creatures collaborate on your tasks —
        Goblins draft, Gremlins audit, Trolls judge, Raccoons gather facts, Ogres synthesize fallbacks, Pigeons carry messages.
      </p>
      <div class="cta-row">
        <a class="btn" href="/rite/new">+ Start your first rite</a>
        <a class="btn btn-ghost" href="/town">Visit the square</a>
        <a class="btn btn-ghost" href="/hoard">Browse the hoard</a>
        <a class="btn btn-ghost" href="https://github.com/0xbl33p/goblintown" target="_blank" rel="noopener">View on GitHub</a>
      </div>
    </div>

    <h2>The bestiary</h2>
    <div class="creature-grid">
      <div class="creature-card c-goblin">
        <h3>Goblin · drafter</h3>
        <p>Generates candidate solutions in a pack. Variants (worker / tinker / brawler / scout) explore the prompt from different angles.</p>
      </div>
      <div class="creature-card c-gremlin">
        <h3>Gremlin · auditor</h3>
        <p>Reviews each goblin draft with a critical eye, flagging mistakes and suggesting fixes.</p>
      </div>
      <div class="creature-card c-troll">
        <h3>Troll · judge</h3>
        <p>Scores every draft against the original task. Picks a winner or declares everyone failed.</p>
      </div>
      <div class="creature-card c-raccoon">
        <h3>Raccoon · scavenger</h3>
        <p>Reads files from your repo (via glob) and digests them into facts the goblins can use.</p>
      </div>
      <div class="creature-card c-ogre">
        <h3>Ogre · fallback</h3>
        <p>Steps in when the entire pack fails — synthesizes a final answer from the wreckage.</p>
      </div>
      <div class="creature-card c-pigeon">
        <h3>Pigeon · courier</h3>
        <p>Signs and ferries loot to peer warrens (federation). Verifies signatures on inbound messages.</p>
      </div>
    </div>

    <h2>How a rite works</h2>
    <ol>
      <li><strong>Raccoon</strong> scavenges any files you point it at.</li>
      <li>A pack of <strong>Goblins</strong> drafts candidate answers in parallel.</li>
      <li>A <strong>Gremlin</strong> audits each draft.</li>
      <li>The <strong>Troll</strong> scores them and picks a winner.</li>
      <li>If everyone failed, the <strong>Ogre</strong> synthesizes a fallback.</li>
      <li>Everything lands in your <a href="/hoard">hoard</a>, content-addressed.</li>
    </ol>

    <h2>Ready?</h2>
    <p>
      <a class="btn" href="/rite/new">+ Start a rite</a>
      &nbsp;or&nbsp;
      <a href="/">go to the dashboard</a>.
    </p>
  `;
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

/**
 * Inline SVG creature glyphs. All shapes paint with `currentColor` so the
 * per-creature CSS color tints them. 24×24 viewBox; size is set by callers.
 */
function glyph(kind: string, size = 18): string {
  const s = size;
  const open = `<svg class="glyph glyph-${kind}" viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">`;
  const close = `</svg>`;
  let body = "";
  switch (kind) {
    case "goblin":
      // Hooded silhouette with pointed ears
      body = `
        <path stroke-width="0" d="M5 9c0-3 3-6 7-6s7 3 7 6v2c0 4-3 7-7 7s-7-3-7-7V9z"/>
        <path stroke-width="0" d="M3 7l3 3-1 2-3-2zM21 7l-3 3 1 2 3-2z"/>
        <circle cx="9.5" cy="11" r="1.1" fill="#0a120c" stroke="none"/>
        <circle cx="14.5" cy="11" r="1.1" fill="#0a120c" stroke="none"/>
        <path stroke-width="1.2" fill="none" d="M9 14.5c1 .8 2 1.2 3 1.2s2-.4 3-1.2"/>`;
      break;
    case "gremlin":
      // Gear / wrench
      body = `
        <path stroke-width="1.4" fill="none" d="M12 5v2M12 17v2M5 12h2M17 12h2M7.2 7.2l1.4 1.4M15.4 15.4l1.4 1.4M7.2 16.8l1.4-1.4M15.4 8.6l1.4-1.4"/>
        <circle cx="12" cy="12" r="4" fill="none" stroke-width="1.6"/>
        <circle cx="12" cy="12" r="1.4" stroke="none"/>`;
      break;
    case "troll":
      // Scales of justice
      body = `
        <path stroke-width="1.6" fill="none" d="M12 4v16M5 20h14M7 8h10"/>
        <path stroke-width="0" d="M3 13l2-5 2 5c0 1-1 2-2 2s-2-1-2-2zM17 13l2-5 2 5c0 1-1 2-2 2s-2-1-2-2z"/>`;
      break;
    case "raccoon":
      // Bandit-mask face
      body = `
        <path stroke-width="0" d="M4 9c0-3 3-6 8-6s8 3 8 6v3c0 4-3 7-8 7s-8-3-8-7V9z"/>
        <path stroke-width="0" fill="#0a120c" d="M5 10h14v3H5z" opacity=".75"/>
        <circle cx="9" cy="11.5" r="1.1" fill="#fff" stroke="none"/>
        <circle cx="15" cy="11.5" r="1.1" fill="#fff" stroke="none"/>
        <circle cx="9" cy="11.5" r=".5" fill="#0a120c" stroke="none"/>
        <circle cx="15" cy="11.5" r=".5" fill="#0a120c" stroke="none"/>
        <path stroke-width="0" d="M3 6l3 2-1 2-2.5-1zM21 6l-3 2 1 2 2.5-1z"/>`;
      break;
    case "ogre":
      // Boulder / tusked beast
      body = `
        <path stroke-width="0" d="M3 14c0-5 4-9 9-9s9 4 9 9v3c0 2-1 3-3 3H6c-2 0-3-1-3-3v-3z"/>
        <circle cx="9" cy="13" r="1" fill="#0a120c" stroke="none"/>
        <circle cx="15" cy="13" r="1" fill="#0a120c" stroke="none"/>
        <path stroke-width="0" fill="#0a120c" d="M9 17l-1 3 2-1zM15 17l1 3-2-1z"/>`;
      break;
    case "pigeon":
      // Bird in profile
      body = `
        <path stroke-width="0" d="M4 14c0-4 3-7 7-7l1-2 1 2c4 0 7 3 7 7 0 3-2 5-5 5h-1l-3 3v-3H9c-3 0-5-2-5-5z"/>
        <circle cx="16" cy="11" r=".9" fill="#0a120c" stroke="none"/>
        <path stroke-width="0" fill="#f3df7a" d="M19 12l3 1-3 1z"/>`;
      break;
    case "town":
      // Tiny rooftops
      body = `
        <path stroke-width="0" d="M3 20V12l4-3 4 3v8H3zM13 20V10l4-4 4 4v10h-8z"/>
        <path stroke-width="0" fill="#0a120c" d="M5 15h2v2H5zM15 13h2v2h-2zM15 17h2v2h-2z"/>`;
      break;
    case "vault":
      // Coin
      body = `
        <circle cx="12" cy="12" r="9" fill="none" stroke-width="1.6"/>
        <circle cx="12" cy="12" r="6.5" stroke="none"/>
        <text x="12" y="15.5" font-size="8" font-weight="700" text-anchor="middle" fill="#0a120c" stroke="none" font-family="ui-monospace, monospace">$</text>`;
      break;
    case "rite":
      body = `
        <path stroke-width="1.6" fill="none" d="M5 5l8 8M5 13l8-8M14 13l5 5M14 18l5-5"/>`;
      break;
    case "quest":
      body = `
        <path stroke-width="0" d="M12 3l2.5 5 5.5.5-4 4 1 5.5L12 15l-5 3 1-5.5-4-4 5.5-.5z"/>`;
      break;
    case "ok":
      body = `<path stroke-width="2" fill="none" d="M5 12l4 4 10-10"/>`;
      break;
    case "err":
      body = `<path stroke-width="2" fill="none" d="M6 6l12 12M18 6L6 18"/>`;
      break;
    default:
      body = `<circle cx="12" cy="12" r="3"/>`;
  }
  return open + body + close;
}

function renderTown(babble: BabbleEngine): string {
  const goblinCount = babble.goblinCount;
  // Pre-render the goblin sprites; positions are managed client-side as
  // wandering pathwalkers between fixed village waypoints.
  const goblinSprites = Array.from({ length: goblinCount }, (_, i) =>
    `<div class="sprite sprite-goblin" data-idx="${i}" data-kind="goblin">
       <span class="emoji">${glyph("goblin", 22)}</span>
       <span class="name">g${i}</span>
       <span class="bubble"></span>
     </div>`,
  ).join("");

  return `
    <div class="town-header">
      <div class="town-title">
        <h1>The Square</h1>
        <p class="muted">A live view of the bestiary. Goblins wander between landmarks; everyone reacts when you start a rite.</p>
      </div>
      <div class="town-actions">
        <a class="btn" href="/rite/new">+ Start a rite</a>
        <a class="btn btn-ghost" href="/welcome">What is this?</a>
      </div>
    </div>

    <details class="town-legend">
      <summary>Who lives here? <span class="muted">(click to expand)</span></summary>
      <div class="legend-grid">
        <div class="legend-card">
          <span class="legend-emoji spk-goblin">${glyph("goblin", 18)}</span>
          <div class="legend-text">
            <div class="legend-name">Goblins</div>
            <div class="legend-role">Drafters — write the candidate answers</div>
            <div class="legend-where">Wander the square</div>
          </div>
        </div>
        <div class="legend-card">
          <span class="legend-emoji spk-gremlin">${glyph("gremlin", 18)}</span>
          <div class="legend-text">
            <div class="legend-name">Gremlin</div>
            <div class="legend-role">Auditor — lints &amp; critiques drafts</div>
            <div class="legend-where">At the workshop</div>
          </div>
        </div>
        <div class="legend-card">
          <span class="legend-emoji spk-troll">${glyph("troll", 18)}</span>
          <div class="legend-text">
            <div class="legend-name">Troll</div>
            <div class="legend-role">Judge — picks the winning draft</div>
            <div class="legend-where">On the stage</div>
          </div>
        </div>
        <div class="legend-card">
          <span class="legend-emoji spk-raccoon">${glyph("raccoon", 18)}</span>
          <div class="legend-text">
            <div class="legend-name">Raccoon</div>
            <div class="legend-role">Scavenger — digs the hoard for context</div>
            <div class="legend-where">In the tree</div>
          </div>
        </div>
        <div class="legend-card">
          <span class="legend-emoji spk-ogre">${glyph("ogre", 18)}</span>
          <div class="legend-text">
            <div class="legend-name">Ogre</div>
            <div class="legend-role">Fallback — steps in when all drafts fail</div>
            <div class="legend-where">In the cave</div>
          </div>
        </div>
        <div class="legend-card">
          <span class="legend-emoji spk-pigeon">${glyph("pigeon", 18)}</span>
          <div class="legend-text">
            <div class="legend-name">Pigeon</div>
            <div class="legend-role">Courier — announces the verdict</div>
            <div class="legend-where">On the perch</div>
          </div>
        </div>
      </div>
    </details>

    <div class="town-stage" id="stage">
      <!-- Sky / decorations -->
      <div class="sky">
        <div class="moon"></div>
        <div class="star" style="left:12%;top:8%"></div>
        <div class="star" style="left:34%;top:14%"></div>
        <div class="star" style="left:62%;top:6%"></div>
        <div class="star" style="left:78%;top:18%"></div>
        <div class="star" style="left:88%;top:11%"></div>
      </div>
      <div class="ground"></div>
      <div class="path"></div>

      <!-- Buildings & landmarks (positions in % of stage) -->
      <div class="bldg workshop"  style="left:8%;top:55%"  title="Workshop (Gremlin)">
        <div class="roof"></div><div class="wall"></div><div class="door"></div>
        <div class="sign">workshop</div>
      </div>
      <div class="bldg judges"    style="left:42%;top:24%" title="Judge's stage (Troll)">
        <div class="roof judges-roof"></div><div class="pillar pl"></div><div class="pillar pr"></div><div class="floor"></div>
        <div class="sign">judges</div>
      </div>
      <div class="bldg vault"     style="left:78%;top:60%" title="Vault (loot drops here)">
        <div class="roof vault-roof"></div><div class="wall vault-wall"></div><div class="door vault-door">$</div>
        <div class="sign">vault</div>
      </div>
      <div class="firepit" style="left:50%;top:65%" title="Firepit (where goblins gather)">
        <div class="logs"></div><div class="flame f1"></div><div class="flame f2"></div><div class="flame f3"></div>
      </div>
      <div class="tree" style="left:18%;top:24%" title="Raccoon's tree">
        <div class="trunk"></div><div class="leaves"></div>
      </div>
      <div class="cave" style="left:88%;top:22%" title="Ogre's cave">
        <div class="mountain"></div><div class="mouth"></div>
      </div>
      <div class="perch" style="left:62%;top:8%" title="Pigeon's perch">
        <div class="post"></div><div class="bar"></div>
      </div>

      <!-- Stationary denizens (positioned at their landmark) -->
      <div class="sprite sprite-gremlin" data-kind="gremlin" style="left:12%;top:62%">
        <span class="emoji">${glyph("gremlin", 22)}</span><span class="name">Gremlin</span><span class="bubble"></span>
      </div>
      <div class="sprite sprite-troll" data-kind="troll" style="left:46%;top:33%">
        <span class="emoji">${glyph("troll", 22)}</span><span class="name">Troll</span><span class="bubble"></span>
      </div>
      <div class="sprite sprite-raccoon" data-kind="raccoon" style="left:22%;top:32%">
        <span class="emoji">${glyph("raccoon", 22)}</span><span class="name">Raccoon</span><span class="bubble"></span>
      </div>
      <div class="sprite sprite-ogre" data-kind="ogre" style="left:91%;top:30%">
        <span class="emoji">${glyph("ogre", 22)}</span><span class="name">Ogre</span><span class="bubble"></span>
      </div>
      <div class="sprite sprite-pigeon" data-kind="pigeon" style="left:65%;top:14%">
        <span class="emoji">${glyph("pigeon", 22)}</span><span class="name">Pigeon</span><span class="bubble"></span>
      </div>
      <div class="sprite sprite-vault" data-kind="vault" style="left:81%;top:65%">
        <span class="emoji">${glyph("vault", 18)}</span>
      </div>

      <!-- Wandering goblins -->
      ${goblinSprites}
    </div>

    <div class="town-controls">
      <div class="town-controls-left">
        <h2>Live chatter</h2>
        <span class="conn-pill" id="conn-status">connecting…</span>
      </div>
      <div class="filter-row">
        <label class="inline"><input type="checkbox" id="filter-news" checked> news</label>
        <label class="inline"><input type="checkbox" id="filter-chatter" checked> chatter</label>
        <label class="inline"><input type="checkbox" id="filter-system"> system</label>
        <label class="inline"><input type="checkbox" id="show-time"> show time</label>
      </div>
    </div>
    <div class="chatter" id="chatter"></div>
    <p class="chatter-hint muted">Watching idle banter. <a href="/rite/new">Start a rite</a> to see the bestiary react in real time.</p>

    <script>
      // ============================================================
      //  Stage geometry — waypoints are % coords; goblins walk paths
      //  between them; non-goblins stay at their station with idle bob.
      // ============================================================
      const stage = document.getElementById("stage");
      const goblins = Array.from(stage.querySelectorAll(".sprite-goblin"));

      const WAYPOINTS = {
        firepit:   { x: 50, y: 78 },
        workshop:  { x: 18, y: 70 },
        judges:    { x: 50, y: 44 },
        vault:     { x: 80, y: 76 },
        tree:      { x: 24, y: 44 },
        cave:      { x: 88, y: 40 },
        perch:     { x: 65, y: 22 },
      };
      const WP_KEYS = Object.keys(WAYPOINTS);

      // Per-goblin state: current pos, target waypoint, path progress.
      const gState = goblins.map((el, i) => {
        const start = WAYPOINTS.firepit;
        const jx = (Math.random() - 0.5) * 8;
        const jy = (Math.random() - 0.5) * 6;
        return {
          el,
          x: start.x + jx,
          y: start.y + jy,
          tx: start.x + jx,
          ty: start.y + jy,
          speed: 0.18 + Math.random() * 0.12,
          pause: 0,
          face: 1,
          bubbleUntil: 0,
        };
      });

      function pickWaypoint() {
        const k = WP_KEYS[Math.floor(Math.random() * WP_KEYS.length)];
        const w = WAYPOINTS[k];
        return { x: w.x + (Math.random() - 0.5) * 10, y: w.y + (Math.random() - 0.5) * 8 };
      }

      function tick() {
        for (const g of gState) {
          if (g.pause > 0) { g.pause--; }
          else {
            const dx = g.tx - g.x;
            const dy = g.ty - g.y;
            const d = Math.hypot(dx, dy);
            if (d < 0.6) {
              // Arrived — idle a beat, then pick a new spot.
              g.pause = 60 + Math.floor(Math.random() * 180);
              const next = pickWaypoint();
              g.tx = next.x; g.ty = next.y;
            } else {
              g.face = dx < 0 ? -1 : 1;
              g.x += (dx / d) * g.speed;
              g.y += (dy / d) * g.speed;
            }
          }
          g.el.style.left = g.x + "%";
          g.el.style.top  = g.y + "%";
          g.el.classList.toggle("face-left", g.face < 0);
          if (g.bubbleUntil && Date.now() > g.bubbleUntil) {
            const b = g.el.querySelector(".bubble");
            if (b) { b.textContent = ""; b.classList.remove("show"); }
            g.bubbleUntil = 0;
          }
        }
        // Fade non-goblin bubbles too
        document.querySelectorAll(".sprite:not(.sprite-goblin) .bubble.show").forEach((b) => {
          const until = Number(b.dataset.until || 0);
          if (Date.now() > until) { b.textContent = ""; b.classList.remove("show"); }
        });
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);

      // ============================================================
      //  Speech bubbles — pick the right sprite, position above OR
      //  below depending on the sprite's vertical position so they
      //  never get clipped at the top of the stage.
      // ============================================================
      function spriteFor(speaker, idx) {
        if (speaker === "goblin" && typeof idx === "number") {
          return stage.querySelector('.sprite-goblin[data-idx="' + idx + '"]');
        }
        return stage.querySelector(".sprite-" + speaker);
      }

      function popBubble(speaker, idx, text) {
        const el = spriteFor(speaker, idx);
        if (!el) return;
        const b = el.querySelector(".bubble");
        if (!b) return;
        b.textContent = text.length > 80 ? text.slice(0, 77) + "…" : text;
        b.classList.add("show");
        // Decide flip-down vs flip-up based on actual position
        const rect = el.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        const flip = (rect.top - stageRect.top) < 80;
        b.classList.toggle("below", flip);
        const until = Date.now() + 4500;
        b.dataset.until = String(until);
        if (el.classList.contains("sprite-goblin")) {
          const g = gState.find((s) => s.el === el);
          if (g) g.bubbleUntil = until;
        }
      }

      // ============================================================
      //  Live chatter feed — filterable, smart autoscroll
      // ============================================================
      const chatter = document.getElementById("chatter");
      const status = document.getElementById("conn-status");
      const fNews    = document.getElementById("filter-news");
      const fChatter = document.getElementById("filter-chatter");
      const fSystem  = document.getElementById("filter-system");
      const fTime    = document.getElementById("show-time");
      const MAX_LINES = 80;
      const SPEAKER_ICON = {
        goblin:  ${JSON.stringify(glyph("goblin", 12))},
        gremlin: ${JSON.stringify(glyph("gremlin", 12))},
        troll:   ${JSON.stringify(glyph("troll", 12))},
        raccoon: ${JSON.stringify(glyph("raccoon", 12))},
        ogre:    ${JSON.stringify(glyph("ogre", 12))},
        pigeon:  ${JSON.stringify(glyph("pigeon", 12))},
        town:    ${JSON.stringify(glyph("town", 12))},
      };
      // Toggle a class so CSS can hide/show times in one place
      function applyTimeVisibility() { chatter.classList.toggle("show-time", fTime.checked); }
      fTime.addEventListener("change", applyTimeVisibility);
      applyTimeVisibility();

      function passesFilter(ev) {
        if (ev.kind === "news"    && !fNews.checked)    return false;
        if (ev.kind === "chatter" && !fChatter.checked) return false;
        if (ev.kind === "system"  && !fSystem.checked)  return false;
        return true;
      }

      function isAtBottom() {
        return chatter.scrollHeight - chatter.scrollTop - chatter.clientHeight < 30;
      }

      function append(ev) {
        // Always pop the bubble on the stage, even if filtered from feed
        popBubble(ev.speaker, ev.speakerIdx, ev.text);
        if (!passesFilter(ev)) return;

        const stick = isAtBottom();
        const row = document.createElement("div");
        row.className = "msg msg-" + ev.kind + " spk-" + ev.speaker + (ev.replyTo ? " reply" : "");
        const time = new Date(ev.ts).toLocaleTimeString([], { hour12: false });
        const speakerLabel = ev.speaker + (ev.speakerIdx !== undefined ? "·" + ev.speakerIdx : "");
        row.innerHTML =
          '<span class="msg-time">' + time + '</span>' +
          '<span class="msg-chip"><span class="msg-icon">' + (SPEAKER_ICON[ev.speaker] || "·") + '</span>' +
          '<span class="msg-speaker"></span></span>' +
          '<span class="msg-text"></span>';
        row.querySelector(".msg-speaker").textContent = speakerLabel;
        row.querySelector(".msg-text").textContent = ev.text;
        chatter.appendChild(row);
        while (chatter.children.length > MAX_LINES) chatter.removeChild(chatter.firstChild);
        if (stick) chatter.scrollTop = chatter.scrollHeight;
      }

      function connect() {
        const es = new EventSource("/api/town/stream");
        es.addEventListener("open", () => {
          status.textContent = "● live";
          status.classList.remove("off"); status.classList.add("on");
        });
        const handler = (e) => { try { append(JSON.parse(e.data)); } catch {} };
        es.addEventListener("chatter", handler);
        es.addEventListener("news",    handler);
        es.addEventListener("system",  handler);
        es.addEventListener("error", () => {
          status.textContent = "○ reconnecting…";
          status.classList.remove("on"); status.classList.add("off");
          es.close();
          setTimeout(connect, 1500);
        });
      }
      connect();
    </script>
  `;
}

async function renderRite(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const rite = await warren.hoard.getRite(req.params.id);
  if (!rite) {
    res.status(404).send(layout("Not Found", warren, "<h1>Rite not found</h1>"));
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
  res.send(layout(`Rite ${rite.id}`, warren, body));
}

async function renderQuest(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const quests = await warren.hoard.allQuests();
  const quest = quests.find((q) => q.id === req.params.id);
  if (!quest) {
    res.status(404).send(layout("Not Found", warren, "<h1>Quest not found</h1>"));
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
  res.send(layout(`Quest ${quest.id}`, warren, body));
}

async function renderLoot(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const loot = await warren.hoard.getLoot(req.params.id);
  if (!loot) {
    res.status(404).send(layout("Not Found", warren, "<h1>Loot not found</h1>"));
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
  res.send(layout(`Loot ${loot.id}`, warren, body));
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

    <h1>Drift report</h1>
    <p class="muted">Cross-creature mentions / total words. High = reward signal is leaking.</p>
    <table>
      <tr><th>Creature</th><th>n</th><th>avg drift rate</th></tr>
      ${rows}
    </table>
    <p class="muted">${all.length} total loot drops scanned.</p>
  `;
  res.send(layout("Drift", warren, body));
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

    <h1>Inbox (${msgs.length})</h1>
    <table>
      <tr><th>id</th><th>from</th><th>audience</th><th>signature</th><th>body</th></tr>
      ${rows || `<tr><td colspan="5" class="muted">empty</td></tr>`}
    </table>
  `;
  res.send(layout("Inbox", warren, body));
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

    <h1>Outbox (${recs.length})</h1>
    <table>
      <tr><th>id</th><th>to</th><th>audience</th><th>source loot</th><th>pigeon loot</th><th>signature</th></tr>
      ${rows || `<tr><td colspan="6" class="muted">empty</td></tr>`}
    </table>
  `;
  res.send(layout("Outbox", warren, body));
}

async function renderHoard(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const kindFilter = (req.query.kind as string | undefined)?.toLowerCase();
  const personalityFilter = (req.query.personality as string | undefined)?.toLowerCase();
  const riteFilter = req.query.rite as string | undefined;
  const limit = Math.min(Number(req.query.limit ?? "100") || 100, 1000);

  let all = await warren.hoard.allLoot();
  if (kindFilter && CREATURE_KINDS.includes(kindFilter as CreatureKind)) {
    all = all.filter((l) => l.creatureKind === kindFilter);
  }
  if (personalityFilter) {
    all = all.filter((l) => l.personality === personalityFilter);
  }
  if (riteFilter) {
    all = all.filter((l) => l.riteId === riteFilter);
  }
  all.sort((a, b) => b.timestamp - a.timestamp);
  const visible = all.slice(0, limit);

  const opt = (v: string, sel: string | undefined, label?: string) =>
    `<option value="${esc(v)}"${sel === v ? " selected" : ""}>${esc(label ?? (v || "(any)"))}</option>`;

  const filters = `
    <form method="get" class="filters">
      <label>kind
        <select name="kind">${["", ...CREATURE_KINDS].map((k) => opt(k, kindFilter)).join("")}</select>
      </label>
      <label>personality
        <select name="personality">${["", "nerdy", "cynical", "chipper", "stoic", "feral"].map((p) => opt(p, personalityFilter)).join("")}</select>
      </label>
      <label>rite id <input name="rite" type="text" value="${esc(riteFilter ?? "")}" size="14"></label>
      <label>limit <input name="limit" type="number" value="${limit}" min="1" max="1000"></label>
      <button type="submit">filter</button>
    </form>
  `;

  const rows = visible
    .map((l) => {
      const tok = l.usage?.totalTokens ?? 0;
      return `<tr>
        <td><a href="/loot/${esc(l.id)}">${esc(l.id)}</a></td>
        <td>${esc(l.creatureKind)}</td>
        <td>${esc(l.personality)}</td>
        <td>${esc(l.model)}</td>
        <td>${tok}</td>
        <td>${l.drift.driftRate.toFixed(4)}</td>
        <td>${l.reward !== undefined ? l.reward.toFixed(3) : "—"}</td>
        <td>${l.riteId ? `<a href="/rite/${esc(l.riteId)}">${esc(l.riteId)}</a>` : "—"}</td>
        <td>${esc(new Date(l.timestamp).toISOString().slice(0, 19).replace("T", " "))}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <h1>Hoard browser</h1>
    <p class="muted">${all.length} matching · showing ${visible.length}</p>
    ${filters}
    <table>
      <tr>
        <th>id</th><th>kind</th><th>personality</th><th>model</th>
        <th>tokens</th><th>drift</th><th>shinies</th><th>rite</th><th>timestamp</th>
      </tr>
      ${rows || `<tr><td colspan="9" class="muted">no matches</td></tr>`}
    </table>
  `;
  res.send(layout("Hoard browser", warren, body));
}

async function renderRunDetail(
  warren: Warren,
  runs: Map<string, RunState>,
  req: Request,
  res: Response,
): Promise<void> {
  const state = runs.get(req.params.runId);
  if (!state) {
    res.status(404).send(layout("Not Found", warren, "<h1>Run not found</h1>"));
    return;
  }
  const r = state.record;
  const status = r.done
    ? r.error
      ? `<span class="tag tag-error">error</span>`
      : `<span class="tag tag-done">done</span>`
    : `<span class="tag tag-running">running</span>`;
  const ritePtr = r.finalRiteId
    ? `<a href="/rite/${esc(r.finalRiteId)}">${esc(r.finalRiteId)}</a>`
    : "—";
  const body = `
    <h1>Run ${esc(r.runId)}</h1>
    <p class="muted">${status} · pack=${r.packSize} · personality=${esc(r.personality ?? "default")} · started ${esc(new Date(r.startedAt).toISOString())} · rite=${ritePtr}</p>
    <h2>Task</h2>
    <pre>${esc(r.task)}</pre>
    ${r.error ? `<h2>Error</h2><pre class="evt-error">${esc(r.error)}</pre>` : ""}
    <h2>Stream (${r.events.length} event${r.events.length === 1 ? "" : "s"})</h2>
    <pre id="log"></pre>
    <p id="winner-link">${r.finalRiteId ? `<a href="/rite/${esc(r.finalRiteId)}">→ view rite ${esc(r.finalRiteId)}</a>` : ""}</p>
    <script>
      const log = document.getElementById("log");
      const winnerLink = document.getElementById("winner-link");
      const append = (cls, s) => {
        const span = document.createElement("span");
        span.className = "evt-" + cls;
        span.textContent = s + "\\n";
        log.appendChild(span);
        log.scrollTop = log.scrollHeight;
      };
      const isDone = ${r.done ? "true" : "false"};
      const es = isDone ? null : new EventSource("/api/rite/${esc(r.runId)}/stream");
      const replay = ${JSON.stringify(r.events)};
      for (const ev of replay) {
        const cls = ev.kind === "done" ? "done" : ev.kind === "error" ? "error" : ev.kind === "step" ? "step" : "meta";
        append(cls, "[" + ev.kind + "] " + JSON.stringify(ev.data));
      }
      if (es) {
        const seen = new Set(replay.map(e => e.seq));
        es.addEventListener("step", (ev) => {
          const id = Number(ev.lastEventId);
          if (seen.has(id)) return;
          seen.add(id);
          append("step", "[step] " + ev.data);
        });
        es.addEventListener("done", (ev) => {
          append("done", "[done] " + ev.data);
          try { const d = JSON.parse(ev.data); if (d.riteId) winnerLink.innerHTML = '<a href="/rite/' + d.riteId + '">→ view rite ' + d.riteId + '</a>'; } catch {}
          es.close();
        });
        es.addEventListener("error", () => append("error", "[connection closed]"));
      }
    </script>
  `;
  res.send(layout(`Run ${r.runId}`, warren, body));
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

function layout(title: string, warren: Warren, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(title)} · Goblintown</title>
<link rel="stylesheet" href="/static/app.css" />
</head>
<body>
<nav class="topnav">
  <a class="brand" href="/">Goblintown</a>
  <a href="/town">Town</a>
  <a href="/rite/new" class="nav-cta">+ New rite</a>
  <a href="/hoard">Hoard</a>
  <details class="nav-more">
    <summary>More ▾</summary>
    <div class="nav-more-menu">
      <a href="/runs">Runs</a>
      <a href="/drift">Drift report</a>
      <a href="/inbox">Inbox</a>
      <a href="/outbox">Outbox</a>
      <a href="/welcome">What is this?</a>
    </div>
  </details>
  <span class="spacer"></span>
  <a href="/welcome" class="nav-help" title="New here?">?</a>
  <span class="warren-name">warren: ${esc(warren.manifest.name)}</span>
</nav>
<main>
${body}
</main>
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
  // Curated example tasks — give first-time users a one-click way to see
  // the pipeline in action without staring at a blank textarea.
  const examples = [
    {
      title: "Refactor",
      task: "Refactor this function to be more readable and add JSDoc comments.",
      glob: "src/**/*.ts",
    },
    {
      title: "Bug hunt",
      task: "Find potential bugs, race conditions, or off-by-one errors in this code.",
      glob: "src/**/*.ts",
    },
    {
      title: "Write tests",
      task: "Write a node:test suite covering the happy paths and edge cases.",
      glob: "src/**/*.ts",
    },
    {
      title: "Explain",
      task: "Explain what this code does in plain English. Then suggest one improvement.",
      glob: "README.md",
    },
  ];
  const exampleChips = examples
    .map(
      (e, i) =>
        `<button type="button" class="example-chip" data-example="${i}">
          <strong>${esc(e.title)}</strong>${esc(e.task)}
        </button>`,
    )
    .join("");

  return `
    <h1>+ New rite</h1>
    <p class="muted">A rite runs the full pipeline: Raccoon scavenges → Goblin pack drafts → Gremlin audits → Troll judges → (optional) Ogre fallback.</p>

    <h2>Quick start</h2>
    <div class="examples">${exampleChips}</div>

    <form id="rite-form" class="form-card">
      <div class="form-row" style="flex-direction:column;align-items:stretch;">
        <label style="width:100%;">Task <span class="char-count" id="char-count">0 chars</span>
          <textarea name="task" rows="4" placeholder="What should the goblins solve?" required></textarea>
        </label>
      </div>

      <div class="form-row">
        <label>Pack size
          <input name="packSize" type="number" value="3" min="1" max="9" style="width:5rem;">
        </label>
        <label>Personality
          <select name="personality">
            <option value="nerdy">nerdy</option>
            <option value="cynical">cynical</option>
            <option value="chipper">chipper</option>
            <option value="stoic">stoic</option>
            <option value="feral">feral</option>
          </select>
        </label>
        <label class="inline">
          <input type="checkbox" name="noFallback"> skip Ogre fallback
        </label>
      </div>

      <details class="advanced">
        <summary>Advanced — scan globs (Raccoon scavenge)</summary>
        <div class="form-row" style="flex-direction:column;align-items:stretch;margin-top:.5rem;">
          <label style="width:100%;">Globs (one per line)
            <textarea name="scanGlobs" rows="3" placeholder="src/**/*.ts"></textarea>
          </label>
        </div>
      </details>

      <div class="form-row">
        <button class="btn" type="submit" id="submit-btn">Begin rite</button>
        <span class="muted" id="submit-status"></span>
      </div>
    </form>

    <h2>Pack progress</h2>
    <div class="pack-progress" id="pack-progress"></div>

    <h2>Live timeline</h2>
    <div class="event-timeline" id="timeline">
      <div class="event-row k-info"><span class="icon">·</span><span class="label">idle</span><span class="text">Submit a task above to begin.</span></div>
    </div>
    <p id="winner-link"></p>

    <script>
      const examples = ${JSON.stringify(examples)};
      const form = document.getElementById("rite-form");
      const taskEl = form.elements["task"];
      const charCount = document.getElementById("char-count");
      const submitBtn = document.getElementById("submit-btn");
      const submitStatus = document.getElementById("submit-status");
      const timeline = document.getElementById("timeline");
      const packProgress = document.getElementById("pack-progress");
      const winnerLink = document.getElementById("winner-link");

      // char counter
      function updateChars() { charCount.textContent = (taskEl.value || "").length + " chars"; }
      taskEl.addEventListener("input", updateChars);

      // example chips
      document.querySelectorAll(".example-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const ex = examples[Number(chip.dataset.example)];
          taskEl.value = ex.task;
          form.elements["scanGlobs"].value = ex.glob;
          updateChars();
          taskEl.focus();
        });
      });

      // event icons + classifier
      function classify(kind, data) {
        const k = String(kind || "").toLowerCase();
        if (k === "done") return { cls: "done", icon: "OK", label: "DONE" };
        if (k === "error") return { cls: "error", icon: "!", label: "ERROR" };
        if (k === "reward-plugin") return { cls: "info", icon: "+", label: "REWARD" };
        const sub = String(data && data.kind || "").toLowerCase();
        if (sub.includes("raccoon")) return { cls: "raccoon", icon: "R", label: "RACCOON" };
        if (sub.includes("goblin"))  return { cls: "goblin",  icon: "G", label: "GOBLIN" };
        if (sub.includes("gremlin")) return { cls: "gremlin", icon: "K", label: "GREMLIN" };
        if (sub.includes("troll"))   return { cls: "troll",   icon: "T", label: "TROLL" };
        if (sub.includes("ogre"))    return { cls: "ogre",    icon: "O", label: "OGRE" };
        return { cls: "info", icon: "·", label: (sub || "step").toUpperCase() };
      }

      function summarize(kind, data) {
        if (kind === "done") {
          return "outcome=" + data.outcome + " · rite=" + data.riteId;
        }
        if (kind === "error") return data.message || JSON.stringify(data);
        if (kind === "reward-plugin") return "source=" + (data.source || "");
        const sub = data && data.kind || "step";
        const tail = data && (data.lootId || data.id);
        const idx = (data && (data.index !== undefined)) ? " #" + data.index : "";
        return sub + idx + (tail ? " — " + tail : "");
      }

      function append(kind, data) {
        if (timeline.firstChild && timeline.firstChild.classList.contains("k-info") &&
            timeline.firstChild.querySelector(".label")?.textContent === "IDLE") {
          timeline.innerHTML = "";
        }
        const c = classify(kind, data);
        const row = document.createElement("div");
        row.className = "event-row k-" + c.cls;
        row.innerHTML =
          '<span class="icon">' + c.icon + '</span>' +
          '<span class="label">' + c.label + '</span>' +
          '<span class="text"></span>';
        row.querySelector(".text").textContent = summarize(kind, data);
        timeline.appendChild(row);
        timeline.scrollTop = timeline.scrollHeight;
      }

      // pack slots
      function buildPack(n) {
        packProgress.innerHTML = "";
        for (let i = 0; i < n; i++) {
          const s = document.createElement("div");
          s.className = "pack-slot";
          s.dataset.idx = String(i);
          s.textContent = String(i + 1);
          packProgress.appendChild(s);
        }
      }
      function setSlot(i, state) {
        const s = packProgress.querySelector('[data-idx="' + i + '"]');
        if (s) { s.classList.remove("active","done","fail","winner"); s.classList.add(state); }
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        timeline.innerHTML = "";
        winnerLink.innerHTML = "";
        submitBtn.disabled = true;
        submitStatus.textContent = "starting...";

        const fd = new FormData(form);
        const packSize = Number(fd.get("packSize") || 3);
        buildPack(packSize);
        const scanGlobs = (fd.get("scanGlobs") || "").toString().split(/\\r?\\n/).map(s => s.trim()).filter(Boolean);
        const payload = {
          task: fd.get("task"),
          packSize,
          personality: fd.get("personality"),
          noFallback: !!fd.get("noFallback"),
          scanGlobs,
        };
        append("info", { kind: "submit", id: "POST /api/rite" });
        const startRes = await fetch("/api/rite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!startRes.ok) {
          append("error", { message: await startRes.text() });
          submitBtn.disabled = false;
          submitStatus.textContent = "failed";
          return;
        }
        const { runId } = await startRes.json();
        submitStatus.innerHTML = 'streaming · <a href="/run/' + runId + '">run ' + runId + '</a>';
        const es = new EventSource("/api/rite/" + runId + "/stream");

        es.addEventListener("step", (ev) => {
          let d = {};
          try { d = JSON.parse(ev.data); } catch {}
          append("step", d);
          // pack-slot animation: mark goblin index active when it starts, done when finished
          if (d.kind === "pack:goblin" && typeof d.index === "number") setSlot(d.index, "done");
          if (d.kind === "troll:verdict" && typeof d.index === "number") {
            setSlot(d.index, d.passed ? "done" : "fail");
          }
        });
        es.addEventListener("reward-plugin", (ev) => {
          let d = {}; try { d = JSON.parse(ev.data); } catch {}
          append("reward-plugin", d);
        });
        es.addEventListener("done", (ev) => {
          let d = {}; try { d = JSON.parse(ev.data); } catch {}
          append("done", d);
          if (typeof d.winnerIndex === "number") setSlot(d.winnerIndex, "winner");
          if (d.riteId) winnerLink.innerHTML = '<a class="btn" href="/rite/' + d.riteId + '">→ View rite ' + d.riteId + '</a>';
          submitBtn.disabled = false;
          submitStatus.textContent = "done";
          es.close();
        });
        es.addEventListener("error", (ev) => {
          let msg = "(connection error)";
          try { msg = JSON.parse(ev.data).message; } catch {}
          append("error", { message: msg });
          submitBtn.disabled = false;
          submitStatus.textContent = "error";
          es.close();
        });
      });
    </script>
  `;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
