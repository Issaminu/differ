// Two-pane diff view on our forked gpui-component editor.
//
// Diff tints are fed INTO each editor via `set_diff_highlights` (our fork's
// addition): the editor composes them with syntax highlighting and paints them
// itself, so they're pixel-perfect, char-capable, and track scrolling natively
// — no overlay, no scroll poll.
//
// The diff still runs off the main thread on each edit (clone ropes O(1) ->
// stringify + diff on a background thread -> apply on main), generation-guarded
// and lightly debounced, so typing never blocks on big documents.

use std::ops::Range;
use std::time::{Duration, Instant};

use crate::history_store;
use differ_core::{
    history::{History, HistoryEntry},
    pipeline::{compute, DiffCompute, Tint, TintKind},
};
use gpui::{
    canvas, div, fill, point, prelude::*, px, rgb, rgba, size, Bounds, Context, Div, Entity,
    HighlightStyle, Hsla, MouseButton, MouseDownEvent, PathPromptOptions, Pixels, Point,
    SharedString, Subscription, Window,
};
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::notification::Notification;
use gpui_component::{
    button::{Button, ButtonCustomVariant, ButtonVariants},
    combobox::{Combobox, ComboboxEvent, ComboboxState},
    highlighter::Language,
    list::{List, ListDelegate, ListItem, ListState},
    searchable_list::{SearchableListItem, SearchableVec},
    ActiveTheme, Icon, IconName, IndexPath, Sizable, WindowExt,
};

const ADDED: u32 = 0x3fb950;
const REMOVED: u32 = 0xf85149;
// Alpha for the two tint intensities (behind the glyphs): a faint wash over the
// whole changed line, a stronger one over the exact changed characters.
const LINE_ALPHA: u32 = 0x2c;
const CHAR_ALPHA: u32 = 0x66;

/// Coalesce keystroke bursts; the diff runs on a background thread so typing
/// never blocks — this just avoids redundant background work.
const RECOMPUTE_DEBOUNCE: Duration = Duration::from_millis(30);
/// History dedupe/capture is O(document); debounce it well past active typing.
const HISTORY_DEBOUNCE: Duration = Duration::from_millis(1000);
/// Match the titlebar and change-map coordinate systems from one source of truth.
const TOOLBAR_HEIGHT: f32 = 48.0;
const CHANGE_MAP_WIDTH: f32 = 10.0;

// Keyboard-dispatchable actions (bound in main.rs).
gpui::actions!(
    differ,
    [
        NextChange,
        PrevChange,
        SwapSides,
        ClearBoth,
        OpenFile,
        ToggleSync,
        ToggleHistory,
        IncreaseFontSize,
        DecreaseFontSize,
        ResetFontSize
    ]
);

/// Default editor font size in px, and the clamp bounds for zoom.
const DEFAULT_FONT_SIZE: f32 = 13.0;
const MIN_FONT_SIZE: f32 = 8.0;
const MAX_FONT_SIZE: f32 = 32.0;

// Test-only cycle order for the small regression harness. The actual picker
// below is populated from gpui-component's full compiled Language registry.
#[cfg(test)]
const LANG_CYCLE: &[Option<&str>] = &[
    None,
    Some("text"),
    Some("rust"),
    Some("javascript"),
    Some("typescript"),
    Some("python"),
    Some("go"),
    Some("json"),
    Some("html"),
    Some("markdown"),
    Some("css"),
    Some("cpp"),
];

/// `main`'s `VSCODE_WHITELIST`, intersected with the grammars that the native
/// binary actually compiles. The web build can lazy-load a larger set from
/// CodeMirror; surfacing those here would make a manual selection silently
/// degrade to plain text. Keep Auto as the way to return to plain text.
///
/// This deliberately excludes GPUI's implementation-facing grammars (Diff,
/// EJS, ERB, JSDoc, Markdown Inline, Make, Protobuf, ...) as well as languages
/// that are not in Differ's established main-branch picker.
const MAIN_PICKER_LANGUAGE_IDS: &[&str] = &[
    "bash",
    "c",
    "csharp",
    "cpp",
    "css",
    "elixir",
    "go",
    "html",
    "java",
    "javascript",
    "json",
    "kotlin",
    "lua",
    "markdown",
    "php",
    "python",
    "ruby",
    "rust",
    "scala",
    "sql",
    "svelte",
    "swift",
    "toml",
    "tsx",
    "typescript",
    "yaml",
];

/// Human-facing labels for the highlighter ids. Keeping the ids lowercase is
/// convenient for gpui-component; exposing them verbatim makes the otherwise
/// polished language control look like a debugging readout.
fn language_label(language: &str) -> &str {
    match language {
        "text" | "plaintext" => "Plain Text",
        "astro" => "Astro",
        // main presents this as Shell; the native highlighter uses Bash for
        // that grammar, so retain the user-facing name while selecting Bash.
        "bash" => "Shell",
        "c" => "C",
        "cmake" => "CMake",
        "javascript" => "JavaScript",
        "typescript" => "TypeScript",
        "cpp" => "C++",
        "csharp" => "C#",
        "diff" => "Diff",
        "ejs" => "EJS",
        "elixir" => "Elixir",
        "erb" => "ERB",
        "html" => "HTML",
        "graphql" => "GraphQL",
        "css" => "CSS",
        "json" => "JSON",
        "java" => "Java",
        "jsdoc" => "JSDoc",
        "kotlin" => "Kotlin",
        "lua" => "Lua",
        "make" => "Makefile",
        "yaml" => "YAML",
        "sql" => "SQL",
        "markdown" => "Markdown",
        "markdown_inline" => "Markdown Inline",
        "php" => "PHP",
        "proto" => "Protocol Buffers",
        "shell" => "Shell",
        "python" => "Python",
        "rust" => "Rust",
        "go" => "Go",
        "ruby" => "Ruby",
        "scala" => "Scala",
        "svelte" => "Svelte",
        "swift" => "Swift",
        "toml" => "TOML",
        "tsx" => "TSX",
        "zig" => "Zig",
        other => other,
    }
}

