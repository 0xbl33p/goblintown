import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GOBLINTOWN_CODEX_PLUGIN_NAME = "goblintown";
export const GOBLINTOWN_CODEX_PLUGIN_CATEGORY = "Developer Tools";

export interface GoblintownCodexPluginInstallOptions {
  sourceDir?: string;
  targetDir?: string;
  marketplacePath?: string;
  force?: boolean;
  mcpPackageSpec?: string;
  localMcpCliPath?: string;
  installInCodex?: boolean;
  codexCliPath?: string;
}

export interface GoblintownCodexPluginMarketplaceResult {
  path: string;
  changed: boolean;
  entryName: string;
  marketplaceName: string;
}

export interface GoblintownCodexPluginAddResult {
  attempted: boolean;
  ok: boolean;
  changed: boolean;
  selector: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface GoblintownCodexPluginInstallResult {
  ok: boolean;
  name: string;
  sourceDir?: string;
  targetDir: string;
  changed: boolean;
  pluginChanged: boolean;
  marketplace: GoblintownCodexPluginMarketplaceResult;
  codex: GoblintownCodexPluginAddResult;
  backupDir?: string;
  restartRequired: boolean;
  viewUrl: string;
  shareUrl: string;
  error?: string;
}

interface MarketplacePluginEntry {
  name: string;
  source: {
    source: "local";
    path: string;
  };
  policy: {
    installation: "AVAILABLE";
    authentication: "ON_INSTALL";
  };
  category: string;
}

interface MarketplaceRoot {
  name?: string;
  interface?: {
    displayName?: string;
    [key: string]: unknown;
  };
  plugins?: MarketplacePluginEntry[];
  [key: string]: unknown;
}

interface McpConfig {
  mcpServers: {
    goblintown: {
      command: string;
      args: string[];
    };
  };
}

export async function installGoblintownCodexPlugin(
  opts: GoblintownCodexPluginInstallOptions = {},
): Promise<GoblintownCodexPluginInstallResult> {
  let sourceDir = opts.sourceDir;
  const targetDir = opts.targetDir ?? defaultCodexPluginDir();
  const marketplacePath = opts.marketplacePath ?? defaultCodexPluginMarketplacePath();
  const viewUrl = codexPluginUrl(marketplacePath);
  const shareUrl = codexPluginUrl(marketplacePath, "share");

  try {
    sourceDir ??= await resolveBundledPluginDir();
    await stat(join(sourceDir, ".codex-plugin", "plugin.json"));
    await stat(join(sourceDir, ".mcp.json"));

    const mcpOverrideText = mcpConfigOverrideText(opts);
    const pluginMatches = !opts.force && await directoriesMatch(
      sourceDir,
      targetDir,
      mcpOverrideText ? new Map([[".mcp.json", mcpOverrideText]]) : undefined,
    );

    let pluginChanged = false;
    let backupDir: string | undefined;
    if (!pluginMatches) {
      await mkdir(dirname(targetDir), { recursive: true });
      if (await pathExists(targetDir)) {
        backupDir = `${targetDir}.bak-${timestampForPath()}`;
        await cp(targetDir, backupDir, { recursive: true });
        await rm(targetDir, { recursive: true, force: true });
      }
      await cp(sourceDir, targetDir, { recursive: true });
      if (mcpOverrideText) {
        await writeFile(join(targetDir, ".mcp.json"), mcpOverrideText, "utf8");
      }
      pluginChanged = true;
    }

    const marketplace = await ensurePersonalMarketplaceEntry(marketplacePath);
    const selector = `${GOBLINTOWN_CODEX_PLUGIN_NAME}@${marketplace.marketplaceName}`;
    const codex = opts.installInCodex === false
      ? skippedCodexInstall(selector)
      : await installPluginIntoCodex(selector, opts.codexCliPath);
    const changed = pluginChanged || marketplace.changed || codex.changed;
    return {
      ok: codex.ok,
      name: GOBLINTOWN_CODEX_PLUGIN_NAME,
      sourceDir,
      targetDir,
      changed,
      pluginChanged,
      marketplace,
      codex,
      backupDir,
      restartRequired: changed,
      viewUrl,
      shareUrl,
      error: codex.ok ? undefined : codex.error,
    };
  } catch (err) {
    const selector = `${GOBLINTOWN_CODEX_PLUGIN_NAME}@personal`;
    return {
      ok: false,
      name: GOBLINTOWN_CODEX_PLUGIN_NAME,
      sourceDir,
      targetDir,
      changed: false,
      pluginChanged: false,
      marketplace: {
        path: marketplacePath,
        changed: false,
        entryName: GOBLINTOWN_CODEX_PLUGIN_NAME,
        marketplaceName: "personal",
      },
      codex: skippedCodexInstall(selector),
      restartRequired: false,
      viewUrl,
      shareUrl,
      error: errorMessage(err),
    };
  }
}

export function defaultCodexPluginDir(): string {
  return join(homedir(), "plugins", GOBLINTOWN_CODEX_PLUGIN_NAME);
}

export function defaultCodexPluginMarketplacePath(): string {
  return join(homedir(), ".agents", "plugins", "marketplace.json");
}

export function codexPluginUrl(
  marketplacePath: string,
  mode?: "share",
): string {
  const base =
    `codex://plugins/${encodeURIComponent(GOBLINTOWN_CODEX_PLUGIN_NAME)}` +
    `?marketplacePath=${encodeURIComponent(marketplacePath)}`;
  return mode === "share" ? `${base}&mode=share` : base;
}

async function resolveBundledPluginDir(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "..", "plugins", GOBLINTOWN_CODEX_PLUGIN_NAME),
    join(process.cwd(), "plugins", GOBLINTOWN_CODEX_PLUGIN_NAME),
  ];
  for (const candidate of candidates) {
    if (await pathExists(join(candidate, ".codex-plugin", "plugin.json"))) return candidate;
  }
  throw new Error(`Could not find bundled ${GOBLINTOWN_CODEX_PLUGIN_NAME} Codex plugin`);
}

