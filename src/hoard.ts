import { createHash } from "node:crypto";
import { join } from "node:path";
import type { HoardBackend } from "./hoard-backend.js";
import { JsonHoardBackend } from "./hoard-json.js";
import type { InboxMessage, Loot, OutboxRecord, Quest, Rite } from "./types.js";

/**
 * Hoard is the public storage interface for a Warren. It is backend-agnostic;
 * a JsonHoardBackend (default) or SqliteHoardBackend may be supplied.
 *
 * Loot ids are derived from sha256(model || prompt || output) so the same
 * (model, prompt, output) triple always produces the same id, regardless of
 * which backend persists it. That is the property federation / audit / compare
 * rely on.
 */
export class Hoard {
  private readonly backend: HoardBackend;
  // Path-style accessors are kept for callers that want the on-disk JSON
  // layout (external tooling, tests). They reference the conventional dirs
  // regardless of which backend is wired in.
  readonly lootDir: string;
  readonly questDir: string;
  readonly riteDir: string;
  readonly inboxDir: string;
  readonly outboxDir: string;

  constructor(dir: string, backend?: HoardBackend) {
    this.backend = backend ?? new JsonHoardBackend(dir);
    this.lootDir = join(dir, "loot");
    this.questDir = join(dir, "quests");
    this.riteDir = join(dir, "rites");
    this.inboxDir = join(dir, "inbox");
    this.outboxDir = join(dir, "outbox");
  }

  async init(): Promise<void> {
    await this.backend.init();
  }

  async stash(loot: Loot): Promise<string> {
    const id = contentAddress(loot.model, loot.prompt, loot.output);
    loot.id = id;
    await this.backend.putLoot(loot);
    return id;
  }

  async stashQuest(quest: Quest): Promise<void> {
    await this.backend.putQuest(quest);
  }

  async getLoot(id: string): Promise<Loot | null> {
    return this.backend.getLoot(id);
  }

  async allLoot(): Promise<Loot[]> {
    return this.backend.allLoot();
  }

  async allQuests(): Promise<Quest[]> {
    return this.backend.allQuests();
  }

  async stashRite(rite: Rite): Promise<void> {
    await this.backend.putRite(rite);
  }

  async getRite(id: string): Promise<Rite | null> {
    return this.backend.getRite(id);
  }

  async allRites(): Promise<Rite[]> {
    return this.backend.allRites();
  }

  async stashInbox(msg: InboxMessage): Promise<void> {
    await this.backend.putInbox(msg);
  }

  async allInbox(): Promise<InboxMessage[]> {
    return this.backend.allInbox();
  }

  async stashOutbox(rec: OutboxRecord): Promise<void> {
    await this.backend.putOutbox(rec);
  }

  async allOutbox(): Promise<OutboxRecord[]> {
    return this.backend.allOutbox();
  }
}

function contentAddress(model: string, prompt: string, output: string): string {
  return createHash("sha256")
    .update(model)
    .update("\0")
    .update(prompt)
    .update("\0")
    .update(output)
    .digest("hex")
    .slice(0, 16);
}
