#!/usr/bin/env bash
# Assemble a macOS .app bundle for the GPUI Differ.
#
# Produces dist/Differ.app from the release binary + native/macos/Info.plist +
# the existing icon. The bundle is UNSIGNED and NOT notarized (deliberate TODO —
# see fork-patches/README and the signing_deferred memory). To distribute it
# outside your own machine you must codesign + notarize it separately.
#
# Usage:
#   scripts/bundle-macos.sh            # bundle (builds release if missing)
#   BUILD=1 scripts/bundle-macos.sh    # force a fresh release build first
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$REPO/dist/Differ.app"
BIN="$REPO/native/target/release/differ-native"
PLIST="$REPO/native/macos/Info.plist"
ICON="$REPO/src-tauri/icons/icon.icns"

if [ "${BUILD:-0}" = "1" ] || [ ! -f "$BIN" ]; then
  echo "Building release binary…"
  cargo build --release --manifest-path "$REPO/native/Cargo.toml"
fi
[ -f "$BIN" ] || { echo "error: release binary not found at $BIN"; exit 1; }

echo "Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/differ-native"
cp "$PLIST" "$APP/Contents/Info.plist"
if [ -f "$ICON" ]; then
  cp "$ICON" "$APP/Contents/Resources/icon.icns"
else
  echo "warning: icon not found at $ICON — bundle will use the generic app icon"
fi

# Ad-hoc sign so Gatekeeper lets it launch locally (this is NOT notarization).
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 \
    && echo "Ad-hoc signed (local launch only; not notarized)." \
    || echo "warning: ad-hoc codesign failed — you may need to right-click > Open the first time."
fi

echo "Done: $APP"
echo "Note: unsigned/un-notarized. Distribution requires codesign + notarize."
