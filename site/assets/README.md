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
- `goblin-green-argue.png`
- `goblin-fire-argue.png`
- `goblin-sceptre-argue.png`
- `goblin-spear-argue.png`
- `goblin-green-defend.png`
- `goblin-fire-defend.png`
- `goblin-sceptre-defend.png`
- `goblin-spear-defend.png`
- `goblin-green-go-home.png`
- `goblin-fire-go-home.png`
- `goblin-sceptre-go-home.png`
- `goblin-spear-go-home.png`
- `goblin-green-come-out.png`
- `goblin-fire-come-out.png`
- `goblin-sceptre-come-out.png`
- `goblin-spear-come-out.png`
- `gtowntextmark.png`
- `gtownlogo.svg`
- `goblintownlogo.svg`
- `mayor-icon.png`

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

Expected goblin action layouts:

The canonical goblin action set is `argue`, `defend`, `go-home`, and
`come-out`. All goblin action sheets are one-row 128 px frame strips.

- `goblin-green-argue.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-fire-argue.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-sceptre-argue.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-spear-argue.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-green-defend.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-fire-defend.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-sceptre-defend.png`: 22 columns x 1 row, 22 frames total, 128 px frames, baked ping-pong loop
- `goblin-spear-defend.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-green-go-home.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-fire-go-home.png`: 14 columns x 1 row, 14 frames total, 128 px frames
- `goblin-sceptre-go-home.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-spear-go-home.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-green-come-out.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-fire-come-out.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-sceptre-come-out.png`: 12 columns x 1 row, 12 frames total, 128 px frames
- `goblin-spear-come-out.png`: 13 columns x 1 row, 13 frames total, 128 px frames

The sceptre defend sheet already includes its return sweep; play it forward
only instead of applying runtime ping-pong. Go Home and Come Out are separate
states; do not reverse one sheet to stand in for the other.

Expected decorative tank assets:

- `gtowntextmark.png`: transparent PNG wordmark, rendered as a low-opacity
  floating background mark
- `gtownlogo.svg`: wide README/marketing banner.
- `goblintownlogo.svg`: legacy vector mark.
- `mayor-icon.png`: distribution icon source used to generate `build/icon.png`, `build/icon.icns`, and `build/icon.ico`.

The UI automatically falls back to emoji only if files are removed or missing in
a fork/local checkout. If `pigeon-walk-left.png` is missing, the right sheet is
mirrored at runtime. The pigeon randomly plays a peck cycle while idle (roughly
within the first few seconds, then every 14 to 35 seconds), then resumes
walking. After scribing finishes, the pigeon returns to idle and queues a quick
peck so the handoff is visible. The raccoon plays the get-up sheet on active
scan, the scurry sheet during handoff, and the get-up sheet in reverse before
returning to sleep. Gremlin, troll, and ogre idle sheets loop in place while
preserving the normal tank state glow and dimming effects. Goblin action sheets
drive the live Tank rite lifecycle: come out, argue, defend, and go home. Keep
them variant-specific instead of collapsing them into a single generic sheet.
