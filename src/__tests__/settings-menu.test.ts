import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");

describe("settings launcher", () => {
  it("keeps the top strip focused on status and one settings entry point", () => {
    const stripStart = serverSource.indexOf('<div class="strip">');
    const stripEnd = serverSource.indexOf("</div>", stripStart);
    assert.notEqual(stripStart, -1);
    assert.notEqual(stripEnd, -1);
    const stripMarkup = serverSource.slice(stripStart, stripEnd);

    assert.match(stripMarkup, /id="settings-chip"[^>]*>Settings ▾<\/button>/);
    assert.doesNotMatch(stripMarkup, /id="auth-chip"/);
    assert.doesNotMatch(stripMarkup, /id="country-chip"/);
    assert.doesNotMatch(stripMarkup, /id="mail-chip"/);
    assert.doesNotMatch(stripMarkup, /id="provider-chip"/);
    assert.doesNotMatch(stripMarkup, /id="btn-asteroid"/);
  });

  it("collects account, country, mail, API, and a nested reset menu in the settings launcher", () => {
    const settingsStart = serverSource.indexOf('id="settings-popover"');
    const settingsEnd = serverSource.indexOf('id="provider-popover"', settingsStart);
    assert.notEqual(settingsStart, -1);
    assert.notEqual(settingsEnd, -1);
    const settingsMarkup = serverSource.slice(settingsStart, settingsEnd);

    assert.match(settingsMarkup, /data-settings-label="Account"/);
    assert.match(settingsMarkup, /data-settings-label="Country"/);
    assert.match(settingsMarkup, /data-settings-label="Mail"/);
    assert.match(settingsMarkup, /data-settings-label="API"/);
    assert.match(settingsMarkup, /id="reset-chip"[\s\S]*<span>Reset<\/span>[\s\S]*Reset ▸/);
    assert.match(settingsMarkup, /id="settings-reset-panel"[\s\S]*id="btn-asteroid"[\s\S]*Asteroid Mode/);
    assert.match(serverSource, /const settingsChip = \$\("settings-chip"\)/);
    assert.match(serverSource, /const resetChip = \$\("reset-chip"\)/);
    assert.match(serverSource, /function setResetMenuOpen/);
    assert.match(serverSource, /function setSettingsActionText/);
    assert.match(serverSource, /closeSettingsPopover\(\)/);
  });
});