async function ensurePersonalMarketplaceEntry(
  marketplacePath: string,
): Promise<GoblintownCodexPluginMarketplaceResult> {
  const entry = personalMarketplaceEntry();
  let marketplace: MarketplaceRoot;
  let changed = false;

  if (await pathExists(marketplacePath)) {
    marketplace = JSON.parse(await readFile(marketplacePath, "utf8")) as MarketplaceRoot;
  } else {
    marketplace = {
      name: "personal",
      interface: { displayName: "Personal" },
      plugins: [],
    };
    changed = true;
  }

  if (!marketplace.name) {
    marketplace.name = "personal";
    changed = true;
  }
  if (!marketplace.interface || typeof marketplace.interface !== "object") {
    marketplace.interface = { displayName: "Personal" };
    changed = true;
  } else if (!marketplace.interface.displayName) {
    marketplace.interface.displayName = "Personal";
    changed = true;
  }
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error(`Marketplace at ${marketplacePath} must contain a plugins array`);
  }

  const existingIndex = marketplace.plugins.findIndex(
    (plugin) => plugin.name === GOBLINTOWN_CODEX_PLUGIN_NAME,
  );
  if (existingIndex === -1) {
    marketplace.plugins.push(entry);
    changed = true;
  } else if (JSON.stringify(marketplace.plugins[existingIndex]) !== JSON.stringify(entry)) {
    marketplace.plugins[existingIndex] = entry;
    changed = true;
  }

  if (changed) {
    await mkdir(dirname(marketplacePath), { recursive: true });
    await writeFile(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n", "utf8");
  }

  return {
    path: marketplacePath,
    changed,
    entryName: GOBLINTOWN_CODEX_PLUGIN_NAME,
    marketplaceName: marketplace.name ?? "personal",
  };
}

