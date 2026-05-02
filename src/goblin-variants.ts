/**
 * Goblin variants are lightweight sub-archetypes that tune the system prompt
 * and sampling temperature without introducing new creature kinds. Adding a
 * variant does NOT change CREATURE_KINDS, so the ban-list invariant holds.
 *
 * In a pack of N goblins, the dispatcher cycles through variants to maximize
 * differentiation between candidate outputs — packs of mixed variants tend to
 * cover more of the answer space than packs of identical workers.
 */
export type GoblinVariant = "worker" | "tinker" | "brawler" | "scout";

export const GOBLIN_VARIANTS: GoblinVariant[] = [
  "worker",
  "tinker",
  "brawler",
  "scout",
];

export interface GoblinVariantSpec {
  /** Extra sentence appended to the base Goblin system prompt. */
  promptSuffix: string;
  /** Multiplier applied to the base goblin temperature (0.9). */
  temperatureScale: number;
}

export const GOBLIN_VARIANT_SPECS: Record<GoblinVariant, GoblinVariantSpec> = {
  worker: {
    promptSuffix: "",
    temperatureScale: 1.0,
  },
  tinker: {
    promptSuffix:
      " You are a tinker variant: when the task involves code, configuration, or tools, prefer concrete fragments — actual commands, schemas, function signatures — over prose explanation.",
    temperatureScale: 0.78,
  },
  brawler: {
    promptSuffix:
      " You are a brawler variant: lead with the answer in the first sentence, then justify in <=3 short follow-on sentences. No qualifications, no caveats, no 'it depends'.",
    temperatureScale: 0.95,
  },
  scout: {
    promptSuffix:
      " You are a scout variant: enumerate the answer space first (3-6 plausible candidates as a numbered list), then mark the one you would commit to and why in one sentence. Prefer coverage over depth.",
    temperatureScale: 1.05,
  },
};

/**
 * Choose a variant for goblin index `i` of a pack of size `n`. Cycles through
 * GOBLIN_VARIANTS so a pack of 4 gets one of each, a pack of 2 gets the first
 * two, and a pack of 1 gets just `worker`. Single-element packs always get
 * `worker` so the default behaviour is unchanged.
 */
export function variantForPackIndex(i: number, n: number): GoblinVariant {
  if (n <= 1) return "worker";
  return GOBLIN_VARIANTS[i % GOBLIN_VARIANTS.length];
}