/// Brand logos used by Differ's original language menu, sourced from the
/// repository's existing Simple Icons dependency (CC0). Languages without a
/// recognised brand retain a neutral code mark rather than a random letter.
fn language_logo(language: Option<&str>) -> Icon {
    let (path, color) = match language {
        None => ("icons/languages/auto.svg", rgb(0x5b86ff)),
        Some("text" | "plaintext") => ("icons/languages/code.svg", rgb(0x9aa0aa)),
        Some("bash" | "shell") => ("icons/languages/bash.svg", rgb(0x89e051)),
        Some("c") => ("icons/languages/c.svg", rgb(0x555555)),
        Some("csharp") => ("icons/languages/csharp.svg", rgb(0x9b4f96)),
        Some("cpp") => ("icons/languages/cpp.svg", rgb(0x659ad2)),
        Some("css") => ("icons/languages/css.svg", rgb(0x264de4)),
        Some("elixir") => ("icons/languages/elixir.svg", rgb(0x6e4a7e)),
        Some("go") => ("icons/languages/go.svg", rgb(0x00add8)),
        Some("html") => ("icons/languages/html.svg", rgb(0xe34c26)),
        Some("javascript" | "jsdoc") => ("icons/languages/javascript.svg", rgb(0xe5c07b)),
        Some("json") => ("icons/languages/json.svg", rgb(0xe5c07b)),
        Some("kotlin") => ("icons/languages/kotlin.svg", rgb(0xa97bff)),
        Some("lua") => ("icons/languages/lua.svg", rgb(0x000080)),
        Some("markdown" | "markdown_inline") => ("icons/languages/markdown.svg", rgb(0x519aba)),
        Some("php") => ("icons/languages/php.svg", rgb(0x777bb4)),
        Some("python") => ("icons/languages/python.svg", rgb(0x3572a5)),
        Some("rust") => ("icons/languages/rust.svg", rgb(0xe07a3f)),
        Some("ruby") => ("icons/languages/ruby.svg", rgb(0xcc342d)),
        Some("scala") => ("icons/languages/scala.svg", rgb(0xdc322f)),
        Some("sql") => ("icons/languages/sql.svg", rgb(0x5b86ff)),
        Some("svelte") => ("icons/languages/svelte.svg", rgb(0xff3e00)),
        Some("swift") => ("icons/languages/swift.svg", rgb(0xf05138)),
        Some("toml") => ("icons/languages/toml.svg", rgb(0x9c4221)),
        Some("tsx") => ("icons/languages/tsx.svg", rgb(0x61dafb)),
        Some("typescript") => ("icons/languages/typescript.svg", rgb(0x3178c6)),
        Some("yaml") => ("icons/languages/yaml.svg", rgb(0xcb171e)),
        _ => ("icons/languages/code.svg", rgb(0x9aa0aa)),
    };
    Icon::empty().path(path).size(px(16.0)).text_color(color)
}

/// One language entry for gpui-component's searchable combobox. The component
/// owns filtering, keyboard navigation, scrolling, focus, and dismissal; this
/// type only supplies the language-specific label and compact brand logo.
#[derive(Clone)]
struct LanguageOption {
    id: &'static str,
    language: Option<&'static str>,
}

impl LanguageOption {
    fn all() -> Vec<Self> {
        let mut languages: Vec<_> = Language::all()
            .filter(|language| MAIN_PICKER_LANGUAGE_IDS.contains(&language.name()))
            .map(|language| Self {
                id: language.name(),
                language: Some(language.name()),
            })
            .collect();
        // Match main's human-facing locale sort rather than Rust's bytewise
        // ordering (which would put JSON before JavaScript and SQL before
        // Scala simply because the acronym is uppercase).
        languages.sort_unstable_by_key(|language| {
            language
                .language
                .map(language_label)
                .unwrap_or("Auto")
                .to_ascii_lowercase()
        });
        languages.insert(
            0,
            Self {
                id: "auto",
                language: None,
            },
        );
        languages
    }
}

impl SearchableListItem for LanguageOption {
    type Value = &'static str;

    fn title(&self) -> SharedString {
        self.language.map(language_label).unwrap_or("Auto").into()
    }

    fn render(&self, _: &mut Window, _: &mut gpui::App) -> impl IntoElement {
        div()
            .flex()
            .items_center()
            .gap_1()
            .child(
                div()
                    .w(px(24.0))
                    .h(px(20.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(language_logo(self.language)),
            )
            .child(self.title())
    }

    fn value(&self) -> &Self::Value {
        &self.id
    }

    fn matches(&self, query: &str) -> bool {
        let query = query.to_lowercase();
        self.id.to_lowercase().contains(&query) || self.title().to_lowercase().contains(&query)
    }
}

/// GPUI's virtual list owns selection, focus, keyboard navigation, scrolling,
/// and row virtualization. Differ owns only the compact history-row content
/// and the meaning of confirming a row.
struct HistoryListDelegate {
    entries: Vec<HistoryEntry>,
    selected: Option<IndexPath>,
    view: Entity<DiffView>,
}

impl HistoryListDelegate {
    fn new(view: Entity<DiffView>, entries: Vec<HistoryEntry>) -> Self {
        Self {
            entries,
            selected: None,
            view,
        }
    }

    fn set_entries(&mut self, entries: Vec<HistoryEntry>) {
        self.entries = entries;
        self.selected = None;
    }
}

impl ListDelegate for HistoryListDelegate {
    type Item = ListItem;

    fn items_count(&self, _: usize, _: &gpui::App) -> usize {
        self.entries.len()
    }

    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<Self::Item> {
        let entry = self.entries.get(ix.row)?;
        let preview = if entry.preview.trim().is_empty() {
            "(empty)"
        } else {
            entry.preview.as_str()
        };

        Some(
            ListItem::new(ix)
                // The virtual list measures one row and applies that height to
                // every entry, so keep the two-line history treatment fixed.
                .h(px(58.0))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .justify_center()
                        .gap_1()
                        .w_full()
                        .overflow_hidden()
                        .child(
                            div()
                                .w_full()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_color(cx.theme().foreground)
                                .child(preview.to_string()),
                        )
                        .child(
                            div()
                                .text_color(cx.theme().muted_foreground)
                                .text_size(px(11.0))
                                .child(entry.language.clone()),
                        ),
                ),
        )
    }

    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        div()
            .flex()
            .size_full()
            .items_center()
            .justify_center()
            .text_color(cx.theme().muted_foreground)
            .child("No history yet")
    }

    fn set_selected_index(
        &mut self,
        ix: Option<IndexPath>,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) {
        self.selected = ix;
    }

    fn confirm(&mut self, _: bool, window: &mut Window, cx: &mut Context<ListState<Self>>) {
        let Some(entry) = self
            .selected
            .and_then(|ix| self.entries.get(ix.row))
            .cloned()
        else {
            return;
        };
        self.view
            .update(cx, |view, cx| view.restore_history_entry(entry, window, cx));
    }
}

