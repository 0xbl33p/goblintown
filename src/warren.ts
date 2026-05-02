import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { join } from "node:path";
import { Hoard } from "./hoard.js";
import type { WarrenManifest } from "./types.js";

const WARREN_DIRNAME = ".goblintown";
const MANIFEST_FILE = "warren.json";

export interface Warren {
  root: string;
  manifestPath: string;
  manifest: WarrenManifest;
  hoard: Hoard;
}

export async function initWarren(root: string): Promise<Warren> {
  const dir = join(root, WARREN_DIRNAME);
  await mkdir(dir, { recursive: true });
  const hoard = new Hoard(join(dir, "hoard"));
  await hoard.init();

  const manifestPath = join(dir, MANIFEST_FILE);
  const manifest: WarrenManifest = {
    name: pathBasename(root),
    version: 1,
    createdAt: new Date().toISOString(),
    defaultModelGoblin: process.env.GOBLINTOWN_MODEL_GOBLIN ?? "gpt-5.4-mini",
    defaultModelOgre: process.env.GOBLINTOWN_MODEL_OGRE ?? "gpt-5.5",
    defaultModelTroll: process.env.GOBLINTOWN_MODEL_TROLL ?? "gpt-5.4-mini",
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return { root, manifestPath, manifest, hoard };
}

export async function loadWarren(cwd: string): Promise<Warren> {
  const root = await findWarrenRoot(cwd);
  if (!root) {
    throw new Error(
      `No Warren found above ${cwd}. Run \`goblintown init\` first.`,
    );
  }
  const manifestPath = join(root, WARREN_DIRNAME, MANIFEST_FILE);
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as WarrenManifest;
  const hoard = new Hoard(join(root, WARREN_DIRNAME, "hoard"));
  return { root, manifestPath, manifest, hoard };
}

async function findWarrenRoot(start: string): Promise<string | null> {
  let cur = start;
  while (true) {
    const candidate = join(cur, WARREN_DIRNAME, MANIFEST_FILE);
    try {
      await access(candidate, FS.F_OK);
      return cur;
    } catch {
      // not here
    }
    const parent = pathDirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function pathBasename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function pathDirname(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  if (idx < 0) return p;
  return norm.slice(0, idx) || norm.slice(0, idx + 1);
}
