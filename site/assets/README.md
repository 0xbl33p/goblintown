Pigeon sprite sheets for the tank UI live here.

Expected filenames:

- `pigeon-walk-right.png`
- `pigeon-walk-left.png`
- `pigeon-peck.png` (optional)

Expected layout:

- 5 columns x 5 rows
- 25 frames total
- transparent background preferred

The UI automatically falls back to emoji if the files are missing.
If `pigeon-walk-left.png` is missing, the right sheet is mirrored at runtime.
If `pigeon-peck.png` is present, the pigeon will randomly play a peck cycle
while idle (roughly every 40 to 120 seconds), then resume walking.
