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
- `search-panel.patch` → `crates/ui/src/input/search.rs`
  - keeps Cmd-F as a solid editor-top Find bar that reserves document space;
    its disclosure expands the optional Replace row
- `search-controller.patch` → `crates/ui/src/input/{mod,search}.rs`
  - exposes the existing `SearchPanel` controller for commands and the
    headful stress harness; it drives the component's matcher and async
    Replace All path rather than carrying a second search implementation
- `combobox-selection.patch` → `crates/ui/src/combobox.rs`
  - fixes single-select commits after filtering when the old and new results
    happen to occupy the same filtered row index
- `combobox-focus-outline.patch` → `crates/ui/src/combobox.rs`
  - respects `appearance(false)` when the combobox is open, so custom trigger
    chrome does not acquire the component theme's unrelated focus border
- `icons/*.svg` → `crates/assets/assets/icons/`
  - adds a filled locked state and a clear two-way arrow for swapping panes
- `icons/languages/*.svg` → `crates/assets/assets/icons/languages/`
  - adds the CC0 Simple Icons brand marks already used by the original web
    language picker, plus neutral Auto/code fallbacks for unbranded grammars

## Recreate the fork

```bash
scripts/setup-gpui-fork.sh
```

(Requires gpui-component to have been fetched once by cargo.) Upstreaming these
as a "custom highlights" API to gpui-component would remove the fork entirely.
