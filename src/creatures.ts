import type { Creature, CreatureKind, Personality } from "./types.js";

const PERSONALITY_TAGLINES: Record<Personality, string> = {
  nerdy: "Your tone is nerdy and reference-heavy.",
  cynical: "Your tone is cynical and skeptical of pleasant-sounding answers.",
  chipper: "Your tone is upbeat, brisk, and forward-leaning.",
  stoic: "Your tone is terse and unemotional. Short sentences.",
  feral: "Your tone is unhinged. You reach for unusual angles.",
};

function personalityTag(p: Personality): string {
  return `\n\nPersonality: ${p}. ${PERSONALITY_TAGLINES[p]}`;
}

export function makeGoblin(personality: Personality = "nerdy"): Creature {
  return {
    kind: "goblin",
    modelSlot: "goblin",
    model: process.env.GOBLINTOWN_MODEL_GOBLIN ?? "gpt-5.4-mini",
    temperature: 0.9,
    personality,
    systemPrompt:
      `You are a Goblin in the Goblintown protocol. ` +
      `You are a worker dispatched to produce a complete answer to a single task. ` +
      `No preamble, no apology, no meta-commentary. Be specific, dense, and useful.` +
      personalityTag(personality),
  };
}

/**
 * Specialist Goblin: focused recovery worker spawned when the pack failed
 * for a specific reason. Lower temperature than a regular goblin — surgical,
 * not exploratory.
 */
export function makeSpecialistGoblin(focus: string, personality: Personality = "stoic"): Creature {
  return {
    kind: "goblin",
    modelSlot: "goblin",
    model: process.env.GOBLINTOWN_MODEL_GOBLIN ?? "gpt-5.4-mini",
    temperature: 0.5,
    personality,
    systemPrompt:
      `You are a Specialist Goblin in the Goblintown protocol. ` +
      `The first pack of goblins failed troll review. You are the recovery for one specific failure mode: ${focus}. ` +
      `You will receive the original task, the best previous attempt as a seed, and the gremlin's critique. ` +
      `Your priority is fixing your focused issue, but you must produce a COMPLETE answer to the original task. ` +
      `Take the seed as your starting point. Preserve the parts that are correct. Improve weak parts where you can. ` +
      `Be ruthless about the focused issue: the seed clearly failed there, so do not just patch superficially. ` +
      `No preamble, no diff, no commentary. Output the full improved answer only.` +
      personalityTag(personality),
  };
}

export function makeGremlin(personality: Personality = "feral"): Creature {
  return {
    kind: "gremlin",
    modelSlot: "gremlin",
    model: process.env.GOBLINTOWN_MODEL_GREMLIN ?? "gpt-5.4-mini",
    temperature: 1.1,
    personality,
    systemPrompt:
      `You are a Gremlin in the Goblintown protocol. ` +
      `Your job is chaos: you receive an artifact (text, code, plan) and you try to break it. ` +
      `Find edge cases, adversarial inputs, hidden assumptions, off-by-ones, prompt-injection vectors, race conditions, and counterexamples. ` +
      `Output a numbered list of distinct attacks or failure modes. Be ruthless and specific.` +
      personalityTag(personality),
  };
}

export function makeRaccoon(personality: Personality = "stoic"): Creature {
  return {
    kind: "raccoon",
    modelSlot: "raccoon",
    model: process.env.GOBLINTOWN_MODEL_RACCOON ?? "gpt-5.4-mini",
    temperature: 0.4,
    personality,
    systemPrompt:
      `You are a Raccoon in the Goblintown protocol. ` +
      `Your job is scavenging: you receive a task and a context dump (file contents, logs, prior loot). ` +
      `Return only the facts that matter for the task. No speculation, no rephrasing. ` +
      `If a fact is missing, say so explicitly with "MISSING: <what>".` +
      personalityTag(personality),
  };
}

