import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Artifact,
  DirectMessage,
  DirectMessageThread,
  FriendRecord,
  FriendRequest,
  InboxMessage,
  Loot,
  OutboxRecord,
  Quest,
  Rite,
} from "./types.js";

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

  get artifactDir(): string {
    return join(this.dir, "artifacts");
  }

  get friendsDir(): string {
    return join(this.dir, "friends");
  }

  get friendRequestsDir(): string {
    return join(this.dir, "friend-requests");
  }

  get dmThreadsDir(): string {
    return join(this.dir, "dm-threads");
  }

  get dmMessagesDir(): string {
    return join(this.dir, "dm-messages");
  }

  async init(): Promise<void> {
    await mkdir(this.lootDir, { recursive: true });
    await mkdir(this.questDir, { recursive: true });
    await mkdir(this.riteDir, { recursive: true });
    await mkdir(this.inboxDir, { recursive: true });
    await mkdir(this.outboxDir, { recursive: true });
    await mkdir(this.artifactDir, { recursive: true });
    await mkdir(this.friendsDir, { recursive: true });
    await mkdir(this.friendRequestsDir, { recursive: true });
    await mkdir(this.dmThreadsDir, { recursive: true });
    await mkdir(this.dmMessagesDir, { recursive: true });
  }

  async stash(loot: Loot): Promise<string> {
    const id = contentAddress(loot.model, loot.prompt, loot.output);
    loot.id = id;
    await mkdir(this.lootDir, { recursive: true });
    await writeFile(
      join(this.lootDir, `${id}.json`),
      JSON.stringify(loot, null, 2),
      "utf8",
    );
    return id;
  }

  async stashQuest(quest: Quest): Promise<void> {
    await mkdir(this.questDir, { recursive: true });
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
    await mkdir(this.riteDir, { recursive: true });
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
    await mkdir(this.inboxDir, { recursive: true });
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
    await mkdir(this.outboxDir, { recursive: true });
    await writeFile(
      join(this.outboxDir, `${rec.id}.json`),
      JSON.stringify(rec, null, 2),
      "utf8",
    );
  }

  async allOutbox(): Promise<OutboxRecord[]> {
    return readJsonDir<OutboxRecord>(this.outboxDir);
  }

  async stashArtifact(art: Artifact): Promise<void> {
    await mkdir(this.artifactDir, { recursive: true });
    await writeFile(
      join(this.artifactDir, `${art.id}.json`),
      JSON.stringify(art, null, 2),
      "utf8",
    );
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    try {
      const raw = await readFile(join(this.artifactDir, `${id}.json`), "utf8");
      return JSON.parse(raw) as Artifact;
    } catch {
      return null;
    }
  }

  async getArtifactByRiteId(riteId: string): Promise<Artifact | null> {
    const all = await this.allArtifacts();
    return all.find((a) => a.riteId === riteId) ?? null;
  }

  async allArtifacts(): Promise<Artifact[]> {
    return readJsonDir<Artifact>(this.artifactDir);
  }

  async stashFriend(friend: FriendRecord): Promise<void> {
    await mkdir(this.friendsDir, { recursive: true });
    await writeFile(
      join(this.friendsDir, `${friend.id}.json`),
      JSON.stringify(friend, null, 2),
      "utf8",
    );
  }

  async allFriends(): Promise<FriendRecord[]> {
    return readJsonDir<FriendRecord>(this.friendsDir);
  }

  async removeFriend(friendId: string): Promise<void> {
    await unlink(join(this.friendsDir, `${friendId}.json`)).catch(() => {});
  }

  async stashFriendRequest(req: FriendRequest): Promise<void> {
    await mkdir(this.friendRequestsDir, { recursive: true });
    await writeFile(
      join(this.friendRequestsDir, `${req.id}.json`),
      JSON.stringify(req, null, 2),
      "utf8",
    );
  }

  async allFriendRequests(): Promise<FriendRequest[]> {
    return readJsonDir<FriendRequest>(this.friendRequestsDir);
  }

  async removeFriendRequest(reqId: string): Promise<void> {
    await unlink(join(this.friendRequestsDir, `${reqId}.json`)).catch(() => {});
  }

  async stashDmThread(thread: DirectMessageThread): Promise<void> {
    await mkdir(this.dmThreadsDir, { recursive: true });
    await writeFile(
      join(this.dmThreadsDir, `${thread.id}.json`),
      JSON.stringify(thread, null, 2),
      "utf8",
    );
  }

  async allDmThreads(): Promise<DirectMessageThread[]> {
    return readJsonDir<DirectMessageThread>(this.dmThreadsDir);
  }

  async getDmThread(threadId: string): Promise<DirectMessageThread | null> {
    try {
      const raw = await readFile(join(this.dmThreadsDir, `${threadId}.json`), "utf8");
      return JSON.parse(raw) as DirectMessageThread;
    } catch {
      return null;
    }
  }

  async stashDmMessage(msg: DirectMessage): Promise<void> {
    const threadDir = join(this.dmMessagesDir, msg.threadId);
    await mkdir(threadDir, { recursive: true });
    await writeFile(
      join(threadDir, `${msg.id}.json`),
      JSON.stringify(msg, null, 2),
      "utf8",
    );
  }

  async allDmMessages(threadId: string): Promise<DirectMessage[]> {
    return readJsonDir<DirectMessage>(join(this.dmMessagesDir, threadId));
  }

  async getDmMessage(threadId: string, messageId: string): Promise<DirectMessage | null> {
    try {
      const raw = await readFile(
        join(this.dmMessagesDir, threadId, `${messageId}.json`),
        "utf8",
      );
      return JSON.parse(raw) as DirectMessage;
    } catch {
      return null;
    }
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
