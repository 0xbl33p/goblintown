import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as path from "node:path";

/**
 * Goblintown VS Code extension.
 *
 * Thin shell over the goblintown CLI: registers four commands, pipes their
 * stdout/stderr to a single output channel, and exposes a status-bar item.
 *
 * The extension does NOT bundle the CLI — it expects `goblintown` on PATH
 * (overridable via `goblintown.cliPath`). This keeps the extension small and
 * lets users pin a specific Warren / version per workspace.
 */

let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Goblintown");
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.text = "$(rocket) Goblintown";
  statusItem.command = "goblintown.openHoard";
  statusItem.tooltip = "Open the Goblintown Hoard web UI";
  statusItem.show();

  context.subscriptions.push(
    output,
    statusItem,
    vscode.commands.registerCommand("goblintown.summon", summonOnSelection),
    vscode.commands.registerCommand("goblintown.quest", questOnSelection),
    vscode.commands.registerCommand("goblintown.rite", riteOnActiveFile),
    vscode.commands.registerCommand("goblintown.openHoard", openHoard),
  );
}

export function deactivate(): void {}

// --- commands ---

async function summonOnSelection(): Promise<void> {
  const selection = getSelectionText();
  if (!selection) {
    vscode.window.showWarningMessage("Goblintown: select some text first.");
    return;
  }
  const kind = await vscode.window.showQuickPick(
    ["goblin", "gremlin", "raccoon", "troll", "ogre", "pigeon"],
    { placeHolder: "Which creature?" },
  );
  if (!kind) return;
  const task = await askTask(`Task for ${kind} (selection will be appended)`);
  if (!task) return;
  await runCli(["summon", kind, "--task", `${task}\n\n---\n${selection}`]);
}

async function questOnSelection(): Promise<void> {
  const selection = getSelectionText();
  if (!selection) {
    vscode.window.showWarningMessage("Goblintown: select some text first.");
    return;
  }
  const task = await askTask("Quest task (selection will be appended as context)");
  if (!task) return;
  const cfg = vscode.workspace.getConfiguration("goblintown");
  await runCli([
    "quest",
    `${task}\n\n---\n${selection}`,
    "--pack",
    String(cfg.get("packSize", 3)),
    "--personality",
    String(cfg.get("personality", "nerdy")),
  ]);
}

async function riteOnActiveFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Goblintown: open a file first.");
    return;
  }
  const filePath = editor.document.uri.fsPath;
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage("Goblintown: no workspace folder open.");
    return;
  }
  const rel = path.relative(root, filePath);
  const task = await askTask(`Rite task (will scan ${rel})`);
  if (!task) return;
  const cfg = vscode.workspace.getConfiguration("goblintown");
  await runCli([
    "rite",
    task,
    "--pack",
    String(cfg.get("packSize", 3)),
    "--personality",
    String(cfg.get("personality", "nerdy")),
    "--scan",
    rel,
  ]);
}

async function openHoard(): Promise<void> {
  const port = vscode.workspace.getConfiguration("goblintown").get<number>("serverPort", 7777);
  const url = `http://localhost:${port}/`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

// --- helpers ---

function getSelectionText(): string | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const text = editor.document.getText(editor.selection);
  return text.trim().length > 0 ? text : null;
}

async function askTask(prompt: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    placeHolder: "Refactor this to share the troll-review helper",
    ignoreFocusOut: true,
  });
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function runCli(args: string[]): Promise<void> {
  const cli = vscode.workspace.getConfiguration("goblintown").get<string>("cliPath", "goblintown");
  const cwd = workspaceRoot();
  output.show(true);
  output.appendLine(`\n$ ${cli} ${args.join(" ")}`);
  if (!cwd) {
    output.appendLine("(no workspace open — running in extension cwd)");
  }
  return new Promise((resolve) => {
    const proc = spawn(cli, args, { cwd, env: process.env, shell: false });
    proc.stdout.on("data", (b) => output.append(b.toString()));
    proc.stderr.on("data", (b) => output.append(b.toString()));
    proc.on("error", (err) => {
      output.appendLine(`\n[failed to spawn '${cli}': ${err.message}]`);
      vscode.window.showErrorMessage(
        `Goblintown: failed to spawn CLI. Is '${cli}' on PATH? Set goblintown.cliPath in settings.`,
      );
      resolve();
    });
    proc.on("close", (code) => {
      output.appendLine(`\n[exit ${code}]`);
      resolve();
    });
  });
}
