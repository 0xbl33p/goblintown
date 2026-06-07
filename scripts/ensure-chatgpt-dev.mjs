#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const runtimeDir = join(repoRoot, ".goblintown", "runtime");
const tankPort = Number(process.env.GOBLINTOWN_MCP_TANK_PORT ?? 7777);
const adapterPort = Number(process.env.GOBLINTOWN_CHATGPT_PORT ?? 8787);
const expectedWarrenRoot = resolve(process.env.GOBLINTOWN_VERIFY_WARREN_ROOT ?? repoRoot);
const forceRestart = process.argv.includes("--restart");

await mkdir(runtimeDir, { recursive: true });

if (forceRestart) {
  await stopChatGptProcesses();
  await stopScreen(`goblintown-tank-${tankPort}`);
  await killPort(tankPort);
}

await ensureTank();
const mcpUrl = await ensureVerifiedAdapter();

console.log(JSON.stringify({
  ok: true,
  mcpUrl,
  tankUrl: `http://localhost:${tankPort}/`,
  warrenRoot: expectedWarrenRoot,
  logs: {
    tank: join(runtimeDir, "tank.log"),
    chatgpt: join(runtimeDir, "chatgpt.log"),
  },
}, null, 2));

async function ensureTank() {
  const identity = await currentTankIdentity().catch(() => undefined);
  if (identity) {
    if (resolve(String(identity.root)) !== expectedWarrenRoot) {
      throw new Error(
        `Port ${tankPort} belongs to Warren ${identity.root}, not ${expectedWarrenRoot}. ` +
          "Stop that Tank before starting the ChatGPT dev app.",
      );
    }
    return;
  }

  await stopScreen(`goblintown-tank-${tankPort}`);
  await startScreen(
    `goblintown-tank-${tankPort}`,
    `cd ${shellQuote(repoRoot)} && node dist/cli.js serve --port ${tankPort} > ${shellQuote(join(runtimeDir, "tank.log"))} 2>&1`,
  );
  await waitFor(async () => {
    const next = await currentTankIdentity();
    if (resolve(String(next.root)) !== expectedWarrenRoot) {
      throw new Error(`Started Tank with unexpected Warren root ${next.root}`);
    }
    return next;
  }, 30_000, "Tank identity");
}

async function ensureVerifiedAdapter() {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const mcpUrl = await ensureAdapter({ restart: attempt > 0 });
      await waitFor(
        () => runVerifier(mcpUrl, { quiet: true }),
        60_000,
        `public MCP verifier for ${mcpUrl}`,
      );
      return mcpUrl;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function ensureAdapter(opts = {}) {
  if (!opts.restart) {
    const current = await localAdapterHealth().catch(() => undefined);
    if (isPublicMcpUrl(current?.mcpUrl)) return String(current.mcpUrl);
  }

  await stopChatGptProcesses();
  await startScreen(
    "goblintown-chatgpt",
    `cd ${shellQuote(repoRoot)} && node dist/cli.js chatgpt install --no-open > ${shellQuote(join(runtimeDir, "chatgpt.log"))} 2>&1`,
  );

  const health = await waitForAdapterHealth(120_000);
  if (!health.mcpUrl) {
    throw new Error("ChatGPT adapter health did not include mcpUrl");
  }
  return String(health.mcpUrl);
}

async function currentTankIdentity() {
  const response = await fetch(`http://127.0.0.1:${tankPort}/api/identity`);
  if (!response.ok) throw new Error(`Tank identity returned ${response.status}`);
  return response.json();
}

async function localAdapterHealth() {
  const response = await fetch(`http://127.0.0.1:${adapterPort}/healthz`);
  if (!response.ok) throw new Error(`Adapter health returned ${response.status}`);
  return response.json();
}

async function waitForAdapterHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await localAdapterHealth();
      if (!isPublicMcpUrl(health.mcpUrl)) {
        throw new Error(`Adapter has not published an HTTPS tunnel URL yet (${health.mcpUrl ?? "none"})`);
      }
      return health;
    } catch (err) {
      lastError = err;
      if (!(await adapterProcessIsAlive())) {
        const log = await readFile(join(runtimeDir, "chatgpt.log"), "utf8").catch(() => "");
        throw new Error(
          `ChatGPT adapter exited before health was ready. Last error: ${lastError?.message ?? lastError}` +
            (log.trim() ? `\n\n${log.trim()}` : ""),
        );
      }
      await delay(500);
    }
  }
  throw new Error(`ChatGPT adapter health did not become ready within ${timeoutMs}ms: ${lastError?.message ?? lastError}`);
}

function isPublicMcpUrl(value) {
  return typeof value === "string" && value.startsWith("https://") && value.endsWith("/mcp");
}

async function adapterProcessIsAlive() {
  const { stdout } = await execFileP("ps", ["-axo", "command"], { cwd: repoRoot }).catch(() => ({ stdout: "" }));
  return stdout.includes("node dist/cli.js chatgpt install --no-open");
}

async function runVerifier(mcpUrl, opts = {}) {
  const { stdout, stderr } = await execFileP(process.execPath, [
    join(repoRoot, "scripts", "verify-chatgpt-app.mjs"),
    "--mcp-url",
    mcpUrl,
    "--connect-url",
    `http://127.0.0.1:${adapterPort}/mcp`,
    "--warren-root",
    expectedWarrenRoot,
  ], { cwd: repoRoot, timeout: 20_000 });
  if (!opts.quiet && stdout.trim()) process.stdout.write(stdout);
  if (!opts.quiet && stderr.trim()) process.stderr.write(stderr);
}

async function startScreen(name, command) {
  await execFileP("screen", ["-dmS", name, "/bin/zsh", "-lc", command], { cwd: repoRoot });
}

async function stopScreen(name) {
  await execFileP("screen", ["-S", name, "-X", "quit"], { cwd: repoRoot }).catch(() => undefined);
}

async function stopChatGptProcesses() {
  await stopScreen("goblintown-chatgpt");
  await stopScreen("goblintown-cloudflared");
  await killCommand("cloudflared tunnel --url http://localhost:8787");
  await killPort(adapterPort);
}

async function killPort(port) {
  const { stdout } = await execFileP("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { cwd: repoRoot }).catch(() => ({ stdout: "" }));
  for (const pid of stdout.split(/\s+/u).filter(Boolean)) {
    await execFileP("kill", [pid], { cwd: repoRoot }).catch(() => undefined);
  }
  await waitFor(async () => {
    if (await portIsListening(port)) throw new Error(`Port ${port} is still listening`);
    return true;
  }, 10_000, `port ${port} to become free`);
}

async function killCommand(pattern) {
  const { stdout } = await execFileP("ps", ["-axo", "pid=,command="], { cwd: repoRoot }).catch(() => ({ stdout: "" }));
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.includes(pattern)) continue;
    const pid = line.trim().split(/\s+/u)[0];
    if (pid) await execFileP("kill", [pid], { cwd: repoRoot }).catch(() => undefined);
  }
}

async function portIsListening(port) {
  const { stdout } = await execFileP("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { cwd: repoRoot }).catch(() => ({ stdout: "" }));
  return stdout.trim().length > 0;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await delay(500);
    }
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms: ${lastError?.message ?? lastError}`);
}

function execFileP(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...opts, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}
