/**
 * Ambient babble engine for the Goblintown Square.
 *
 * Generates an endless stream of in-character chatter from the bestiary and
 * fans it out to any number of SSE subscribers. Now supports conversational
 * "exchanges": when a creature speaks, there's a chance a related creature
 * fires back a contextual reply, so the square feels like dialogue instead
 * of a list of soliloquies.
 */

import { CREATURE_KINDS, type CreatureKind } from "./types.js";

export type BabbleKind =
  | "chatter"   // ambient in-character line
  | "news"      // real Hoard event
  | "system";   // server-side announcement

export interface BabbleEvent {
  id: number;
  ts: number;
  kind: BabbleKind;
  speaker: CreatureKind | "town";
  speakerIdx?: number;     // which goblin in the square (0..N-1) for chatter
  text: string;
  /** If set, this line is a direct reply to the previous speaker. */
  replyTo?: CreatureKind | "town";
}

type Listener = (ev: BabbleEvent) => void;

// --- Solo lines (the creature talking to themselves / the room) ---
const SOLO: Record<CreatureKind, string[]> = {
  goblin: [
    "got a shiny new draft, heeheehee",
    "what if we just ship it?",
    "anyone seen my hammer?",
    "task says 'refactor' — i say 'redraft'",
    "rolling on context like dice",
    "the cynical one is being cynical again",
    "i am simply a creature of pack rolls",
    "tinker variant getting bold today",
    "okay okay okay i have an idea",
  ],
  gremlin: [
    "*sigh* another draft.",
    "i found seventeen smells already",
    "did anyone read the spec?",
    "rejecting on principle",
    "this would compile in a perfect world",
    "lint is a moral position",
  ],
  troll: [
    "the docket is full",
    "a verdict approaches",
    "judgement, like rain, must fall",
    "0.91 — the hoard rejoices",
    "scoring rubric updated. nobody is happy.",
  ],
  raccoon: [
    "scavenged 47 files, three were worth it",
    "found something in node_modules. don't ask.",
    "pawing through the README",
    "facts gathered. trash collected.",
    "2KB of pure intel, fresh from the bin",
  ],
  ogre: [
    "...",
    "let me cook",
    "*grumbling*",
    "fine. synthesizing.",
  ],
  pigeon: [
    "coo. message dispatched.",
    "inbound from peer warren",
    "HMAC checks out",
    "got crumbs, will deliver",
  ],
};

// --- Conversation seeds: when X says this, Y might fire back ---
interface Exchange {
  speaker: CreatureKind;
  line: string;
  reply: { speaker: CreatureKind; line: string };
}
const EXCHANGES: Exchange[] = [
  // goblin → gremlin
  {
    speaker: "goblin",
    line: "draft #{n} ready, who's reviewing?",
    reply: { speaker: "gremlin", line: "i'll review. you won't like it." },
  },
  {
    speaker: "goblin",
    line: "i think this one's a winner",
    reply: { speaker: "troll", line: "i'll be the judge of that." },
  },
  {
    speaker: "goblin",
    line: "anyone got more context for me?",
    reply: { speaker: "raccoon", line: "i got a whole pile. catch." },
  },
  // gremlin → goblin
  {
    speaker: "gremlin",
    line: "off-by-one on draft #{n}",
    reply: { speaker: "goblin", line: "off-by-one is a feature, technically" },
  },
  {
    speaker: "gremlin",
    line: "nobody handles errors anymore",
    reply: { speaker: "ogre", line: "i will handle it. as i always do." },
  },
  // troll → goblin
  {
    speaker: "troll",
    line: "draft #{n} scores 0.{s}. mid.",
    reply: { speaker: "goblin", line: "harsh but fair, your honor" },
  },
  {
    speaker: "troll",
    line: "all of you. failed. all of you.",
    reply: { speaker: "ogre", line: "...so it's me again." },
  },
  // raccoon → goblin
  {
    speaker: "raccoon",
    line: "fresh facts, hot off the disk",
    reply: { speaker: "goblin", line: "gimme gimme gimme" },
  },
  // pigeon → town
  {
    speaker: "pigeon",
    line: "incoming pigeon from {peer}",
    reply: { speaker: "troll", line: "verify the signature first." },
  },
  // ogre → ?
  {
    speaker: "ogre",
    line: "the pack failed. as predicted.",
    reply: { speaker: "gremlin", line: "told you. i told all of you." },
  },
  // pure goblin gossip
  {
    speaker: "goblin",
    line: "psst — what's #{n} cooking?",
    reply: { speaker: "goblin", line: "smells like fallback weather to me" },
  },
];

