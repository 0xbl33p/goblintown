Pigeon sprite sheets for the tank UI live here.

Expected filenames:

- `pigeon-walk-right.png`
- `pigeon-walk-left.png`
- `pigeon-peck.png` (optional)
- `raccoon-sleep.png` (optional)
- `troll-idle.png` (optional)
- `gremlin-idle.png` (optional)
- `ogre-idle.png` (optional)
- `gtowntextmark.png` (optional decorative tank background)

Expected pigeon layout:

- 5 columns x 5 rows
- 25 frames total
- transparent background preferred

Expected idle creature layouts:

- `gremlin-idle.png`: 5 columns x 4 rows, 20 frames total
- `ogre-idle.png`: 8 columns x 4 rows, 32 frames total, read top-to-bottom before advancing columns
- `raccoon-sleep.png`: 16 columns x 1 row, 16 frames total
- `troll-idle.png`: 24 columns x 1 row, 24 frames total

Expected decorative tank assets:

- `gtowntextmark.png`: transparent PNG wordmark, rendered as a low-opacity
  floating background mark

The UI automatically falls back to emoji if the files are missing.
If `pigeon-walk-left.png` is missing, the right sheet is mirrored at runtime.
If `pigeon-peck.png` is present, the pigeon will randomly play a peck cycle
while idle (roughly every 40 to 120 seconds), then resume walking.
Raccoon sleep and troll idle only display while those creatures are idle;
active/scanning/review states fall back to their normal markers until the
rest of their transition sheets are available. Gremlin and ogre idle sheets
loop in place while preserving the normal tank state glow and dimming effects.
