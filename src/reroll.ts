import { performRite, type RiteOptions, type RiteResult } from "./rite.js";
import type { Hoard } from "./hoard.js";

export interface RerollOptions {
  riteId: string;
  cwd: string;
  hoard: Hoard;
  noFallback?: boolean;
  budgetTokens?: number;
  maxOutputTokensPerCall?: number;
  onStep?: RiteOptions["onStep"];
  rewardFn?: RiteOptions["rewardFn"];
}

export async function reroll(opts: RerollOptions): Promise<RiteResult> {
  const original = await opts.hoard.getRite(opts.riteId);
  if (!original) {
    throw new Error(`Rite ${opts.riteId} not found in the Hoard.`);
  }
  return performRite({
    task: original.task,
    packSize: original.packSize,
    scanGlobs: original.scanGlobs,
    cwd: opts.cwd,
    hoard: opts.hoard,
    personality: original.personality,
    rewardFn: opts.rewardFn,
    noFallback: opts.noFallback,
    budgetTokens: opts.budgetTokens,
    maxOutputTokensPerCall: opts.maxOutputTokensPerCall,
    onStep: opts.onStep,
  });
}