const SYSTEM_LINES = [
  "the warren stirs.",
  "a torch flickers in the hoard.",
  "shinies rattle in the vault.",
  "the cycle continues.",
];

const PEERS = ["mossguard", "thornmoor", "the-other-warren", "rustbottom"];

export interface BabbleOptions {
  /** Seconds between ambient chatter messages. Default 4. */
  intervalSec?: number;
  bufferSize?: number;
  /** Number of goblins on the stage (also caps speakerIdx for chatter). */
  goblinCount?: number;
  /** Probability (0-1) that a chatter event triggers a reply. Default 0.55. */
  replyChance?: number;
  /** Delay range for scripted replies in ms. */
  replyDelayMs?: [number, number];
}

export class BabbleEngine {
  private listeners = new Set<Listener>();
  private buffer: BabbleEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private nextId = 1;
  private readonly intervalMs: number;
  private readonly bufferSize: number;
  private readonly replyChance: number;
  private readonly replyDelay: [number, number];
  readonly goblinCount: number;
  private lastSpeaker: CreatureKind | "town" = "town";

  constructor(opts: BabbleOptions = {}) {
    this.intervalMs = (opts.intervalSec ?? 4) * 1000;
    this.bufferSize = opts.bufferSize ?? 60;
    this.goblinCount = Math.max(1, Math.min(opts.goblinCount ?? 6, 24));
    this.replyChance = opts.replyChance ?? 0.55;
    this.replyDelay = opts.replyDelayMs ?? [900, 2200];
  }

  start(): void {
    if (this.timer) return;
    this.emit({
      kind: "system",
      speaker: "town",
      text: pick(SYSTEM_LINES),
    });
    this.timer = setInterval(() => this.tickChatter(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recent(): BabbleEvent[] {
    return [...this.buffer];
  }

  news(speaker: CreatureKind | "town", text: string): void {
    this.emit({ kind: "news", speaker, text });
  }

  // Roll a chatter event. Sometimes that's a 1-shot soliloquy, sometimes
  // it's the opening line of a scripted exchange whose reply lands a beat later.
  private tickChatter(): void {
    const roll = Math.random();
    if (roll < this.replyChance) {
      const ex = pick(EXCHANGES);
      const speakerIdx = ex.speaker === "goblin" ? this.pickGoblin() : undefined;
      const replyIdx = ex.reply.speaker === "goblin" ? this.pickGoblin(speakerIdx) : undefined;
      this.emit({
        kind: "chatter",
        speaker: ex.speaker,
        speakerIdx,
        text: this.fill(ex.line),
      });
      const [lo, hi] = this.replyDelay;
      const delay = lo + Math.random() * (hi - lo);
      setTimeout(() => {
        this.emit({
          kind: "chatter",
          speaker: ex.reply.speaker,
          speakerIdx: replyIdx,
          text: this.fill(ex.reply.line),
          replyTo: ex.speaker,
        });
      }, delay).unref?.();
      return;
    }
    // Solo line — but try not to repeat the same speaker twice in a row.
    let speaker = pick(CREATURE_KINDS);
    if (speaker === this.lastSpeaker) speaker = pick(CREATURE_KINDS);
    const text = this.fill(pick(SOLO[speaker]));
    const speakerIdx = speaker === "goblin" ? this.pickGoblin() : undefined;
    this.emit({ kind: "chatter", speaker, speakerIdx, text });
  }

  private fill(s: string): string {
    return s
      .replace(/\{n\}/g, String(this.pickGoblin()))
      .replace(/\{s\}/g, String(10 + Math.floor(Math.random() * 89)))
      .replace(/\{peer\}/g, pick(PEERS));
  }

  private pickGoblin(notThis?: number): number {
    if (this.goblinCount <= 1) return 0;
    let n = Math.floor(Math.random() * this.goblinCount);
    if (n === notThis) n = (n + 1) % this.goblinCount;
    return n;
  }

  private emit(partial: Omit<BabbleEvent, "id" | "ts">): void {
    const ev: BabbleEvent = { id: this.nextId++, ts: Date.now(), ...partial };
    this.buffer.push(ev);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    this.lastSpeaker = ev.speaker;
    for (const fn of this.listeners) {
      try { fn(ev); } catch { /* a single bad subscriber should not poison the broadcast */ }
    }
  }
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

