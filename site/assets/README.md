Default Tank sprite sheets and background assets live here. These files ship in
the npm package and are loaded by `goblintown serve`.

Shipped filenames:

- `pigeon-walk-right.png`
- `pigeon-walk-left.png`
- `pigeon-peck.png`
- `raccoon-sleep.png`
- `raccoon-get-up.png`
- `raccoon-scurry.png`
- `troll-idle.png`
- `gremlin-idle.png`
- `ogre-idle.png`
- `gtowntextmark.png`

Expected pigeon layout:

- 5 columns x 5 rows
- 25 frames total
- transparent background preferred

Expected idle creature layouts:

- `gremlin-idle.png`: 5 columns x 4 rows, 20 frames total
- `ogre-idle.png`: 8 columns x 4 rows, 32 frames total, read top-to-bottom before advancing columns
- `raccoon-sleep.png`: 16 columns x 1 row, 16 frames total
- `raccoon-get-up.png`: 23 columns x 1 row, 23 frames total, mirrored when needed, reversed for go-to-sleep
- `raccoon-scurry.png`: 10 columns x 1 row, 10 frames total, mirrored for left/right movement
- `troll-idle.png`: 24 columns x 1 row, 24 frames total

Expected decorative tank assets:

- `gtowntextmark.png`: transparent PNG wordmark, rendered as a low-opacity
  floating background mark

The UI automatically falls back to emoji only if files are removed or missing in
a fork/local checkout. If `pigeon-walk-left.png` is missing, the right sheet is
mirrored at runtime. The pigeon randomly plays a peck cycle while idle (roughly
every 40 to 120 seconds), then resumes walking. The raccoon plays the get-up
sheet on active scan, the scurry sheet during handoff, and the get-up sheet in
reverse before returning to sleep. Gremlin, troll, and ogre idle sheets loop in
place while preserving the normal tank state glow and dimming effects.
