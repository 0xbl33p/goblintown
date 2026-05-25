Goblintown desktop installer parts
==================================

GitHub blocks regular git blobs above 100 MB and this fork cannot upload new
Git LFS objects, so the installer artifacts in this folder are split into
90 MB parts.

To reconstruct an installer, concatenate its parts in lexical order from the
repository root. Examples:

```sh
cat release/parts/Goblintown-0.6.0-beta.1-mac-arm64.dmg.part-* > release/Goblintown-0.6.0-beta.1-mac-arm64.dmg
cat release/parts/Goblintown-0.6.0-beta.1-mac-x64.dmg.part-* > release/Goblintown-0.6.0-beta.1-mac-x64.dmg
cat release/parts/Goblintown-0.6.0-beta.1-linux-x86_64.AppImage.part-* > release/Goblintown-0.6.0-beta.1-linux-x86_64.AppImage
cat release/parts/Goblintown-0.6.0-beta.1-linux-arm64.AppImage.part-* > release/Goblintown-0.6.0-beta.1-linux-arm64.AppImage
cat release/parts/Goblintown-0.6.0-beta.1-win.exe.part-* > release/Goblintown-0.6.0-beta.1-win.exe
cat release/parts/Goblintown-0.6.0-beta.1-win-x64.exe.part-* > release/Goblintown-0.6.0-beta.1-win-x64.exe
cat release/parts/Goblintown-0.6.0-beta.1-win-arm64.exe.part-* > release/Goblintown-0.6.0-beta.1-win-arm64.exe
```

Then verify the reconstructed installers:

```sh
shasum -a 256 -c release/parts/SHA256SUMS.txt
```

The `.blockmap` files are included unsplit for updater metadata.
