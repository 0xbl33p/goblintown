#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

if (process.platform === "darwin") {
  const identities = commandOk("security", ["find-identity", "-v", "-p", "codesigning"]);
  add("Apple Developer ID identity installed", /Developer ID Application/.test(identities), identities.trim());
} else {
  add("Apple Developer ID identity installed", false, "Run release:ready on the signing Mac.");
}

add("Apple notarization env present", Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID), "APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID");
add("Windows signing env present", Boolean(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD), "CSC_LINK, CSC_KEY_PASSWORD");

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