pub struct DiffView {
    editor_a: Entity<InputState>,
    editor_b: Entity<InputState>,
    /// gpui-component owns this searchable language picker.
    language_picker: Entity<ComboboxState<SearchableVec<LanguageOption>>>,
    /// Effective language (manual override if set, else detected).
    language: &'static str,
    /// Auto-detected language (used when there's no manual override).
    detected_language: &'static str,
    /// Manual language override (None = auto-detect).
    manual_language: Option<&'static str>,
    /// Editor font size in px (Cmd-+/Cmd--/Cmd-0 to zoom).
    font_size: f32,
    stats: (usize, usize),
    recompute_gen: u64,
    /// A single latest-only worker owns background diff work. New edits advance
    /// `recompute_gen`; they never create another full-document diff while one
    /// is already running.
    recompute_task_active: bool,
    /// Debounce guard for off-hot-path history capture (see schedule_history_capture).
    history_gen: u64,
    /// Frame-bench state (DIFFER_FRAMEBENCH): remaining frames + last frame time.
    frame_bench_left: usize,
    frame_bench_warmup_left: usize,
    frame_last: Option<Instant>,
    /// Line index of each change per side (aligned by index) + current cursor.
    changes_a: Vec<u32>,
    changes_b: Vec<u32>,
    current_change: usize,
    /// Total line counts per side (for the change-map ruler's y mapping).
    lines_a: usize,
    lines_b: usize,
    /// Which pane last had focus (true = A/left) — the target for "Open".
    focused_a: bool,
    /// Vertical scroll lock between the two panes + its poll bookkeeping.
    scroll_lock: bool,
    poll_active: bool,
    last_scroll_a: Point<Pixels>,
    last_scroll_b: Point<Pixels>,
    history: History,
    history_list: Entity<ListState<HistoryListDelegate>>,
    history_open: bool,
    _subs: Vec<Subscription>,
}

