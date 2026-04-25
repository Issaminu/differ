#!/usr/bin/env bash
# Compile an Icon Composer ".icon" bundle into Assets.car for macOS 26+ Liquid Glass.
# Requires full Xcode (not only CLT) so `actool` can run.
# Keep generating icon.icns via `bun tauri icon …` for older macOS (see README).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICON_PATH="${1:-$ROOT/branding/differ.icon}"
OUT_DIR="${ROOT}/src-tauri/resources/macos"
PLIST_PATH="${OUT_DIR}/assetcatalog_generated_info.plist"
APP_ICON_NAME="${APP_ICON_NAME:-AppIcon}"

if [[ ! -e "$ICON_PATH" ]]; then
  echo "usage: $0 <path-to.icon>" >&2
  echo "example: $0 \"\$HOME/Projects/differ.icon\"" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

xcrun actool "$ICON_PATH" --compile "$OUT_DIR" \
  --output-format human-readable-text --notices --warnings --errors \
  --output-partial-info-plist "$PLIST_PATH" \
  --app-icon "$APP_ICON_NAME" --include-all-app-icons \
  --enable-on-demand-resources NO \
  --target-device mac \
  --minimum-deployment-target 26.0 \
  --platform macosx

rm -f "$PLIST_PATH"
echo "Wrote $OUT_DIR/Assets.car (merge CFBundleIconName = $APP_ICON_NAME in Info.plist and bundle.macOS.files — see README)."