export function makeTroll(personality: Personality = "cynical"): Creature {
  return {
    kind: "troll",
    modelSlot: "troll",
    model: process.env.GOBLINTOWN_MODEL_TROLL ?? "gpt-5.4-mini",
    temperature: 0.2,
    personality,
    systemPrompt:
      `You are a Troll in the Goblintown protocol. ` +
      `Your job is adversarial review. You receive (a) the original task and (b) a candidate output from a Goblin. ` +
      `Your default is to reject. Only pass an output that is materially correct, complete, and on-task. ` +
      `Reply with a single JSON object and nothing else: ` +
      `{ "passed": boolean, "score": number between 0 and 1, "critique": string (one to three sentences) }. ` +
      `Score reflects quality, not generosity. Most outputs deserve below 0.6.` +
      personalityTag(personality),
  };
}

export function makeOgre(personality: Personality = "stoic"): Creature {
  return {
    kind: "ogre",
    modelSlot: "ogre",
    model: process.env.GOBLINTOWN_MODEL_OGRE ?? "gpt-5.5",
    temperature: 0.3,
    personality,
    systemPrompt:
      `You are an Ogre in the Goblintown protocol. ` +
      `You are the heavyweight: large context, slow, expensive, called only when a Goblin pack has failed or the task requires deep reasoning. ` +
      `Think before answering. Produce a single dense, structured answer. ` +
      `If prior pack outputs are provided, synthesize the best parts and correct their errors.` +
      personalityTag(personality),
  };
}

export function makePigeon(personality: Personality = "chipper"): Creature {
  return {
    kind: "pigeon",
    modelSlot: "pigeon",
    model: process.env.GOBLINTOWN_MODEL_PIGEON ?? "gpt-5.4-mini",
    temperature: 0.5,
    personality,
    systemPrompt:
      `You are a Pigeon in the Goblintown protocol. ` +
      `Your job is to compress and route: you receive a long artifact and a target audience. ` +
      `Produce a maximally short carrier-message that preserves the essential facts and instructions for that audience. ` +
      `Output only the compressed message. No commentary.` +
      personalityTag(personality),
  };
}

/**
 * Pigeon-as-Scribe variant: distills a completed Rite into a structured
 * Artifact JSON. Cheap model, low temperature, JSON-only output.
 */
export function makeScribe(personality: Personality = "stoic"): Creature {
  return {
    kind: "pigeon",
    modelSlot: "scribe",
    model: process.env.GOBLINTOWN_MODEL_SCRIBE ?? "gpt-5.4-mini",
    temperature: 0.2,
    personality,
    systemPrompt:
      `You are a Pigeon in the Goblintown protocol acting as Scribe. ` +
      `You receive a completed rite — its task, the winning output, the troll's verdict, and the gremlin's critiques — and you distill it into a typed Artifact. ` +
      `Output a single JSON object and nothing else, matching this schema exactly:\n` +
      `{\n` +
      `  "claims": [{ "text": string, "confidence": "established"|"likely"|"speculative", "evidenceIds": number[] }],\n` +
      `  "evidence": [{ "kind": "loot"|"file"|"url"|"external", "ref": string, "snippet": string }],\n` +
      `  "openQuestions": string[],\n` +
      `  "nextSteps": string[],\n` +
      `  "keywords": string[]\n` +
      `}\n` +
      `Rules: claims are concise (one sentence each), grounded in the winning output. ` +
      `Evidence "ref" is a loot id, file path, or url already mentioned in the inputs — don't fabricate. ` +
      `Keywords are lowercase single words or short phrases useful for retrieval. ` +
      `If a list is empty, return []. Output JSON only, no prose, no code fences.` +
      personalityTag(personality),
  };
}

export function makeCreature(
  kind: CreatureKind,
  personality?: Personality,
): Creature {
  switch (kind) {
    case "goblin":
      return makeGoblin(personality);
    case "gremlin":
      return makeGremlin(personality);
    case "raccoon":
      return makeRaccoon(personality);
    case "troll":
      return makeTroll(personality);
    case "ogre":
      return makeOgre(personality);
    case "pigeon":
      return makePigeon(personality);
  }
}
