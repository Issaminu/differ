# Distributing Differ (GPUI native)

The GPUI rewrite lives in [`native/`](native/). This is how it's packaged for
macOS, and what's intentionally deferred.

## Build a `.app`

```bash
BUILD=1 scripts/bundle-macos.sh
```

This builds the release binary and assembles `dist/Differ.app`:

```
Differ.app/Contents/
  Info.plist          # from native/macos/Info.plist (id com.issaminu.differ, v0.1.4)
  MacOS/differ-native # the release binary
  Resources/icon.icns # reused from src-tauri/icons/icon.icns
```

The script ad-hoc signs the bundle (`codesign --sign -`) so it launches on the
build machine. Ad-hoc signing is **not** notarization — Gatekeeper will still
warn on other machines.

## Deferred: signing, notarization, updater

These three are coupled and intentionally not wired up yet (see the
`signing_deferred` note in project memory):

- **Developer ID signing** — needs an Apple Developer ID Application
  certificate. Once available:
  `codesign --force --deep --options runtime --sign "Developer ID Application: …" dist/Differ.app`
- **Notarization** — `xcrun notarytool submit dist/Differ.app.zip --wait` +
  `xcrun stapler staple dist/Differ.app`, using an App Store Connect API key.
- **Auto-updater** — the old Tauri app used the Tauri updater (GitHub releases +
  `latest.json`). A raw GPUI binary has no equivalent; a self-update path
  (e.g. Sparkle, or a check-endpoint + download + in-place swap + relaunch)
  only makes sense **after** signing exists, because Gatekeeper blocks
  launching an unsigned replacement. So the updater is deferred until signing
  is set up.

Until then: ship the unsigned `.app` and open it with right-click → Open the
first time, or run `native/target/release/differ-native` directly.

## Windows / Linux

Not yet packaged. The binary is portable GPUI; bundling for those platforms is a
later task.
