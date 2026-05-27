# Installing Beta 0.7

Beta `0.7.0-beta.1` ships desktop installer packages for macOS, Windows, and
Linux. They are real installer payloads, but this beta is not yet the final
signed public release.

## Current Download Reality

The intended GitHub Release URL is:

```text
https://github.com/water-bear86/goblintown/releases/tag/v0.7.0-beta.1
```

Repository rules currently block creating the `v0.7.0-beta.1` tag, so the
current canonical public fallback is the split-parts branch:

```text
https://github.com/water-bear86/goblintown/tree/release/v0.7.0-beta.1/release/parts
```

The split route exists because regular git blobs above 100 MB are blocked and
this fork cannot rely on new Git LFS objects. Each large installer is split into
90 MB parts. Download every matching `*.part-*` file for your platform, keep
lexical order, concatenate, then verify.

## Reconstruct

Run from the repository root:

```bash
cat release/parts/Goblintown-0.7.0-beta.1-mac-arm64.dmg.part-* > release/Goblintown-0.7.0-beta.1-mac-arm64.dmg
cat release/parts/Goblintown-0.7.0-beta.1-mac-x64.dmg.part-* > release/Goblintown-0.7.0-beta.1-mac-x64.dmg
cat release/parts/Goblintown-0.7.0-beta.1-linux-x86_64.AppImage.part-* > release/Goblintown-0.7.0-beta.1-linux-x86_64.AppImage
cat release/parts/Goblintown-0.7.0-beta.1-linux-arm64.AppImage.part-* > release/Goblintown-0.7.0-beta.1-linux-arm64.AppImage
cat release/parts/Goblintown-0.7.0-beta.1-win.exe.part-* > release/Goblintown-0.7.0-beta.1-win.exe
cat release/parts/Goblintown-0.7.0-beta.1-win-x64.exe.part-* > release/Goblintown-0.7.0-beta.1-win-x64.exe
cat release/parts/Goblintown-0.7.0-beta.1-win-arm64.exe.part-* > release/Goblintown-0.7.0-beta.1-win-arm64.exe
```

Then verify:

```bash
shasum -a 256 -c release/parts/SHA256SUMS.txt
```

## Install

| Platform | What to do |
| --- | --- |
| macOS | Open the DMG, drag Goblintown to Applications, launch. If Gatekeeper blocks it, right-click **Open** or approve in Privacy & Security. |
| Windows | Run the NSIS EXE. If SmartScreen appears, use **More info** then **Run anyway**. |
| Linux | Mark the AppImage executable with `chmod +x`, then run it. |

## Signing Status

The source config is prepared for real public releases:

- `forceCodeSigning: true`
- hardened runtime
- macOS entitlements under `build/`
- notarization when Apple credentials are present
- Windows signing through electron-builder secrets
- GitHub workflow at `.github/workflows/desktop-release.yml`

The release workflow expects these signing and notarization secrets:

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Base64 or URL form of the Developer ID certificate for macOS signing. |
| `MAC_CSC_KEY_PASSWORD` | Password for the macOS signing certificate. |
| `APPLE_API_KEY` | App Store Connect API key content or reference for notarization. |
| `APPLE_API_KEY_ID` | App Store Connect API key id. |
| `APPLE_API_ISSUER` | App Store Connect issuer id. |
| `WIN_CSC_LINK` | Base64 or URL form of the Windows Authenticode certificate. |
| `WIN_CSC_KEY_PASSWORD` | Password for the Windows signing certificate. |

Before calling a release public, run:

```bash
npm run release:ready
```

That readiness gate checks the beta 0.7 artifact set, verifies checksums, and
refuses to pass without Apple Developer ID, Apple notarization, and Windows
signing credentials. It is supposed to be rude. A silent ad-hoc release is worse.

## Temporary Uploads

Temporary public mirrors may exist while GitHub release tags are blocked. The
local ignored note is:

```text
release/TEMP_UPLOADS.md
```

Do not treat temporary hosts as the release of record. Use them only to unblock
beta testers while the GitHub tag/release rule is fixed.
