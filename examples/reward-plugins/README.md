# Reward plugin examples

Goblintown lets a Warren override Shinies scoring by adding a local:

```txt
.goblintown/reward.mjs
```

This folder contains small example reward plugins that can be copied into a Warren.

## driftless-shinies.mjs

A conservative scoring profile that rewards passed Troll verdicts while giving a small bonus to low-drift outputs.

```bash
mkdir -p .goblintown
cp examples/reward-plugins/driftless-shinies.mjs .goblintown/reward.mjs
```

The returned score is clamped between `0` and `1`.
