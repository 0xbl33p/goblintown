import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");

describe("settings launcher", () => {
  it("keeps the top strip focused on status without duplicate menus", () => {
    const stripStart = serverSource.indexOf('<div class="strip">');
    const stripEnd = serverSource.indexOf("</div>", stripStart);
    assert.notEqual(stripStart, -1);
    assert.notEqual(stripEnd, -1);
    const stripMarkup = serverSource.slice(stripStart, stripEnd);

    assert.doesNotMatch(stripMarkup, /id="settings-chip"/);
    assert.doesNotMatch(stripMarkup, /Settings ▾/);
    assert.doesNotMatch(stripMarkup, /id="auth-chip"/);
    assert.doesNotMatch(stripMarkup, /id="country-chip"/);
    assert.doesNotMatch(stripMarkup, /id="mail-chip"/);
    assert.doesNotMatch(stripMarkup, /id="provider-chip"/);
    assert.doesNotMatch(stripMarkup, /id="btn-asteroid"/);
  });

  it("collects account, country, group chats, add-ons, API, sentiment config, and a nested reset menu in the settings launcher", () => {
    const settingsStart = serverSource.indexOf('id="settings-popover"');
    const settingsEnd = serverSource.indexOf('id="provider-popover"', settingsStart);
    assert.notEqual(settingsStart, -1);
    assert.notEqual(settingsEnd, -1);
    const settingsMarkup = serverSource.slice(settingsStart, settingsEnd);

    assert.match(settingsMarkup, /data-settings-label="Account"/);
    assert.match(settingsMarkup, /data-settings-label="Country"/);
    assert.match(settingsMarkup, /data-settings-label="Group Chats"/);
    assert.doesNotMatch(settingsMarkup, /data-settings-label="Mail"/);
    assert.match(settingsMarkup, /data-settings-label="Add-ons"/);
    assert.match(settingsMarkup, /data-settings-label="API"/);
    assert.match(settingsMarkup, /id="sentiment-config-chip"[\s\S]*data-settings-label="Sentiment Sources"/);
    assert.match(settingsMarkup, /id="reset-chip"[\s\S]*<span>Reset<\/span>[\s\S]*Reset ▸/);
    assert.match(settingsMarkup, /id="settings-reset-panel"[\s\S]*id="btn-asteroid"[\s\S]*Asteroid Mode/);
    assert.match(serverSource, /const settingsTrigger = \$\("btn-sidebar-settings"\)/);
    assert.match(serverSource, /const resetChip = \$\("reset-chip"\)/);
    assert.match(serverSource, /const addonChip = \$\("addon-chip"\)/);
    assert.match(serverSource, /fetch\("\/api\/addons"/);
    assert.match(serverSource, /function setResetMenuOpen/);
    assert.match(serverSource, /function setSettingsActionText/);
    assert.match(serverSource, /closeSettingsPopover\(\)/);
  });

  it("keeps the settings menu scrollable when controls exceed the visible tank area", () => {
    const style = serverSource.match(/\.settings-popover\s*\{(?<body>[\s\S]*?)\n  \}/);
    assert.ok(style?.groups?.body);
    assert.match(style.groups.body, /max-height:[^;]+;/);
    assert.match(style.groups.body, /overflow-y:\s*scroll;/);
    assert.match(style.groups.body, /scrollbar-gutter:\s*stable;/);
  });
});
