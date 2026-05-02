import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database, { type Database as Db } from "better-sqlite3";
import type { HoardBackend } from "./hoard-backend.js";
import type { InboxMessage, Loot, OutboxRecord, Quest, Rite } from "./types.js";

/**
 * SQLite-backed Hoard. Single file, one row per record. JSON blobs are stored
 * verbatim so the on-disk format keeps parity with JsonHoardBackend; the
 * indexed columns are projections used by the audit / drift / hoard-list paths.
 *
 * better-sqlite3 is synchronous; we still expose the async HoardBackend API so
 * the rest of the codebase doesn't have to care which backend is wired in.
 */
export class SqliteHoardBackend implements HoardBackend {
  private db: Db | null = null;

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(SCHEMA);
    this.db = db;
  }

  private get conn(): Db {
    if (!this.db) {
      throw new Error("SqliteHoardBackend used before init()");
    }
    return this.db;
  }

  async putLoot(loot: Loot): Promise<void> {
    this.conn
      .prepare(
        `INSERT OR REPLACE INTO loot
           (id, kind, personality, model, rite_id, quest_id, drift_rate, total_tokens, ts, json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        loot.id,
        loot.creatureKind,
        loot.personality,
        loot.model,
        loot.riteId ?? null,
        loot.questId ?? null,
        loot.drift.driftRate,
        loot.usage?.totalTokens ?? 0,
        loot.timestamp,
        JSON.stringify(loot),
      );
  }

  async getLoot(id: string): Promise<Loot | null> {
    return this.selectJson<Loot>("SELECT json FROM loot WHERE id = ?", id);
  }

  async allLoot(): Promise<Loot[]> {
    return this.selectAllJson<Loot>("SELECT json FROM loot");
  }

  async putQuest(quest: Quest): Promise<void> {
    this.conn
      .prepare(
        `INSERT OR REPLACE INTO quests (id, started_at, finished_at, json) VALUES (?,?,?,?)`,
      )
      .run(quest.id, quest.startedAt, quest.finishedAt ?? null, JSON.stringify(quest));
  }

  async allQuests(): Promise<Quest[]> {
    return this.selectAllJson<Quest>("SELECT json FROM quests");
  }

  async putRite(rite: Rite): Promise<void> {
    this.conn
      .prepare(
        `INSERT OR REPLACE INTO rites (id, outcome, started_at, finished_at, json)
         VALUES (?,?,?,?,?)`,
      )
      .run(
        rite.id,
        rite.outcome,
        rite.startedAt,
        rite.finishedAt ?? null,
        JSON.stringify(rite),
      );
  }

  async getRite(id: string): Promise<Rite | null> {
    return this.selectJson<Rite>("SELECT json FROM rites WHERE id = ?", id);
  }

  async allRites(): Promise<Rite[]> {
    return this.selectAllJson<Rite>("SELECT json FROM rites");
  }

  async putInbox(msg: InboxMessage): Promise<void> {
    this.conn
      .prepare(
        `INSERT OR REPLACE INTO inbox (id, received_at, from_warren, json) VALUES (?,?,?,?)`,
      )
      .run(msg.id, msg.receivedAt, msg.fromWarren, JSON.stringify(msg));
  }

  async allInbox(): Promise<InboxMessage[]> {
    return this.selectAllJson<InboxMessage>("SELECT json FROM inbox");
  }

  async putOutbox(rec: OutboxRecord): Promise<void> {
    this.conn
      .prepare(
        `INSERT OR REPLACE INTO outbox (id, sent_at, to_warren, json) VALUES (?,?,?,?)`,
      )
      .run(rec.id, rec.sentAt, rec.toWarren, JSON.stringify(rec));
  }

  async allOutbox(): Promise<OutboxRecord[]> {
    return this.selectAllJson<OutboxRecord>("SELECT json FROM outbox");
  }

  private selectJson<T>(sql: string, ...params: unknown[]): T | null {
    const row = this.conn.prepare(sql).get(...params) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : null;
  }

  private selectAllJson<T>(sql: string): T[] {
    const rows = this.conn.prepare(sql).all() as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as T);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS loot (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  personality TEXT NOT NULL,
  model TEXT NOT NULL,
  rite_id TEXT,
  quest_id TEXT,
  drift_rate REAL NOT NULL,
  total_tokens INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS loot_kind_ts ON loot(kind, ts);
CREATE INDEX IF NOT EXISTS loot_rite ON loot(rite_id);
CREATE INDEX IF NOT EXISTS loot_quest ON loot(quest_id);

CREATE TABLE IF NOT EXISTS quests (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rites (
  id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rites_outcome_ts ON rites(outcome, started_at);

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  from_warren TEXT NOT NULL,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL,
  to_warren TEXT NOT NULL,
  json TEXT NOT NULL
);
`;