impl DiffView {
    pub fn new(a: &str, b: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mk = |text: &str, window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| {
                InputState::new(window, cx)
                    .code_editor("text")
                    .line_number(true)
                    .soft_wrap(false)
                    .default_value(text)
            })
        };
        let editor_a = mk(a, window, cx);
        let editor_b = mk(b, window, cx);
        let language_picker = cx.new(|cx| {
            ComboboxState::new(
                SearchableVec::new(LanguageOption::all()),
                vec![IndexPath::default()],
                window,
                cx,
            )
            .searchable(true)
        });
        let history = history_store::load();
        let history_entries = history.recent().cloned().collect();
        let view = cx.entity();
        let history_list = cx
            .new(|cx| ListState::new(HistoryListDelegate::new(view, history_entries), window, cx));

        let mut subs = vec![
            cx.subscribe(&editor_a, |this, _e, event: &InputEvent, cx| match event {
                InputEvent::Change => this.schedule_recompute(cx),
                InputEvent::Focus => this.focused_a = true,
                _ => {}
            }),
            cx.subscribe(&editor_b, |this, _e, event: &InputEvent, cx| match event {
                InputEvent::Change => this.schedule_recompute(cx),
                InputEvent::Focus => this.focused_a = false,
                _ => {}
            }),
            cx.subscribe(&language_picker, |this, _e, event, cx| {
                let values = match event {
                    ComboboxEvent::Change(values) | ComboboxEvent::Confirm(values) => values,
                };
                let value = values.first().copied().unwrap_or("auto");
                this.manual_language = (value != "auto").then_some(value);
                this.apply_language(cx);
                cx.notify();
            }),
        ];

        // Flush history to disk on app quit (belt-and-suspenders vs the
        // drawer-toggle save), so in-memory captures aren't lost on exit.
        subs.push(cx.on_app_quit(|this, _cx| {
            history_store::save(&this.history);
            async move {}
        }));

        let mut view = Self {
            editor_a,
            editor_b,
            language_picker,
            language: "text",
            detected_language: "text",
            manual_language: None,
            font_size: history_store::load_font_size()
                .map(|s| s.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE))
                .unwrap_or(DEFAULT_FONT_SIZE),
            stats: (0, 0),
            recompute_gen: 0,
            recompute_task_active: false,
            history_gen: 0,
            frame_bench_left: 0,
            frame_bench_warmup_left: 0,
            frame_last: None,
            changes_a: Vec::new(),
            changes_b: Vec::new(),
            current_change: 0,
            lines_a: 1,
            lines_b: 1,
            focused_a: false,
            scroll_lock: false,
            poll_active: false,
            last_scroll_a: Point::default(),
            last_scroll_b: Point::default(),
            history,
            history_list,
            history_open: false,
            _subs: subs,
        };
        view.recompute(cx);
        view.maybe_start_stress(window, cx);
        view.maybe_start_paste_stress(window, cx);
        view.maybe_start_search_stress(window, cx);
        view.maybe_start_frame_bench(window, cx);
        view
    }

    /// Headful paint benchmark: when `DIFFER_FRAMEBENCH=<n>` is set, warm the
    /// live window, then force `n` continuous re-renders and record the achieved
    /// frame period. This includes GPUI layout + paint, not just element-tree
    /// construction. `DIFFER_FRAMEBENCH_WARMUP` defaults to 30 frames.
    fn maybe_start_frame_bench(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(frames) = std::env::var("DIFFER_FRAMEBENCH")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
        else {
            return;
        };
        self.frame_bench_warmup_left = std::env::var("DIFFER_FRAMEBENCH_WARMUP")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(30);
        eprintln!(
            "[framebench] warming {} frames, then measuring {frames} frames",
            self.frame_bench_warmup_left
        );
        self.frame_bench_left = frames;
        self.frame_last = None;
        self.schedule_frame_tick(window, cx);
    }

    fn schedule_frame_tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.on_next_frame(window, |this, window, cx| {
            let now = Instant::now();
            if this.frame_bench_warmup_left > 0 {
                this.frame_bench_warmup_left -= 1;
                if this.frame_bench_warmup_left == 0 {
                    crate::perf::reset();
                    this.frame_last = None;
                    eprintln!("[framebench] measuring");
                }
                cx.notify();
                this.schedule_frame_tick(window, cx);
                return;
            }
            if let Some(last) = this.frame_last {
                crate::perf::record("frame_period", now.duration_since(last));
            }
            this.frame_last = Some(now);
            this.frame_bench_left = this.frame_bench_left.saturating_sub(1);
            if this.frame_bench_left == 0 {
                crate::perf::report();
                if std::env::var_os("DIFFER_BENCH_QUIT").is_some() {
                    cx.quit();
                } else {
                    eprintln!("[framebench] complete; window left open for inspection");
                }
                return;
            }
            cx.notify(); // mark dirty so the editors actually repaint next frame
            this.schedule_frame_tick(window, cx);
        });
    }

    /// Headful perf harness: when `DIFFER_STRESS=<n>` is set, auto-type `n`
    /// characters into pane A, then waits until the latest real diff settles.
    /// Runs inside the real render/paint loop, so numbers include editor events,
    /// debouncing, background diffing, application, and later rendered frames.
    /// The window remains open after the report unless `DIFFER_BENCH_QUIT=1`.
    fn maybe_start_stress(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(total) = std::env::var("DIFFER_STRESS")
            .ok()
            .map(|s| s.parse::<usize>().unwrap_or(2000))
        else {
            return;
        };
        // Cadence between keystrokes. Default 40ms is just over the 30ms
        // recompute debounce, so each keystroke actually applies (measures the
        // real per-edit cost); set lower to stress coalescing instead.
        let cadence = std::env::var("DIFFER_STRESS_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(40);
        eprintln!("[stress] starting: {total} keystrokes @ {cadence}ms");
        crate::perf::reset();
        let quit_when_done = std::env::var_os("DIFFER_BENCH_QUIT").is_some();
        cx.spawn_in(window, async move |this, cx| {
            for i in 0..total {
                cx.background_executor()
                    .timer(Duration::from_millis(cadence))
                    .await;
                let ch = if i % 40 == 39 { "\n" } else { "x" };
                if this
                    .update_in(cx, |this, window, cx| {
                        this.editor_a.update(cx, |ed, cx| ed.insert(ch, window, cx));
                    })
                    .is_err()
                {
                    eprintln!("[stress] aborted at {i} (view gone)");
                    return;
                }
                if i % 200 == 0 {
                    eprintln!("[stress] {i}/{total}");
                }
            }
            eprintln!("[stress] done typing, settling");
            // The bounded recompute worker may still be processing a huge
            // document. Wait for its actual completion instead of guessing a
            // fixed delay and reporting an incomplete benchmark.
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                let busy = this
                    .update(cx, |this, _cx| this.recompute_task_active)
                    .unwrap_or(false);
                if !busy {
                    break;
                }
            }
            let _ = this.update(cx, |_this, cx| {
                crate::perf::report();
                if quit_when_done {
                    cx.quit();
                } else {
                    eprintln!("[stress] complete; window left open for inspection");
                }
            });
        })
        .detach();
    }

    /// Headful large-paste benchmark. A single `InputState::insert` models the
    /// editor's clipboard path: one real change event containing thousands of
    /// lines, then the normal debounced background diff and GPU repaint.
    fn maybe_start_paste_stress(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(lines) = std::env::var("DIFFER_PASTE_STRESS_LINES")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
        else {
            return;
        };
        let quit_when_done = std::env::var_os("DIFFER_BENCH_QUIT").is_some();
        eprintln!("[paste-stress] starting: {lines} pasted lines");
        cx.spawn_in(window, async move |this, cx| {
            // Generate clipboard-sized input off the main thread. Timing starts
            // after this, so `paste_end_to_end` measures UI work, not fixture
            // construction.
            let payload = cx
                .background_executor()
                .spawn(async move {
                    let mut text = String::with_capacity(lines * 48);
                    for i in 0..lines {
                        text.push_str(&format!("fn pasted_{i}(x: i32) -> i32 {{ x + {i} }}\n"));
                    }
                    text
                })
                .await;
            cx.background_executor()
                .timer(Duration::from_millis(200))
                .await;

            let started = Instant::now();
            let result = this.update_in(cx, |this, window, cx| {
                crate::perf::reset();
                let editor = this.editor_a.clone();
                let expected_len = editor.read(cx).value().len() + payload.len();
                let command_started = Instant::now();
                editor.update(cx, |editor, cx| editor.insert(payload.as_str(), window, cx));
                crate::perf::record("paste_command", command_started.elapsed());
                expected_len
            });
            let Ok(expected_len) = result else {
                eprintln!("[paste-stress] aborted before paste dispatch (view gone)");
                return;
            };

            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                let settled = this
                    .update(cx, |this, cx| {
                        this.editor_a.read(cx).value().len() == expected_len
                            && !this.recompute_task_active
                    })
                    .unwrap_or(true);
                if settled {
                    break;
                }
                if started.elapsed() > Duration::from_secs(30) {
                    eprintln!("[paste-stress] timed out waiting for pasted diff to settle");
                    return;
                }
            }
            crate::perf::record("paste_end_to_end", started.elapsed());
            eprintln!("[paste-stress] PASS: lines={lines}");
            let _ = this.update(cx, |_this, cx| {
                crate::perf::report();
                if quit_when_done {
                    cx.quit();
                } else {
                    eprintln!("[paste-stress] complete; window left open for inspection");
                }
            });
        })
        .detach();
    }

    /// Headful Find / Find & Replace benchmark. `DIFFER_SEARCH_STRESS=find`
    /// opens the real SearchPanel and runs a large query; `replace` runs its
    /// normal replacement path and waits for the post-replace diff to settle.
    /// The harness deliberately calls the component's public controller rather
    /// than a second matcher, so the visible panel, Aho-Corasick matcher,
    /// replacement task, editor change event, and Differ recompute all run.
    fn maybe_start_search_stress(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(mode) = std::env::var("DIFFER_SEARCH_STRESS").ok() else {
            return;
        };
        let replace = match mode.as_str() {
            "find" => false,
            "replace" => true,
            other => {
                eprintln!("[search-stress] unsupported mode {other:?} (expected find or replace)");
                return;
            }
        };
        let query = std::env::var("DIFFER_SEARCH_QUERY").unwrap_or_else(|_| "item_".into());
        if query.is_empty() {
            eprintln!("[search-stress] query must not be empty");
            return;
        }
        let replacement =
            std::env::var("DIFFER_SEARCH_REPLACEMENT").unwrap_or_else(|_| "entry_".into());
        let quit_when_done = std::env::var_os("DIFFER_BENCH_QUIT").is_some();

        eprintln!(
            "[search-stress] starting mode={} query={query:?} replacement={replacement:?}",
            if replace { "replace" } else { "find" },
        );
        cx.spawn_in(window, async move |this, cx| {
            // Let the initial giant diff paint once. This keeps startup work
            // out of the command timing while keeping the actual window alive.
            cx.background_executor()
                .timer(Duration::from_millis(200))
                .await;
            let started = Instant::now();
            let result = this.update_in(cx, |this, window, cx| {
                crate::perf::reset();
                let command_started = Instant::now();
                let recompute_before = this.recompute_gen;
                let panel = this
                    .editor_a
                    .update(cx, |editor, cx| editor.open_search_panel(window, cx));
                let matches = panel.map_or(0, |panel| {
                    panel.update(cx, |panel, cx| {
                        panel.set_query(&query, window, cx);
                        if replace {
                            panel.set_replace_mode(true, cx);
                            panel.set_replacement(&replacement, window, cx);
                            let matches = panel.match_count();
                            panel.replace_all(window, cx);
                            matches
                        } else {
                            panel.match_count()
                        }
                    })
                });
                crate::perf::record(
                    if replace {
                        "replace_command"
                    } else {
                        "find_command"
                    },
                    command_started.elapsed(),
                );
                (matches, recompute_before)
            });
            let Ok((matches, recompute_before)) = result else {
                eprintln!("[search-stress] aborted before command dispatch (view gone)");
                return;
            };
            eprintln!("[search-stress] {matches} matches");
            let passed = if matches == 0 {
                eprintln!("[search-stress] FAIL: query did not match the generated document");
                false
            } else if replace {
                // SearchPanel replaces asynchronously. Do not report until
                // its editor change event advances Differ's generation and the
                // resulting real diff settles; a fixed sleep can report a
                // half-applied document.
                loop {
                    cx.background_executor()
                        .timer(Duration::from_millis(16))
                        .await;
                    let settled = this
                        .update(cx, |this, _cx| {
                            this.recompute_gen > recompute_before && !this.recompute_task_active
                        })
                        .unwrap_or(true);
                    if settled {
                        break;
                    }
                    if started.elapsed() > Duration::from_secs(30) {
                        eprintln!("[search-stress] timed out waiting for replacement to settle");
                        return;
                    }
                }
                crate::perf::record("replace_end_to_end", started.elapsed());
                true
            } else {
                crate::perf::record("find_end_to_end", started.elapsed());
                true
            };

            if passed {
                eprintln!(
                    "[search-stress] PASS: mode={} matches={matches}",
                    if replace { "replace" } else { "find" }
                );
            }

            let _ = this.update(cx, |_this, cx| {
                crate::perf::report();
                if quit_when_done {
                    cx.quit();
                } else {
                    eprintln!("[search-stress] complete; window left open for inspection");
                }
            });
        })
        .detach();
    }

    /// Recompute off the main thread with one latest-only worker.
    ///
    /// A generation check alone only prevents stale *application*: it still lets
    /// every slow full-document diff consume a background thread. Keeping one
    /// worker means a burst collapses to the newest snapshot even when the
    /// previous diff is slower than the debounce period.
    fn schedule_recompute(&mut self, cx: &mut Context<Self>) {
        self.recompute_gen = self.recompute_gen.wrapping_add(1);
        if self.recompute_task_active {
            return;
        }
        self.recompute_task_active = true;

        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(RECOMPUTE_DEBOUNCE).await;
            let Ok((generation, a_rope, b_rope)) = this.update(cx, |this, cx| {
                (
                    this.recompute_gen,
                    this.editor_a.read(cx).text().clone(),
                    this.editor_b.read(cx).text().clone(),
                )
            }) else {
                return;
            };

            let (a, b, comp) = cx
                .background_executor()
                .spawn(async move {
                    let _span = crate::perf::span("compute");
                    let a: String = a_rope.chunks().collect();
                    let b: String = b_rope.chunks().collect();
                    let comp = compute(&a, &b);
                    (a, b, comp)
                })
                .await;

            let keep_running = this
                .update(cx, |this, cx| {
                    if this.recompute_gen == generation {
                        this.apply_compute(comp, &a, &b, cx);
                        this.recompute_task_active = false;
                        false
                    } else {
                        true
                    }
                })
                .unwrap_or(false);
            if !keep_running {
                return;
            }
        })
        .detach();
    }

    /// Synchronous recompute for one-shot actions (swap/clear/restore/init).
    fn recompute(&mut self, cx: &mut Context<Self>) {
        // Invalidate a snapshot taken before a programmatic edit. InputState
        // normally emits Change too, but this makes the synchronous path robust
        // against that implementation detail.
        self.recompute_gen = self.recompute_gen.wrapping_add(1);
        let a = self.editor_a.read(cx).value().to_string();
        let b = self.editor_b.read(cx).value().to_string();
        let comp = compute(&a, &b);
        self.apply_compute(comp, &a, &b, cx);
    }

    /// Apply a computed diff: stats, language, in-editor tints, history.
    fn apply_compute(&mut self, comp: DiffCompute, a: &str, b: &str, cx: &mut Context<Self>) {
        let _s = crate::perf::span("apply_compute");
        self.stats = (comp.added, comp.removed);
        self.lines_a = a.split('\n').count();
        self.lines_b = b.split('\n').count();
        self.changes_a = comp.changes_a;
        self.changes_b = comp.changes_b;
        if self.current_change >= self.changes_b.len() {
            self.current_change = 0;
        }

        self.detected_language = comp.language;
        self.apply_language(cx);

        let (ha, hb) = {
            let _s = crate::perf::span("to_highlights");
            (
                to_highlights(&comp.tints_a, REMOVED),
                to_highlights(&comp.tints_b, ADDED),
            )
        };
        {
            let _s = crate::perf::span("set_diff_highlights");
            self.editor_a
                .update(cx, |ed, cx| ed.set_diff_highlights(ha, cx));
            self.editor_b
                .update(cx, |ed, cx| ed.set_diff_highlights(hb, cx));
        }

        self.schedule_history_capture(a, b, cx);
        cx.notify();
    }

    /// Capture into history off the hot path. Dedupe hashing is O(document) and
    /// was measured at ~2.5-5ms per apply on a 15k-line doc — far too costly to
    /// run on every recompute. Debounce it ~1s after the last edit (matching the
    /// original web app), so it runs once per typing pause instead.
    fn schedule_history_capture(&mut self, a: &str, b: &str, cx: &mut Context<Self>) {
        // Benchmarks are about the interactive diff path. History dedupe is an
        // intentionally separate persistence workload and would distort the
        // end-to-end measurements after the idle timeout.
        if std::env::var_os("DIFFER_BENCH").is_some() {
            return;
        }
        self.history_gen = self.history_gen.wrapping_add(1);
        let generation = self.history_gen;
        let a = a.to_string();
        let b = b.to_string();
        let lang = self.language;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(HISTORY_DEBOUNCE).await;
            let _ = this.update(cx, |this, cx| {
                if this.history_gen != generation {
                    return; // superseded by a newer edit
                }
                let _s = crate::perf::span("history_capture");
                this.history.capture(&a, &b, lang, history_store::now_ms());
                this.sync_history_list(cx);
            });
        })
        .detach();
    }

    /// Set the editors' syntax to the effective language (manual override, else
    /// detected).
    fn apply_language(&mut self, cx: &mut Context<Self>) {
        let lang = self.manual_language.unwrap_or(self.detected_language);
        if lang != self.language {
            self.language = lang;
            self.editor_a
                .update(cx, |ed, cx| ed.set_highlighter(lang, cx));
            self.editor_b
                .update(cx, |ed, cx| ed.set_highlighter(lang, cx));
        }
    }

    /// Cycle the manual language override (Auto -> Plain Text -> Rust -> ...).
    ///
    /// This remains available to the test harness; the visible control is a
    /// picker, so selecting a language is deliberate rather than a roulette
    /// wheel through a dozen syntaxes.
    #[cfg(test)]
    fn cycle_language(&mut self, cx: &mut Context<Self>) {
        let cur = LANG_CYCLE
            .iter()
            .position(|&x| x == self.manual_language)
            .unwrap_or(0);
        self.manual_language = LANG_CYCLE[(cur + 1) % LANG_CYCLE.len()];
        self.apply_language(cx);
        cx.notify();
    }

    /// Zoom the editor font by `delta` px, clamped; `None` resets to default.
    fn adjust_font(&mut self, delta: Option<f32>, cx: &mut Context<Self>) {
        self.font_size = match delta {
            Some(d) => (self.font_size + d).clamp(MIN_FONT_SIZE, MAX_FONT_SIZE),
            None => DEFAULT_FONT_SIZE,
        };
        history_store::save_font_size(self.font_size);
        cx.notify();
    }

    /// Scroll `editor` so `line` sits a few rows below the top.
    fn scroll_editor_to_line(editor: &Entity<InputState>, line: u32, cx: &mut Context<Self>) {
        let lh = editor.read(cx).line_height().unwrap_or(px(18.0));
        let target = line.saturating_sub(3) as f32;
        editor.update(cx, |ed, cx| {
            ed.set_scroll_offset(point(px(0.0), -(lh * target)), cx)
        });
    }

    /// Jump to the next (delta=+1) or previous (delta=-1) change, scrolling both
    /// panes to that change (aligned by change index).
    fn goto_change(&mut self, delta: i32, cx: &mut Context<Self>) {
        let n = self.changes_b.len().min(self.changes_a.len());
        if n == 0 {
            return;
        }
        self.current_change = (self.current_change as i32 + delta).rem_euclid(n as i32) as usize;
        let i = self.current_change;
        let (la, lb) = (self.changes_a[i], self.changes_b[i]);
        Self::scroll_editor_to_line(&self.editor_a, la, cx);
        Self::scroll_editor_to_line(&self.editor_b, lb, cx);
        cx.notify();
    }

    /// Swap the two panes' contents.
    fn do_swap(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let a = self.editor_a.read(cx).value();
        let b = self.editor_b.read(cx).value();
        self.editor_a
            .update(cx, |ed, cx| ed.set_value(b, window, cx));
        self.editor_b
            .update(cx, |ed, cx| ed.set_value(a, window, cx));
        self.recompute(cx);
        cx.notify();
    }

    /// Clear both panes.
    fn do_clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.editor_a
            .update(cx, |ed, cx| ed.set_value("", window, cx));
        self.editor_b
            .update(cx, |ed, cx| ed.set_value("", window, cx));
        self.recompute(cx);
        cx.notify();
    }

    fn sync_history_list(&mut self, cx: &mut Context<Self>) {
        let entries = self.history.recent().cloned().collect();
        self.history_list.update(cx, |list, cx| {
            list.delegate_mut().set_entries(entries);
            cx.notify();
        });
    }

    fn restore_history_entry(
        &mut self,
        entry: HistoryEntry,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.editor_a
            .update(cx, |ed, cx| ed.set_value(entry.original, window, cx));
        self.editor_b
            .update(cx, |ed, cx| ed.set_value(entry.modified, window, cx));
        self.history_open = false;
        self.recompute(cx);
        cx.notify();
    }

    /// Toggle the history drawer (persists on toggle). GPUI's list receives
    /// focus when it appears, enabling immediate up/down/enter navigation.
    fn toggle_history(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.history_open = !self.history_open;
        if self.history_open {
            self.history_list
                .update(cx, |list, cx| list.focus(window, cx));
        }
        history_store::save(&self.history);
        cx.notify();
    }

    /// Open a file into the focused pane via the native picker (async).
    fn do_open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let side_a = self.focused_a;
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = rx.await else {
                return; // dialog cancelled / dismissed
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            // `spawn_in` is foreground-polled by GPUI. Keep the picker and
            // editor mutation there, but push potentially multi-megabyte file
            // I/O to the background executor so opening a diff never freezes
            // the interactive window.
            let read_path = path.clone();
            let contents = cx
                .background_executor()
                .spawn(async move { std::fs::read_to_string(read_path) })
                .await;
            match contents {
                Ok(content) => {
                    let _ = this.update_in(cx, |this, window, cx| {
                        let ed = if side_a {
                            this.editor_a.clone()
                        } else {
                            this.editor_b.clone()
                        };
                        ed.update(cx, |ed, cx| ed.set_value(content, window, cx));
                        this.recompute(cx);
                        cx.notify();
                    });
                }
                Err(e) => {
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
                    let _ = this.update_in(cx, |_this, window, cx| {
                        window.push_notification(
                            Notification::error(format!("Couldn't open {name}: {e}")),
                            cx,
                        );
                    });
                }
            }
        })
        .detach();
    }

    /// Toggle vertical scroll lock; starts the sync poll if turning on.
    fn toggle_scroll_lock(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.scroll_lock = !self.scroll_lock;
        if self.scroll_lock && !self.poll_active {
            self.poll_active = true;
            self.last_scroll_a = self.editor_a.read(cx).scroll_offset();
            self.last_scroll_b = self.editor_b.read(cx).scroll_offset();
            cx.on_next_frame(window, Self::sync_scroll_tick);
        }
        cx.notify();
    }

    /// While locked, mirror whichever pane scrolled vertically onto the other.
    /// Runs only while `scroll_lock` (stops rescheduling otherwise).
    fn sync_scroll_tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.scroll_lock {
            self.poll_active = false;
            return;
        }
        let sa = self.editor_a.read(cx).scroll_offset();
        let sb = self.editor_b.read(cx).scroll_offset();
        if sa.y != self.last_scroll_a.y {
            let bx = sb.x;
            self.editor_b
                .update(cx, |ed, cx| ed.set_scroll_offset(point(bx, sa.y), cx));
        } else if sb.y != self.last_scroll_b.y {
            let ax = sa.x;
            self.editor_a
                .update(cx, |ed, cx| ed.set_scroll_offset(point(ax, sb.y), cx));
        }
        self.last_scroll_a = self.editor_a.read(cx).scroll_offset();
        self.last_scroll_b = self.editor_b.read(cx).scroll_offset();
        cx.on_next_frame(window, Self::sync_scroll_tick);
    }

    /// The center separator, doubling as a document change-map: red ticks (left
    /// = removed on A) and green ticks (right = added on B) at each change's
    /// relative position. Click a spot to jump both panes to the nearest change.
    fn render_change_map(&self, cx: &mut Context<Self>) -> Div {
        let border = cx.theme().border;
        let ca = self.changes_a.clone();
        let cb = self.changes_b.clone();
        let la = self.lines_a.max(1) as f32;
        let lb = self.lines_b.max(1) as f32;

        let ticks = canvas(
            |_b, _w, _c| (),
            move |bounds, _, window, _cx| {
                let h = bounds.size.height;
                let half = bounds.size.width / 2.0;
                let th = px(2.0);
                for &line in &ca {
                    let y = bounds.origin.y + h * (line as f32 / la);
                    window.paint_quad(fill(
                        Bounds {
                            origin: point(bounds.origin.x, y),
                            size: size(half, th),
                        },
                        rgb(REMOVED),
                    ));
                }
                for &line in &cb {
                    let y = bounds.origin.y + h * (line as f32 / lb);
                    window.paint_quad(fill(
                        Bounds {
                            origin: point(bounds.origin.x + half, y),
                            size: size(half, th),
                        },
                        rgb(ADDED),
                    ));
                }
            },
        )
        .absolute()
        .size_full();

        div()
            .relative()
            .flex_none()
            .w(px(CHANGE_MAP_WIDTH))
            .h_full()
            .bg(border)
            .cursor_pointer()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                    if this.changes_b.is_empty() {
                        return;
                    }
                    // Nearest change to the click, mapped onto the B side's height.
                    let top = px(TOOLBAR_HEIGHT); // below the toolbar
                    let h = window.viewport_size().height - top;
                    let click = ev.position.y;
                    let lb = this.lines_b.max(1) as f32;
                    let mut best = 0usize;
                    let mut best_d = px(f32::MAX);
                    for (i, &line) in this.changes_b.iter().enumerate() {
                        let y = top + h * (line as f32 / lb);
                        let d = if y > click { y - click } else { click - y };
                        if d < best_d {
                            best_d = d;
                            best = i;
                        }
                    }
                    this.current_change = best;
                    if let Some(l) = this.changes_a.get(best).copied() {
                        Self::scroll_editor_to_line(&this.editor_a, l, cx);
                    }
                    if let Some(l) = this.changes_b.get(best).copied() {
                        Self::scroll_editor_to_line(&this.editor_b, l, cx);
                    }
                    cx.notify();
                }),
            )
            .child(ticks)
    }

    /// Component-owned utility button. The custom variant deliberately keeps
    /// Differ's quiet, framed titlebar treatment while Button supplies proper
    /// focus, button role, click suppression, and tooltips.
    fn icon_btn(id: &'static str, icon: IconName, color: Hsla, cx: &mut gpui::App) -> Button {
        Button::new(id)
            // `Button::with_size(px(..))` also uses that value to scale an
            // icon-only button's glyph. Keep the hit target at 30px but use
            // the component's small semantic size for a calm 16px icon.
            .small()
            .w(px(30.0))
            .h(px(30.0))
            .rounded(px(6.0))
            .outline()
            .custom(
                ButtonCustomVariant::new(cx)
                    .color(rgba(0xffffff08).into())
                    .foreground(color)
                    .hover(rgba(0xffffff1c).into())
                    .active(rgba(0xffffff26).into()),
            )
            .icon(Icon::new(icon).text_color(color))
    }

    /// Previous / next change is navigation, not a toolbar action. The
    /// component button remains completely transparent: no border, no fill,
    /// including hover and active states.
    fn change_nav_btn(id: &'static str, icon: IconName, color: Hsla, cx: &mut gpui::App) -> Button {
        let transparent = cx.theme().transparent;
        Button::new(id)
            // As above, decouple the 24px click target from the glyph scale.
            .small()
            .w(px(24.0))
            .h(px(24.0))
            .rounded(px(4.0))
            .custom(
                ButtonCustomVariant::new(cx)
                    .color(transparent)
                    .foreground(color)
                    .hover(transparent)
                    .active(transparent),
            )
            .icon(Icon::new(icon).text_color(color))
    }

    fn render_drawer(&self, cx: &mut Context<Self>) -> Div {
        let (sidebar, border, fg) = {
            let t = cx.theme();
            (t.sidebar, t.border, t.foreground)
        };

        div()
            .flex()
            .flex_col()
            .flex_none()
            .w(px(300.0))
            .h_full()
            .border_l_1()
            .border_color(border)
            .bg(sidebar)
            .child(
                div()
                    .px_3()
                    .py_2()
                    .text_color(fg)
                    .text_size(px(13.0))
                    .child("History"),
            )
            .child(List::new(&self.history_list).flex_1().size_full())
    }

    // --- Test-only accessors (used by src/perf_e2e.rs) ---

    #[cfg(test)]
    pub(crate) fn editor_a(&self) -> Entity<InputState> {
        self.editor_a.clone()
    }

    #[cfg(test)]
    pub(crate) fn editor_b(&self) -> Entity<InputState> {
        self.editor_b.clone()
    }

    /// (added, removed) line counts from the last applied diff.
    #[cfg(test)]
    pub(crate) fn stats(&self) -> (usize, usize) {
        self.stats
    }

    /// Number of change anchors on each side from the last applied diff.
    #[cfg(test)]
    pub(crate) fn change_counts(&self) -> (usize, usize) {
        (self.changes_a.len(), self.changes_b.len())
    }

    /// Effective (manual-or-detected) language of the last applied diff.
    #[cfg(test)]
    pub(crate) fn language(&self) -> &'static str {
        self.language
    }

    /// Current manual language override (None = auto-detect).
    #[cfg(test)]
    pub(crate) fn manual_language(&self) -> Option<&'static str> {
        self.manual_language
    }

    #[cfg(test)]
    pub(crate) fn swap_for_test(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.do_swap(window, cx);
    }

    #[cfg(test)]
    pub(crate) fn clear_for_test(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.do_clear(window, cx);
    }

    #[cfg(test)]
    pub(crate) fn cycle_language_for_test(&mut self, cx: &mut Context<Self>) {
        self.cycle_language(cx);
    }
}

