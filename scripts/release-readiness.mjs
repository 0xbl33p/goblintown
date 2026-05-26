#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const partDir = join(root, "release", "parts");
const requiredArtifacts = [
  `Goblintown-${version}-mac-arm64.dmg`,
  `Goblintown-${version}-mac-x64.dmg`,
  `Goblintown-${version}-linux-x86_64.AppImage`,
  `Goblintown-${version}-linux-arm64.AppImage`,
  `Goblintown-${version}-win.exe`,
  `Goblintown-${version}-win-x64.exe`,
  `Goblintown-${version}-win-arm64.exe`,
];

const checks = [];

function add(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function commandOk(file, args) {
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return err.stdout?.toString() || err.stderr?.toString() || err.message;
  }
}

function commandResult(file, args) {
  try {
    const output = execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output };
  } catch (err) {
    return {
      ok: false,
      output: err.stdout?.toString() || err.stderr?.toString() || err.message,
    };
  }
}

function verifyMacDmgAppSignature(artifact) {
  if (process.platform !== "darwin") return { ok: true, output: "skipped outside macOS" };
  const dmg = join(root, "release", artifact);
  if (!existsSync(dmg)) return { ok: false, output: `${artifact} missing` };
  const mount = mkdtempSync(join(tmpdir(), "goblintown-release-dmg-"));
  try {
    const attach = commandResult("hdiutil", ["attach", dmg, "-mountpoint", mount, "-nobrowse", "-readonly"]);
    if (!attach.ok) return attach;
    const app = join(mount, "Goblintown.app");
    return commandResult("codesign", ["--verify", "--deep", "--strict", "--verbose=4", app]);
  } finally {
    commandResult("hdiutil", ["detach", mount]);
    rmSync(mount, { recursive: true, force: true });
  }
}

add("package version is beta 0.7", /^0\.7\.0-beta\.\d+$/.test(version), version);
add("release parts directory exists", existsSync(partDir), "release/parts");

if (existsSync(partDir)) {
  const files = readdirSync(partDir);
  for (const artifact of requiredArtifacts) {
    add(`${artifact} parts exist`, files.some((file) => file.startsWith(`${artifact}.part-`)), artifact);
  }
  add("SHA256SUMS.txt exists", existsSync(join(partDir, "SHA256SUMS.txt")), "release/parts/SHA256SUMS.txt");
}

const checksumOutput = commandOk("shasum", ["-a", "256", "-c", "release/parts/SHA256SUMS.txt"]);
add("split installer checksums verify", !/FAILED|No such file|not found/i.test(checksumOutput), checksumOutput.trim());

for (const artifact of requiredArtifacts.filter((name) => name.endsWith(".dmg"))) {
  const result = verifyMacDmgAppSignature(artifact);
  add(`${artifact} contains a valid macOS app signature`, result.ok, result.output.trim());
}

const macSigningSecret = Boolean(process.env.MAC_CSC_LINK || process.env.CSC_LINK);
const macSigningPassword = Boolean(process.env.MAC_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD);
const winSigningSecret = Boolean(process.env.WIN_CSC_LINK || process.env.CSC_LINK);
const winSigningPassword = Boolean(process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD);

if (process.platform === "darwin") {
  const identities = commandOk("security", ["find-identity", "-v", "-p", "codesigning"]);
  add(
    "Apple Developer ID identity installed or provided",
    /Developer ID Application/.test(identities) || (macSigningSecret && macSigningPassword),
    identities.trim() || "MAC_CSC_LINK/MAC_CSC_KEY_PASSWORD or CSC_LINK/CSC_KEY_PASSWORD",
  );
} else {
  add(
    "Apple Developer ID identity installed or provided",
    macSigningSecret && macSigningPassword,
    "Run release:ready on the signing Mac, or provide MAC_CSC_LINK/MAC_CSC_KEY_PASSWORD.",
  );
}

add("Apple notarization env present", Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID), "APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID");
add("Windows signing env present", winSigningSecret && winSigningPassword, "WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD or CSC_LINK/CSC_KEY_PASSWORD");

let failed = false;
for (const check of checks) {
  const mark = check.ok ? "ok" : "missing";
  if (!check.ok) failed = true;
  console.log(`${mark}: ${check.name}`);
  if (check.detail) console.log(`  ${String(check.detail).split("\n").slice(0, 4).join("\n  ")}`);
}

if (failed) {
  console.error("\nRelease is not idiot-proof yet. Build signed/notarized macOS assets and signed Windows assets before publishing as public installers.");
  process.exit(1);
}

console.log("\nRelease readiness checks passed. Public installer publishing is clear.");
