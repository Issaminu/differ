<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Differ app icon" />
</p>

# Differ

Type in either side, see instant green/red diffs with syntax highlighting and auto language detection.

> **GPUI rewrite in progress.** This branch (`gpui-migration`) replaces the
> Tauri + web-view shell with a fully native [GPUI](https://gpui.rs) app (Zed's
> GPU UI framework). The diff engine is a Rust port of the original pipeline;
> the editor is [gpui-component](https://github.com/longbridge/gpui-component)'s
> `InputState`, lightly forked to render diff tints inside the editor. The
> Tauri/web sections further down still describe the app on `main`.

## Native (GPUI) app

Lives in [`native/`](native/); the diff engine + language detection live in
[`crates/differ-core/`](crates/differ-core/).

### Prerequisites

- macOS 13+ with the Metal toolchain — `xcodebuild -downloadComponent MetalToolchain`
- Rust (stable)

### Run

```sh
cargo run --manifest-path native/Cargo.toml
```

The first build reconstructs the forked editor (see below) and takes a few minutes.

### Test

```sh
cargo test --manifest-path crates/differ-core/Cargo.toml   # diff / pipeline / history
cargo test --manifest-path native/Cargo.toml               # e2e keystroke harness (real editor path)
```

### Headful performance harness

Run the real native window—not a headless surrogate—while it drives a
large-document scenario and prints p50/p95/p99 timings:

```sh
scripts/bench-native-headful.sh typing
scripts/bench-native-headful.sh paint --lines 30000 --changed 50
scripts/bench-native-headful.sh paste --lines 50000 --paste-lines 50000 --verify
scripts/bench-native-headful.sh find --lines 50000 --query item_ --verify
scripts/bench-native-headful.sh replace --lines 50000 --query item_ --replacement entry_ --verify
```

`paste` inserts a single clipboard-sized, multi-line edit into the real editor
and waits for the subsequent diff to settle.

`find` opens GPUI's visible SearchPanel and runs its real matcher over the
large editor. `replace` expands Find & Replace, invokes the panel's normal
async Replace All path, and waits for its editor change event and Differ's
resulting diff to settle. `--verify` implies `--quit` and
returns nonzero unless the live app reports a passing run, making 50k-line
search/replace soak checks suitable for automation.

The window intentionally stays open after a normal report so the full UI can
be inspected. Add `--quit` for an automated run without verification.

### Bundle a `.app`

```sh
BUILD=1 scripts/bundle-macos.sh    # -> dist/Differ.app (unsigned; see DISTRIBUTING.md)
```

### Keyboard shortcuts (native)

| Shortcut | Action |
|----------|--------|
| `F8` / `⇧F8` | Next / previous change |
| `⌘O` | Open a file into the focused pane |
| `⌘⇧X` | Swap sides |
| `⌘⇧K` | Clear both editors |
| `⌘⇧L` | Toggle scroll-lock (sync) |
| `⌘⇧Y` | Toggle history drawer |
| `⌘+` / `⌘-` / `⌘0` | Zoom editor font / reset |

### Where things live (native)

| | |
|---|---|
| App entry, window, key bindings, theme | [native/src/main.rs](native/src/main.rs) |
| Two-pane diff view, toolbar, change-map | [native/src/diff_view.rs](native/src/diff_view.rs) |
| e2e keystroke harness | [native/src/perf_e2e.rs](native/src/perf_e2e.rs) |
| Diff pipeline (per-edit recompute, tints) | [crates/differ-core/src/pipeline.rs](crates/differ-core/src/pipeline.rs) |
| Language detection | [crates/differ-core/src/lang.rs](crates/differ-core/src/lang.rs) |
| History + font-size prefs (on disk) | `~/Library/Application Support/Differ/` |

### The gpui-component fork

The editor is a lightly-forked gpui-component that adds an in-editor
diff-highlight API, so diff tints render *inside* the editor (composited with
syntax highlighting) rather than as an overlay. The full crate is vendored but
gitignored; the changes live in [`fork-patches/`](fork-patches/) and are
reconstructed by [`scripts/setup-gpui-fork.sh`](scripts/setup-gpui-fork.sh).

### Not yet done

Signing / notarization / auto-update (see [DISTRIBUTING.md](DISTRIBUTING.md)); a
preferences panel; a live viewport indicator on the change-map.

---

*The sections below describe the Tauri + web app on `main`.*

## Prerequisites

- macOS 14+
- [bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- Rust (stable, 1.77+) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Xcode Command Line Tools — `xcode-select --install`

## Run it

```sh
bun install
bun tauri dev
```

First run compiles the Rust side and takes a few minutes. Subsequent runs are fast.

## Build a release app

```sh
bun tauri build
```

Produces `src-tauri/target/release/bundle/macos/Differ.app` and a `.dmg`.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘H` | Toggle history drawer |
| `⌘⇧S` | Swap sides |
| `⌘⇧N` | Force a new history entry (bypass dedupe) |
| `⌘⇧⌫` | Clear both editors |
| `⌘F` | Search within focused pane |
| `⌘Z / ⌘⇧Z` | Undo / redo |

## Where things live

| | |
|---|---|
| Editors, merge view, language detection | [src/merge/](src/merge/) |
| State signals | [src/state.ts](src/state.ts) |
| Toolbar, shortcuts, toast | [src/chrome/](src/chrome/) |
| Light/dark CodeMirror themes | [src/theme/](src/theme/) |
| History UI + IPC client | [src/history/](src/history/) |
| Rust history store + dedupe | [src-tauri/src/](src-tauri/src/) |
| Persisted history JSON | `~/Library/Application Support/com.issaminu.differ/history.json` |

## Architecture notes

- **State**: `@preact/signals-core` signals in [src/state.ts](src/state.ts) are the single source of truth. CodeMirror writes on doc change; effects observe and fan out.
- **Diff**: `@codemirror/merge`'s `MergeView` recomputes chunks on each keystroke automatically — no debounce needed for the diff itself.
- **Language detection**: [src/merge/languageDetect.ts](src/merge/languageDetect.ts) — heuristic (shebang → fast-wins → weighted keyword score). Manual override via toolbar dropdown; picking "Auto" re-enables detection.
- **Grammar loading**: lazy via `@codemirror/language-data` — grammar for the detected/selected language is imported on demand.
- **History**: Rust side owns `history.json`. Frontend debounces 2.5s after last edit and calls `invoke('history_capture', ...)`. Dedupe decides append-vs-update in [src-tauri/src/dedupe.rs](src-tauri/src/dedupe.rs) using prefix/suffix hash + Levenshtein on a 1 KB suffix with a 10-minute cutoff.
- **Chrome**: transparent Tauri window + CSS `backdrop-filter` for a faux-glass titlebar/drawer. `data-tauri-drag-region` makes the top strip draggable.

## Icons (for release bundles)

Canonical **1024×1024** master: [`src-tauri/icons/app-icon-1024.png`](src-tauri/icons/app-icon-1024.png). [`bun tauri icon`](https://v2.tauri.app/develop/icons/) reads that file and writes the rest of [`src-tauri/icons/`](src-tauri/icons/) (`icon.icns`, `icon.ico`, sized PNGs, etc.). [`tauri.conf.json`](src-tauri/tauri.conf.json) `bundle.icon` lists those generated paths for the installer and Dock.

Regenerate bundle assets and sync the in-app / Vite copy used by Preferences → About:

```sh
bun run icons
```

That command also copies `src-tauri/icons/128x128@2x.png` → [`public/app-icon.png`](public/app-icon.png) (served at `/app-icon.png` in the UI). Replace `app-icon-1024.png` with your own square PNG, then run `bun run icons` again.

### macOS “Liquid Glass” auto-rendering (macOS 26+)

System-tinted / layered Dock icons on macOS 26+ use Icon Composer’s **`.icon`** bundle, compiled with Xcode’s **`actool`** into `Assets.car`, not the single master PNG alone. Apple’s tooling rasterizes variants from the composed icon.

Rough workflow (full Xcode required once to compile the catalog):

1. Build the icon in [Icon Composer](https://developer.apple.com/icon-composer/), export a `.icon` bundle (e.g. into `branding/`).
2. Run `./scripts/compile-macos-liquid-assets.sh /path/to/your.icon` (set `APP_ICON_NAME` if your catalog name differs from `AppIcon`; it must match `--app-icon` / `CFBundleIconName`).
3. Add the catalog to the app bundle and name it in `Info.plist` (see [Tauri macOS bundle](https://v2.tauri.app/distribute/macos-application-bundle/) and [this overview](https://www.hendrik-erz.de/post/supporting-liquid-glass-icons-in-apps-without-xcode)): e.g. `bundle.macOS.files` → map `Resources/Assets.car` to `src-tauri/resources/macos/Assets.car`, and merge `CFBundleIconName` with the same string you passed to `actool`.
4. **Keep** `icons/icon.icns` in `tauri.conf.json` so older macOS still has a normal icon.

`Assets.car` is gitignored until you choose to commit a prebuilt catalog for CI.

## Sandbox / network

The frontend CSP disallows remote origins. Tauri's IPC is the only non-self connection. Verify with `nettop -p Differ` — zero outbound traffic during normal use.
