import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HoardBackend } from "./hoard-backend.js";
import type { InboxMessage, Loot, OutboxRecord, Quest, Rite } from "./types.js";

/**
 * On-disk JSON backend. One file per record, organised under
 *   <dir>/{loot,quests,rites,inbox,outbox}/<id>.json
 *
 * This is the default backend and matches Goblintown's original layout, so
 * existing Hoards keep working byte-for-byte.
 */
export class JsonHoardBackend implements HoardBackend {
  constructor(private readonly dir: string) {}

  private get lootDir() {
    return join(this.dir, "loot");
  }
  private get questDir() {
    return join(this.dir, "quests");
  }
  private get riteDir() {
    return join(this.dir, "rites");
  }
  private get inboxDir() {
    return join(this.dir, "inbox");
  }
  private get outboxDir() {
    return join(this.dir, "outbox");
  }

  async init(): Promise<void> {
    await mkdir(this.lootDir, { recursive: true });
    await mkdir(this.questDir, { recursive: true });
    await mkdir(this.riteDir, { recursive: true });
    await mkdir(this.inboxDir, { recursive: true });
    await mkdir(this.outboxDir, { recursive: true });
  }

  async putLoot(loot: Loot): Promise<void> {
    await writeFile(
      join(this.lootDir, `${loot.id}.json`),
      JSON.stringify(loot, null, 2),
      "utf8",
    );
  }

  async getLoot(id: string): Promise<Loot | null> {
    return readJson<Loot>(join(this.lootDir, `${id}.json`));
  }

  async allLoot(): Promise<Loot[]> {
    return readJsonDir<Loot>(this.lootDir);
  }

  async putQuest(quest: Quest): Promise<void> {
    await writeFile(
      join(this.questDir, `${quest.id}.json`),
      JSON.stringify(quest, null, 2),
      "utf8",
    );
  }

  async allQuests(): Promise<Quest[]> {
    return readJsonDir<Quest>(this.questDir);
  }

  async putRite(rite: Rite): Promise<void> {
    await writeFile(
      join(this.riteDir, `${rite.id}.json`),
      JSON.stringify(rite, null, 2),
      "utf8",
    );
  }

  async getRite(id: string): Promise<Rite | null> {
    return readJson<Rite>(join(this.riteDir, `${id}.json`));
  }

  async allRites(): Promise<Rite[]> {
    return readJsonDir<Rite>(this.riteDir);
  }

  async putInbox(msg: InboxMessage): Promise<void> {
    await writeFile(
      join(this.inboxDir, `${msg.id}.json`),
      JSON.stringify(msg, null, 2),
      "utf8",
    );
  }

  async allInbox(): Promise<InboxMessage[]> {
    return readJsonDir<InboxMessage>(this.inboxDir);
  }

  async putOutbox(rec: OutboxRecord): Promise<void> {
    await writeFile(
      join(this.outboxDir, `${rec.id}.json`),
      JSON.stringify(rec, null, 2),
      "utf8",
    );
  }

  async allOutbox(): Promise<OutboxRecord[]> {
    return readJsonDir<OutboxRecord>(this.outboxDir);
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readJsonDir<T>(dir: string): Promise<T[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const item = await readJson<T>(join(dir, name));
    if (item) out.push(item);
  }
  return out;
}