function personalMarketplaceEntry(): MarketplacePluginEntry {
  return {
    name: GOBLINTOWN_CODEX_PLUGIN_NAME,
    source: {
      source: "local",
      path: `./plugins/${GOBLINTOWN_CODEX_PLUGIN_NAME}`,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: GOBLINTOWN_CODEX_PLUGIN_CATEGORY,
  };
}

function mcpConfigOverrideText(opts: GoblintownCodexPluginInstallOptions): string | undefined {
  if (opts.localMcpCliPath) {
    return JSON.stringify(localMcpConfig(opts.localMcpCliPath), null, 2) + "\n";
  }
  if (opts.mcpPackageSpec) {
    return JSON.stringify(packageMcpConfig(opts.mcpPackageSpec), null, 2) + "\n";
  }
  return undefined;
}

function localMcpConfig(cliPath: string): McpConfig {
  return {
    mcpServers: {
      goblintown: {
        command: "node",
        args: [cliPath, "mcp"],
      },
    },
  };
}

function packageMcpConfig(packageSpec: string): McpConfig {
  return {
    mcpServers: {
      goblintown: {
        command: "npx",
        args: ["-y", packageSpec, "mcp"],
      },
    },
  };
}

function skippedCodexInstall(selector: string): GoblintownCodexPluginAddResult {
  return {
    attempted: false,
    ok: true,
    changed: false,
    selector,
  };
}

async function installPluginIntoCodex(
  selector: string,
  codexCliPath?: string,
): Promise<GoblintownCodexPluginAddResult> {
  let lastError: string | undefined;
  for (const command of codexCliCandidates(codexCliPath)) {
    const run = await runCodexPluginAdd(command, selector);
    if (run.spawnError) {
      const message = errorMessage(run.spawnError);
      lastError = message;
      if (!codexCliPath && run.spawnError.code === "ENOENT") continue;
      return {
        attempted: true,
        ok: false,
        changed: false,
        selector,
        command,
        stdout: run.stdout,
        stderr: run.stderr,
        error: message,
      };
    }
    if (run.code === 0) {
      return {
        attempted: true,
        ok: true,
        changed: true,
        selector,
        command,
        stdout: run.stdout,
        stderr: run.stderr,
      };
    }
    return {
      attempted: true,
      ok: false,
      changed: false,
      selector,
      command,
      stdout: run.stdout,
      stderr: run.stderr,
      error: run.stderr.trim() || run.stdout.trim() || `codex plugin add exited with ${run.code}`,
    };
  }

  return {
    attempted: true,
    ok: false,
    changed: false,
    selector,
    error: lastError ?? "Could not find the Codex CLI. Install the plugin manually with codex plugin add.",
  };
}

function codexCliCandidates(codexCliPath?: string): string[] {
  const candidates = codexCliPath
    ? [codexCliPath]
    : [
        process.env.CODEX_CLI_PATH,
        "codex",
        process.platform === "darwin"
          ? "/Applications/Codex.app/Contents/Resources/codex"
          : undefined,
      ];
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

function runCodexPluginAdd(
  command: string,
  selector: string,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, ["plugin", "add", selector], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      resolve({
        code: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        spawnError: err,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function directoriesMatch(
  left: string,
  right: string,
  fileOverrides?: Map<string, string>,
  relativeDir = "",
): Promise<boolean> {
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
    const relativePath = relativeDir ? `${relativeDir}/${leftEntry.name}` : leftEntry.name;
    if (leftEntry.isDirectory() || rightEntry.isDirectory()) {
      if (!leftEntry.isDirectory() || !rightEntry.isDirectory()) return false;
      if (!await directoriesMatch(leftPath, rightPath, fileOverrides, relativePath)) {
        return false;
      }
      continue;
    }
    if (!leftEntry.isFile() || !rightEntry.isFile()) return false;
    const override = fileOverrides?.get(relativePath);
    const [leftBuffer, rightBuffer] = await Promise.all([
      override === undefined ? readFile(leftPath) : Promise.resolve(Buffer.from(override)),
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
