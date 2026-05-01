import { access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { shinies } from "./reward.js";
import type { Loot, TrollVerdict } from "./types.js";

export type RewardFn = (loot: Loot, verdict: TrollVerdict) => number;

export interface RewardPlugin {
  fn: RewardFn;
  source: string;
}

export async function loadRewardPlugin(warrenRoot: string): Promise<RewardPlugin> {
  for (const filename of ["reward.mjs", "reward.js"]) {
    const candidate = join(warrenRoot, ".goblintown", filename);
    try {
      await access(candidate, FS.F_OK);
    } catch {
      continue;
    }

    const url = pathToFileURL(candidate).href;
    const mod = (await import(url)) as { default?: unknown };
    const exported = mod.default;
    if (typeof exported !== "function") {
      throw new Error(
        `Reward plugin at ${candidate} must export a default function ` +
          `(loot, verdict) => number; got ${typeof exported}.`,
      );
    }

    const wrapped: RewardFn = (loot, verdict) => {
      const raw = (exported as RewardFn)(loot, verdict);
      if (typeof raw !== "number" || Number.isNaN(raw)) return 0;
      return Math.max(0, Math.min(1, raw));
    };
    return { fn: wrapped, source: candidate };
  }

  return { fn: shinies, source: "builtin" };
}
