import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GOBLINTOWN_SIDECAR_SKILL_NAME = "goblintown-sidecar";

export interface GoblintownCodexSkillInstallOptions {
  sourceDir?: string;
  skillsDir?: string;
  force?: boolean;
}

export interface GoblintownCodexSkillInstallResult {
  ok: boolean;
  name: string;
  sourceDir?: string;
  targetDir: string;
  changed: boolean;
  backupDir?: string;
  restartRequired: boolean;
  error?: string;
}

export async function installGoblintownCodexSkill(
  opts: GoblintownCodexSkillInstallOptions = {},
): Promise<GoblintownCodexSkillInstallResult> {
  const sourceDir = opts.sourceDir ?? await resolveBundledSidecarSkillDir();
  const skillsDir = opts.skillsDir ?? defaultCodexSkillsDir();
  const targetDir = join(skillsDir, GOBLINTOWN_SIDECAR_SKILL_NAME);

  try {
    await stat(join(sourceDir, "SKILL.md"));
    if (!opts.force && await directoriesMatch(sourceDir, targetDir)) {
      return {
        ok: true,
        name: GOBLINTOWN_SIDECAR_SKILL_NAME,
        sourceDir,
        targetDir,
        changed: false,
        restartRequired: false,
      };
    }

    await mkdir(skillsDir, { recursive: true });
    let backupDir: string | undefined;
    if (await pathExists(targetDir)) {
      backupDir = `${targetDir}.bak-${timestampForPath()}`;
      await cp(targetDir, backupDir, { recursive: true });
      await rm(targetDir, { recursive: true, force: true });
    }
    await cp(sourceDir, targetDir, { recursive: true });

    return {
      ok: true,
      name: GOBLINTOWN_SIDECAR_SKILL_NAME,
      sourceDir,
      targetDir,
      changed: true,
      backupDir,
      restartRequired: true,
    };
  } catch (err) {
    return {
      ok: false,
      name: GOBLINTOWN_SIDECAR_SKILL_NAME,
      sourceDir,
      targetDir,
      changed: false,
      restartRequired: false,
      error: errorMessage(err),
    };
  }
}

export function defaultCodexSkillsDir(): string {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "skills");
}

async function resolveBundledSidecarSkillDir(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "..", "skills", GOBLINTOWN_SIDECAR_SKILL_NAME),
    join(process.cwd(), "skills", GOBLINTOWN_SIDECAR_SKILL_NAME),
  ];
  for (const candidate of candidates) {
    if (await pathExists(join(candidate, "SKILL.md"))) return candidate;
  }
  throw new Error(`Could not find bundled ${GOBLINTOWN_SIDECAR_SKILL_NAME} skill`);
}

async function directoriesMatch(left: string, right: string): Promise<boolean> {
  if (!await pathExists(left) || !await pathExists(right)) return false;
  const leftEntries = await readdir(left, { withFileTypes: true });
  const rightEntries = await readdir(right, { withFileTypes: true });
  const leftNames = leftEntries.map((entry) => entry.name).sort();
  const rightNames = rightEntries.map((entry) => entry.name).sort();
  if (leftNames.join("\0") !== rightNames.join("\0")) return false;

  const rightByName = new Map(rightEntries.map((entry) => [entry.name, entry]));
  for (const leftEntry of leftEntries) {
    const rightEntry = rightByName.get(leftEntry.name);
    if (!rightEntry) return false;
    const leftPath = join(left, leftEntry.name);
    const rightPath = join(right, rightEntry.name);
    if (leftEntry.isDirectory() || rightEntry.isDirectory()) {
      if (!leftEntry.isDirectory() || !rightEntry.isDirectory()) return false;
      if (!await directoriesMatch(leftPath, rightPath)) return false;
      continue;
    }
    if (!leftEntry.isFile() || !rightEntry.isFile()) return false;
    const [leftBuffer, rightBuffer] = await Promise.all([
      readFile(leftPath),
      readFile(rightPath),
    ]);
    if (!leftBuffer.equals(rightBuffer)) return false;
  }
  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
