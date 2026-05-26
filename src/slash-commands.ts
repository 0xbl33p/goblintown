export type GoblinMode = "single" | "town";

export type GoblinCommandKind =
  | "run"
  | "ask"
  | "town"
  | "tank"
  | "plan"
  | "history"
  | "resume"
  | "provider"
  | "reset"
  | "context"
  | "help";

export interface GoblinCommandDefaults {
  mode?: GoblinMode;
  tank?: boolean;
}

export interface ParsedGoblinCommand {
  kind: GoblinCommandKind;
  mode: GoblinMode;
  tank: boolean;
  task: string;
  args: string[];
}

export interface GoblinRunRequest {
  endpoint: "/api/goblin/single" | "/api/plan";
  payload: Record<string, unknown>;
  mode: GoblinMode;
  tank: boolean;
}

const DEFAULT_MAX_NODES = 6;
const DEFAULT_MAX_REPLAN = 2;

export function parseGoblinCommand(
  line: string,
  defaults: GoblinCommandDefaults = {},
): ParsedGoblinCommand {
  const trimmed = line.trim();
  const fallbackMode = defaults.mode ?? "single";
  const fallbackTank = defaults.tank ?? false;
  if (!trimmed.startsWith("/")) {
    return {
      kind: "run",
      mode: fallbackMode,
      tank: fallbackMode === "town" && fallbackTank,
      task: trimmed,
      args: trimmed ? [trimmed] : [],
    };
  }

  const tokens = parseCommandLine(trimmed);
  const commandToken = tokens.shift() ?? "/run";
  const command = normalizeCommandKind(commandToken.slice(1));
  const explicitTank = tokens.includes("--tank");
  const args = tokens.filter((token) => token !== "--tank");
  const task = args.join(" ").trim();
  const mode = modeForCommand(command, fallbackMode);
  const tank = mode === "town" && (command === "tank" || explicitTank || fallbackTank);

  return {
    kind: command,
    mode,
    tank,
    task,
    args,
  };
}

export function commandToRunRequest(command: ParsedGoblinCommand): GoblinRunRequest {
  if (command.mode === "town") {
    return {
      endpoint: "/api/plan",
      payload: {
        task: command.task,
        maxNodes: DEFAULT_MAX_NODES,
        maxReplan: DEFAULT_MAX_REPLAN,
        remember: true,
        outputFormat: "markdown",
      },
      mode: "town",
      tank: command.tank,
    };
  }
  return {
    endpoint: "/api/goblin/single",
    payload: {
      task: command.task,
      remember: true,
      outputFormat: "markdown",
    },
    mode: "single",
    tank: false,
  };
}

export function commandToCliArgs(command: ParsedGoblinCommand): string[] {
  if (command.mode === "town") {
    return ["plan", command.task, "--remember", "--format", "markdown"];
  }
  return ["summon", "goblin", "--task", command.task, "--format", "markdown"];
}

export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const ch of line) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function normalizeCommandKind(value: string): GoblinCommandKind {
  switch (value.toLowerCase()) {
    case "ask":
    case "single":
    case "goblin":
      return "ask";
    case "town":
    case "goblintown":
      return "town";
    case "tank":
      return "tank";
    case "plan":
      return "plan";
    case "history":
    case "runs":
      return "history";
    case "resume":
      return "resume";
    case "provider":
    case "providers":
      return "provider";
    case "reset":
      return "reset";
    case "context":
      return "context";
    case "help":
    case "?":
      return "help";
    case "run":
    default:
      return "run";
  }
}

function modeForCommand(command: GoblinCommandKind, fallback: GoblinMode): GoblinMode {
  switch (command) {
    case "ask":
      return "single";
    case "town":
    case "tank":
    case "plan":
      return "town";
    default:
      return fallback;
  }
}
