Pigeon sprite sheets for the tank UI live here.

Expected filenames:

- `pigeon-walk-right.png`
- `pigeon-walk-left.png`
- `pigeon-peck.png` (optional)
- `gremlin-idle.png` (optional)
- `ogre-idle.png` (optional)

Expected pigeon layout:

- 5 columns x 5 rows
- 25 frames total
- transparent background preferred

Expected idle creature layouts:

- `gremlin-idle.png`: 5 columns x 4 rows, 20 frames total
- `ogre-idle.png`: 8 columns x 4 rows, 32 frames total, read top-to-bottom before advancing columns

The UI automatically falls back to emoji if the files are missing.
If `pigeon-walk-left.png` is missing, the right sheet is mirrored at runtime.
If `pigeon-peck.png` is present, the pigeon will randomly play a peck cycle
while idle (roughly every 40 to 120 seconds), then resume walking.
Gremlin and ogre idle sheets loop in place while preserving the normal tank
state glow and dimming effects.
