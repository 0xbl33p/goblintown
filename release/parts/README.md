Goblintown desktop installer parts
==================================

GitHub blocks regular git blobs above 100 MB and this fork cannot upload new
Git LFS objects, so the installer artifacts in this folder are split into
90 MB parts.

Beta 0.7 installers:

Canonical repo location while GitHub Release tag creation is restricted:

```text
https://github.com/water-bear86/goblintown/tree/release/v0.7.0-beta.1/release/parts
```

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

Release-signing note: these local artifacts were generated with signing disabled
because this machine currently has no Apple Developer ID or Windows signing
identity. They are install-package candidates, not the final idiot-proof public
release until signed/notarized macOS and signed Windows artifacts are produced.
