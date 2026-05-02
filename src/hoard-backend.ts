import type { InboxMessage, Loot, OutboxRecord, Quest, Rite } from "./types.js";

/**
 * Storage backend for a Warren's Hoard. The Hoard class delegates to one of
 * these. The default is the on-disk JSON backend (one file per record);
 * SqliteHoardBackend stores everything in a single hoard.db.
 *
 * All methods must be safe to call concurrently from a single Node process.
 */
export interface HoardBackend {
  init(): Promise<void>;

  putLoot(loot: Loot): Promise<void>;
  getLoot(id: string): Promise<Loot | null>;
  allLoot(): Promise<Loot[]>;

  putQuest(quest: Quest): Promise<void>;
  allQuests(): Promise<Quest[]>;

  putRite(rite: Rite): Promise<void>;
  getRite(id: string): Promise<Rite | null>;
  allRites(): Promise<Rite[]>;

  putInbox(msg: InboxMessage): Promise<void>;
  allInbox(): Promise<InboxMessage[]>;

  putOutbox(rec: OutboxRecord): Promise<void>;
  allOutbox(): Promise<OutboxRecord[]>;
}