/// Map tint spans to editor highlight styles. `base` is a 0xRRGGBB colour;
/// Line spans get a faint wash, Char spans a stronger one.
fn to_highlights(tints: &[Tint], base: u32) -> Vec<(Range<usize>, HighlightStyle)> {
    tints
        .iter()
        .filter_map(|(r, kind)| {
            if r.start >= r.end {
                return None;
            }
            let alpha = match kind {
                TintKind::Line => LINE_ALPHA,
                TintKind::Char => CHAR_ALPHA,
            };
            let color: Hsla = rgba((base << 8) | alpha).into();
            Some((
                r.clone(),
                HighlightStyle {
                    background_color: Some(color),
                    ..Default::default()
                },
            ))
        })
        .collect()
}

impl Render for DiffView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let _s = crate::perf::span("render_build");
        let (added, removed) = self.stats;
        let language = self.language;
        let (bg, bar, border, fg, muted, accent, mono) = {
            let t = cx.theme();
            (
                t.background,
                t.title_bar,
                t.border,
                t.foreground,
                t.muted_foreground,
                t.accent,
                t.mono_font_family.clone(),
            )
        };

        // Language chip: "Auto · <lang>" when detecting, else the manual choice.
        let lang_label = if self.manual_language.is_none() {
            format!("Auto · {}", language_label(language))
        } else {
            language_label(language).to_string()
        };
        let picker_label = lang_label.clone();
        let lang_picker = div()
            .id("btn-lang")
            .flex_none()
            .w(px(180.0))
            .h(px(28.0))
            .child(
                Combobox::new(&self.language_picker)
                    .appearance(false)
                    .menu_width(px(236.0))
                    .menu_max_h(px(360.0))
                    .search_placeholder("Search languages…")
                    .render_trigger(move |_ctx, _window, _cx| {
                        div()
                            .flex()
                            .items_center()
                            .size_full()
                            .px(px(10.0))
                            .rounded_md()
                            .cursor_pointer()
                            .border_1()
                            .border_color(rgba(0xffffff12))
                            .text_color(muted)
                            .text_size(px(12.0))
                            .hover(|s| s.border_color(rgba(0xffffff28)).text_color(fg))
                            .child(picker_label.clone())
                            .child(Icon::new(IconName::ChevronDown).size(px(13.0)).ml_1())
                    }),
            );

        // Centered change stepper: ˄ prev · +N −M · ˅ next.
        let change_cluster = div()
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .flex_none()
            .child(
                Self::change_nav_btn("btn-prev", IconName::ChevronUp, muted, cx)
                    .on_click(cx.listener(|this, _, _w, cx| this.goto_change(-1, cx))),
            )
            .child(
                div()
                    .px_1()
                    .text_size(px(12.0))
                    .text_color(rgb(ADDED))
                    .child(format!("+{added}")),
            )
            .child(
                div()
                    .text_size(px(12.0))
                    .text_color(rgb(REMOVED))
                    .child(format!("−{removed}")),
            )
            .child(
                Self::change_nav_btn("btn-next", IconName::ChevronDown, muted, cx)
                    .on_click(cx.listener(|this, _, _w, cx| this.goto_change(1, cx))),
            );

        // Right-aligned utilities.
        let sync_icon = if self.scroll_lock {
            IconName::Lock
        } else {
            IconName::LockOpen
        };
        // Lock state is communicated by the filled lock body, not a surprise
        // colour jump. That keeps the titlebar calm and the affordance legible.
        let sync_color = muted;
        let utilities = div()
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .flex_none()
            .child(
                Self::icon_btn("btn-swap", IconName::ArrowLeftRight, muted, cx)
                    .on_click(cx.listener(|this, _, window, cx| this.do_swap(window, cx))),
            )
            .child(
                Self::icon_btn("btn-lock", sync_icon, sync_color, cx).on_click(
                    cx.listener(|this, _, window, cx| this.toggle_scroll_lock(window, cx)),
                ),
            )
            .child(
                Self::icon_btn(
                    "btn-history",
                    IconName::History,
                    if self.history_open { accent } else { muted },
                    cx,
                )
                .on_click(cx.listener(|this, _, window, cx| this.toggle_history(window, cx))),
            );

        // Absolute titlebar slots are intentional: flex's visual centre shifts
        // when one side has more controls. The change navigator should remain
        // centred against the *window*, not against the remaining free space.
        let change_slot_width = px(112.0);
        let toolbar = div()
            .relative()
            .flex_none()
            .h(px(TOOLBAR_HEIGHT))
            .bg(bar)
            .border_b_1()
            .border_color(border)
            .child(
                div()
                    .absolute()
                    .flex()
                    .items_center()
                    .h_full()
                    .left(px(88.0)) // clear macOS traffic lights
                    .child(lang_picker),
            )
            .child(
                div()
                    .absolute()
                    .flex()
                    .items_center()
                    .justify_center()
                    .h_full()
                    .w(change_slot_width)
                    .left_1_2()
                    // `left: 50%` anchors the slot's left edge. Offset it by
                    // half its known width to centre the *whole* navigator.
                    .ml(-change_slot_width / 2.0)
                    .child(change_cluster),
            )
            .child(
                div()
                    .absolute()
                    .flex()
                    .items_center()
                    .justify_end()
                    .h_full()
                    .right(px(12.0))
                    .child(utilities),
            );

        let font_size = px(self.font_size);
        let editors = div()
            .flex()
            .flex_row()
            .flex_1()
            .child(
                Input::new(&self.editor_a)
                    .bordered(false)
                    .flex_1()
                    .h_full()
                    .text_size(font_size)
                    .font_family(mono.clone()),
            )
            .child(self.render_change_map(cx))
            .child(
                Input::new(&self.editor_b)
                    .bordered(false)
                    .flex_1()
                    .h_full()
                    .text_size(font_size)
                    .font_family(mono),
            );

        let body = div()
            .flex()
            .flex_col()
            .flex_1()
            .child(toolbar)
            .child(editors);
        let mut root = div()
            .key_context("Differ")
            .on_action(cx.listener(|this, _: &NextChange, _w, cx| this.goto_change(1, cx)))
            .on_action(cx.listener(|this, _: &PrevChange, _w, cx| this.goto_change(-1, cx)))
            .on_action(cx.listener(|this, _: &SwapSides, window, cx| this.do_swap(window, cx)))
            .on_action(cx.listener(|this, _: &ClearBoth, window, cx| this.do_clear(window, cx)))
            .on_action(cx.listener(|this, _: &OpenFile, window, cx| this.do_open(window, cx)))
            .on_action(
                cx.listener(|this, _: &ToggleSync, window, cx| this.toggle_scroll_lock(window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &ToggleHistory, window, cx| this.toggle_history(window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &IncreaseFontSize, _w, cx| this.adjust_font(Some(1.0), cx)),
            )
            .on_action(
                cx.listener(|this, _: &DecreaseFontSize, _w, cx| this.adjust_font(Some(-1.0), cx)),
            )
            .on_action(cx.listener(|this, _: &ResetFontSize, _w, cx| this.adjust_font(None, cx)))
            .flex()
            .flex_row()
            .relative()
            .size_full()
            .bg(bg)
            .child(body);
        if self.history_open {
            root = root.child(self.render_drawer(cx));
        }
        root
    }
}

#[cfg(test)]
mod language_picker_tests {
    use super::*;

    #[test]
    fn picker_tracks_main_whitelist_for_compiled_native_grammars() {
        let ids: Vec<_> = LanguageOption::all()
            .into_iter()
            .map(|language| language.id)
            .collect();

        assert_eq!(
            ids,
            vec![
                "auto",
                "c",
                "csharp",
                "cpp",
                "css",
                "elixir",
                "go",
                "html",
                "java",
                "javascript",
                "json",
                "kotlin",
                "lua",
                "markdown",
                "php",
                "python",
                "ruby",
                "rust",
                "scala",
                "bash",
                "sql",
                "svelte",
                "swift",
                "toml",
                "tsx",
                "typescript",
                "yaml",
            ]
        );
        assert_eq!(language_label("bash"), "Shell");
        assert!(!ids.contains(&"astro"));
        assert!(!ids.contains(&"diff"));
        assert!(!ids.contains(&"markdown_inline"));
        assert!(!ids.contains(&"text"));
    }
}
