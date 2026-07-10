#!/usr/bin/env bash
# Recreate the vendored gpui-component fork that native/ depends on.
#
# We fork gpui-component to add a diff-highlight API to its editor (so Differ's
# tints render inside the editor). The full crate is ~28MB and NOT committed
# (see .gitignore); instead our changes live in fork-patches/ and this script
# reconstructs vendor/gpui-component from the cargo checkout + those overrides.
#
# Prereq: gpui-component must have been fetched once by cargo (it will be, since
# it's a git dependency at rev 2587914). Run from the repo root.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
REV="2587914"
DEST="$REPO/vendor/gpui-component"

SRC="$(find "$HOME/.cargo/git/checkouts" -maxdepth 2 -type d -path "*gpui-component*/$REV" 2>/dev/null | head -1)"
if [ -z "$SRC" ]; then
  echo "Could not find gpui-component@$REV in the cargo checkout cache."
  echo "Run 'cargo fetch' (or a build) once so cargo clones it, then re-run."
  exit 1
fi

echo "Vendoring $SRC -> $DEST"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
rm -rf "$DEST/.git"   # strip the embedded checkout repo

echo "Applying fork-patches/ overrides"
cp "$REPO/fork-patches/state.rs"             "$DEST/crates/ui/src/input/state.rs"
cp "$REPO/fork-patches/element.rs"           "$DEST/crates/ui/src/input/element.rs"
cp "$REPO/fork-patches/text_wrapper.rs"      "$DEST/crates/ui/src/input/display_map/text_wrapper.rs"
cp "$REPO/fork-patches/workspace-Cargo.toml" "$DEST/Cargo.toml"
# Extra toolbar icons (Lucide, MIT) not in upstream's set — become IconName
# variants via the icon_named! glob + are embedded by gpui-component-assets.
cp "$REPO"/fork-patches/icons/*.svg          "$DEST/crates/assets/assets/icons/"

echo "Done. 'cargo build --manifest-path native/Cargo.toml' should now build against the fork."
