import type { CreatureKind } from "./types.js";

const GOBLIN = String.raw`
   ▄█▄        ▄█▄
   ███        ███
    ▀████████████▀
     █  ▀▄  ▄▀  █
     █   ●  ●   █
     █    ▾▾    █
     █▄▄▄▄▄▄▄▄▄▄█
      █▌ █  █ ▐█
      ▀▀ ▀  ▀ ▀▀
`;

const GREMLIN = String.raw`
   ▀▄ ▄▀ ▀▄ ▄▀
     ▀█▄▄█▄▄█▀
      █████████
      █ ◉   ◉ █
      █   ╳   █
      █ ╲╱╲╱╲ █
       ▀█████▀
         █ █
        ▀▀ ▀▀
`;

const RACCOON = String.raw`
    ▄█▄          ▄█▄
    ███          ███
     ▀████████████▀
     █▌ ●▔     ▔● ▐█
     █      ▾      █
     █▄▄▄▄▄▄▄▄▄▄▄▄█
     █▌█        █▐█
     ▀▀▀        ▀▀▀
`;

const TROLL = String.raw`
       ▄ ▄    ▄ ▄
       █ █    █ █
     ▄████████████▄
     █  ●        ●  █
     █     ▾▾▾▾    █
     █  ──────────  █
     ████████████████
    █▌                ▐█
    █▌                ▐█
    ████          ████
    ████          ████
`;

const OGRE = String.raw`
        ▄▄▄▄▄▄▄▄▄▄
       ████████████
      ██  ▀▀    ▀▀  ██
      █     ●    ●    █
      █        ▽       █
      █▄  ▼▼▼▼▼▼▼▼  ▄█
       ████████████
      ██████████████
      ██          ██
      ██          ██
      ▀▀          ▀▀
`;

const PIGEON = String.raw`
       ▄██▄
      ██  ●█
      █▌    █▶▶▶
      ██████████
      █▀▀▀▀▀▀▀▀█
       ████████
          █ █
          █ █
         ▀▀ ▀▀
`;

export const BANNERS: Record<CreatureKind, string> = {
  goblin: GOBLIN,
  gremlin: GREMLIN,
  raccoon: RACCOON,
  troll: TROLL,
  ogre: OGRE,
  pigeon: PIGEON,
};

export function bannerFor(kind: CreatureKind): string {
  return BANNERS[kind];
}

/**
 * Print a creature banner. Defaults to stderr so piping `summon` output to a
 * file or another command keeps the actual response clean.
 * Suppress with GOBLINTOWN_NO_BANNER=1.
 */
export function printBanner(
  kind: CreatureKind,
  out: NodeJS.WritableStream = process.stderr,
): void {
  if (process.env.GOBLINTOWN_NO_BANNER === "1") return;
  out.write(BANNERS[kind] + "\n");
}
