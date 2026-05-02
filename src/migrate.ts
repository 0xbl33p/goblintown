import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hoard } from "./hoard.js";
import type { HoardBackend } from "./hoard-backend.js";
import { JsonHoardBackend } from "./hoard-json.js";
import { SqliteHoardBackend } from "./hoard-sqlite.js";
import type { WarrenManifest } from "./types.js";

export interface MigrateResult {
  loot: number;
  quests: number;
  rites: number;
  inbox: number;
  outbox: number;
}

/**
 * Copy every record from `from` into `to`. Idempotent: re-running over an
 * already-populated destination just rewrites the same rows.
 */
export async function copyHoard(
  from: HoardBackend,
  to: HoardBackend,
): Promise<MigrateResult> {
  await to.init();
  const fromHoard = wrap(from);
  const toHoard = wrap(to);

  const loot = await fromHoard.allLoot();
  for (const l of loot) await to.putLoot(l);

  const quests = await fromHoard.allQuests();
  for (const q of quests) await to.putQuest(q);

  const rites = await fromHoard.allRites();
  for (const r of rites) await to.putRite(r);

  const inbox = await fromHoard.allInbox();
  for (const m of inbox) await to.putInbox(m);

  const outbox = await fromHoard.allOutbox();
  for (const o of outbox) await to.putOutbox(o);

  return {
    loot: loot.length,
    quests: quests.length,
    rites: rites.length,
    inbox: inbox.length,
    outbox: outbox.length,
  };
}

/**
 * Migrate a Warren in place between storage backends. Reads the manifest,
 * copies every record from the existing backend to the requested one, then
 * rewrites the manifest. The source data is NOT deleted; the user can wipe it
 * after verifying.
 */
export async function migrateWarren(
  warrenRoot: string,
  to: "json" | "sqlite",
): Promise<MigrateResult> {
  const manifestPath = join(warrenRoot, ".goblintown", "warren.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as WarrenManifest;
  const current = manifest.storage ?? "json";
  if (current === to) {
    throw new Error(`Warren already uses ${to} storage.`);
  }
  const hoardDir = join(warrenRoot, ".goblintown", "hoard");
  const fromBackend: HoardBackend =
    current === "sqlite"
      ? new SqliteHoardBackend(join(hoardDir, "hoard.db"))
      : new JsonHoardBackend(hoardDir);
  const toBackend: HoardBackend =
    to === "sqlite"
      ? new SqliteHoardBackend(join(hoardDir, "hoard.db"))
      : new JsonHoardBackend(hoardDir);

  await fromBackend.init();
  const result = await copyHoard(fromBackend, toBackend);

  manifest.storage = to;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return result;
}

function wrap(backend: HoardBackend): Hoard {
  // Hoard accepts a backend; the dir argument is only used for path-style
  // accessors which migrate doesn't need.
  return new Hoard("", backend);
}
