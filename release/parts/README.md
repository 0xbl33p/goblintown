# Goblintown desktop installer parts

This folder carries the beta 0.7 desktop installer payloads when full GitHub
Release assets or new Git LFS objects are not available. It is a transport
fallback for the same DMG, EXE, and AppImage files, not a separate package
format.

Preferred full-asset download:

```text
https://github.com/water-bear86/goblintown/releases/tag/v0.7.0-beta.1
```

Split-parts fallback:

```text
https://github.com/water-bear86/goblintown/tree/release/v0.7.0-beta.1/release/parts
```

GitHub blocks regular git blobs above 100 MB, so the installer artifacts in
this folder are split into 90 MB parts. Download every matching `*.part-*` file
for your platform, keep lexical order, concatenate them, then verify the
checksum.

## Reconstruct

From the repository root:

```sh
cat release/parts/Goblintown-0.7.0-beta.1-mac-arm64.dmg.part-* > release/Goblintown-0.7.0-beta.1-mac-arm64.dmg
cat release/parts/Goblintown-0.7.0-beta.1-mac-x64.dmg.part-* > release/Goblintown-0.7.0-beta.1-mac-x64.dmg
cat release/parts/Goblintown-0.7.0-beta.1-linux-x86_64.AppImage.part-* > release/Goblintown-0.7.0-beta.1-linux-x86_64.AppImage
cat release/parts/Goblintown-0.7.0-beta.1-linux-arm64.AppImage.part-* > release/Goblintown-0.7.0-beta.1-linux-arm64.AppImage
cat release/parts/Goblintown-0.7.0-beta.1-win.exe.part-* > release/Goblintown-0.7.0-beta.1-win.exe
cat release/parts/Goblintown-0.7.0-beta.1-win-x64.exe.part-* > release/Goblintown-0.7.0-beta.1-win-x64.exe
cat release/parts/Goblintown-0.7.0-beta.1-win-arm64.exe.part-* > release/Goblintown-0.7.0-beta.1-win-arm64.exe
```

Then verify the reconstructed installers:

```sh
shasum -a 256 -c release/parts/SHA256SUMS.txt
```

The `.blockmap` files are included unsplit for updater metadata.

## Install

- macOS: open the DMG, drag Goblintown to Applications, then launch it. Because
  this beta is unsigned, macOS may require right-click Open or an explicit
  Privacy & Security approval.
- Windows: run the NSIS installer. Because this beta is unsigned, SmartScreen
  may require More info -> Run anyway.
- Linux: mark the AppImage executable, then launch it.

On first run, Goblintown opens into chat, asks which AI API or local model
should power it, then walks through optional setup.

Release-signing note: these artifacts were generated before Apple Developer ID
and Windows Authenticode credentials were available. They are installer
candidates until signed/notarized macOS and signed Windows artifacts are
produced.
