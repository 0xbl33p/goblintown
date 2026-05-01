import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  access,
} from "node:fs/promises";
import { constants as FS } from "node:fs";
import { join } from "node:path";
import type { InboxMessage, Loot, OutboxRecord, Quest, Rite } from "./types.js";

export class Hoard {
  constructor(private readonly dir: string) {}

  get lootDir(): string {
    return join(this.dir, "loot");
  }

  get questDir(): string {
    return join(this.dir, "quests");
  }

  get riteDir(): string {
    return join(this.dir, "rites");
  }

  get inboxDir(): string {
    return join(this.dir, "inbox");
  }

  get outboxDir(): string {
    return join(this.dir, "outbox");
  }

  async init(): Promise<void> {
    await mkdir(this.lootDir, { recursive: true });
    await mkdir(this.questDir, { recursive: true });
    await mkdir(this.riteDir, { recursive: true });
    await mkdir(this.inboxDir, { recursive: true });
    await mkdir(this.outboxDir, { recursive: true });
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.dir, FS.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async stash(loot: Loot): Promise<string> {
    const id = contentAddress(loot.model, loot.prompt, loot.output);
    loot.id = id;
    await writeFile(
      join(this.lootDir, `${id}.json`),
      JSON.stringify(loot, null, 2),
      "utf8",
    );
    return id;
  }

  async stashQuest(quest: Quest): Promise<void> {
    await writeFile(
      join(this.questDir, `${quest.id}.json`),
      JSON.stringify(quest, null, 2),
      "utf8",
    );
  }

  async getLoot(id: string): Promise<Loot | null> {
    try {
      const raw = await readFile(join(this.lootDir, `${id}.json`), "utf8");
      return JSON.parse(raw) as Loot;
    } catch {
      return null;
    }
  }

  async allLoot(): Promise<Loot[]> {
    let entries: string[];
    try {
      entries = await readdir(this.lootDir);
    } catch {
      return [];
    }
    const out: Loot[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(this.lootDir, name), "utf8");
        out.push(JSON.parse(raw) as Loot);
      } catch {
        // skip malformed
      }
    }
    return out;
  }

  async allQuests(): Promise<Quest[]> {
    return readJsonDir<Quest>(this.questDir);
  }

  async stashRite(rite: Rite): Promise<void> {
    await writeFile(
      join(this.riteDir, `${rite.id}.json`),
      JSON.stringify(rite, null, 2),
      "utf8",
    );
  }

  async getRite(id: string): Promise<Rite | null> {
    try {
      const raw = await readFile(join(this.riteDir, `${id}.json`), "utf8");
      return JSON.parse(raw) as Rite;
    } catch {
      return null;
    }
  }

  async allRites(): Promise<Rite[]> {
    return readJsonDir<Rite>(this.riteDir);
  }

  async stashInbox(msg: InboxMessage): Promise<void> {
    await writeFile(
      join(this.inboxDir, `${msg.id}.json`),
      JSON.stringify(msg, null, 2),
      "utf8",
    );
  }

  async allInbox(): Promise<InboxMessage[]> {
    return readJsonDir<InboxMessage>(this.inboxDir);
  }

  async stashOutbox(rec: OutboxRecord): Promise<void> {
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
    try {
      const raw = await readFile(join(dir, name), "utf8");
      out.push(JSON.parse(raw) as T);
    } catch {
      // skip malformed entries
    }
  }
  return out;
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
