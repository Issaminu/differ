# gpui-component fork patches

`native/` depends on a **forked** `gpui-component` (vendored at
`vendor/gpui-component`, gitignored) that adds a diff-highlight API to the
editor so Differ's tints render *inside* the editor (composited with syntax
highlighting), instead of via an overlay.

The full vendored crate (~28 MB) is not committed. These are the only files we
change vs upstream `gpui-component` **rev `2587914`**:

- `state.rs` → `crates/ui/src/input/state.rs`
  - adds `InputState.diff_highlights` field
  - adds `pub fn set_diff_highlights(...)` + `diff_highlights_for_range(...)`
- `element.rs` → `crates/ui/src/input/element.rs`
  - in `highlight_lines`, composes `diff_highlights_for_range` as a base layer
    via `gpui::combine_highlights` (they set only `background_color`, so they
    layer under the syntax foreground colours)
- `text_wrapper.rs` → `crates/ui/src/input/display_map/text_wrapper.rs`
  - `LineLayout::paint` now calls `ShapedLine::paint_background` before
    `::paint` — gpui's `paint()` draws glyphs only, NOT run backgrounds, so
    without this the diff tints (run `background_color`) never render
- `workspace-Cargo.toml` → `Cargo.toml`
  - pins the zed/gpui deps to the exact rev `native/` uses, so gpui resolves to
    a single version (a skew breaks `Entity<InputState>` across the boundary)

## Recreate the fork

```bash
scripts/setup-gpui-fork.sh
```

(Requires gpui-component to have been fetched once by cargo.) Upstreaming these
as a "custom highlights" API to gpui-component would remove the fork entirely.
