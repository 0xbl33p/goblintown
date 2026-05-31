import { installGoblintownCodexMcpConfig, mcpDoctorPayload } from "./mcp.js";
import { installGoblintownCodexSkill } from "./skill-install.js";
import { initWarren, loadWarren } from "./warren.js";
import { serve } from "./server.js";

export interface GoblintownInstallResult {
  ok: boolean;
  cwd: string;
  warrenRoot: string;
  warrenName: string;
  initialized: boolean;
  mcp: { ok: boolean; changed: boolean; restartRequired: boolean };
  skill: { ok: boolean; changed: boolean; restartRequired: boolean };
  serve?: { url: string };
  errors: string[];
}

export async function goblintownInstall(
  cwd: string,
  opts: { port?: number; serve?: boolean } = {},
): Promise<GoblintownInstallResult> {
  const errors: string[] = [];
  let initialized = false;

  // 1. Load or create a Warren
  let warrenRoot = cwd;
  let warrenName: string;
  try {
    const warren = await loadWarren(cwd);
    warrenRoot = warren.root;
    warrenName = warren.manifest.name;
  } catch {
    const warren = await initWarren(cwd);
    warrenRoot = warren.root;
    warrenName = warren.manifest.name;
    initialized = true;
  }

  // 2. Install MCP config for Codex
  let mcp: GoblintownInstallResult["mcp"];
  try {
    const installed = await installGoblintownCodexMcpConfig();
    mcp = {
      ok: installed.ok === true,
      changed: installed.changed === true,
      restartRequired: installed.restartRequired === true,
    };
    if (!mcp.ok && installed.error) {
      errors.push(`mcp: ${installed.error}`);
    }
  } catch (err) {
    mcp = { ok: false, changed: false, restartRequired: false };
    errors.push(`mcp: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Install the Codex skill
  let skill: GoblintownInstallResult["skill"];
  try {
    const installed = await installGoblintownCodexSkill();
    skill = {
      ok: installed.ok === true,
      changed: installed.changed === true,
      restartRequired: installed.restartRequired === true,
    };
    if (!skill.ok && installed.error) {
      errors.push(`skill: ${installed.error}`);
    }
  } catch (err) {
    skill = { ok: false, changed: false, restartRequired: false };
    errors.push(`skill: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Optionally start the server
  let serveResult: { url: string } | undefined;
  if (opts.serve !== false) {
    try {
      const handle = await serve({ cwd: warrenRoot, port: opts.port ?? 7777, autopilot: true });
      serveResult = { url: handle.url };
    } catch (err) {
      errors.push(`serve: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ok: errors.length === 0,
    cwd,
    warrenRoot,
    warrenName,
    initialized,
    mcp,
    skill,
    serve: serveResult,
    errors,
  };
}

export function formatInstallOutput(result: GoblintownInstallResult): string {
  const lines: string[] = [];

  if (result.ok) {
    lines.push("Goblintown Agent Setup");
    lines.push("──────────────────────");
  } else {
    lines.push("Goblintown Agent Setup (with warnings)");
    lines.push("─────────────────────────────────────");
  }

  if (result.initialized) {
    lines.push(`✓ Warren created: ${result.warrenName} (${result.warrenRoot})`);
  } else {
    lines.push(`✓ Warren found: ${result.warrenName} (${result.warrenRoot})`);
  }

  if (result.mcp.ok) {
    lines.push(`✓ MCP config ${result.mcp.changed ? "installed" : "already present"} in Codex`);
  } else {
    lines.push(`✗ MCP config failed — run manually: npx goblintown@latest mcp --install-codex`);
  }

  if (result.skill.ok) {
    lines.push(`✓ Skill ${result.skill.changed ? "installed" : "already present"} in Codex`);
  } else {
    lines.push(`✗ Skill install failed — run manually: npx goblintown@latest skill install`);
  }

  if (result.serve) {
    lines.push(`✓ Tank running at ${result.serve.url}`);
    lines.push("");
    lines.push("The Tank is in autopilot mode — no chat surface.");
    lines.push("Your agent drives it via MCP tools:");
    lines.push("  goblintown_rite   — full multi-agent rite");
    lines.push("  goblintown_plan   — planner DAG execution");
    lines.push("  goblintown_chat   — single goblin call");
    lines.push("  goblintown_doctor — setup diagnostics");
  }

  if (result.mcp.restartRequired || result.skill.restartRequired) {
    lines.push("");
    lines.push("Restart Codex to pick up the new skill and MCP config.");
  }

  if (result.errors.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const err of result.errors) {
      lines.push(`  ! ${err}`);
    }
  }

  return lines.join("\n") + "\n";
}
