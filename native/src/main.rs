// Differ on GPUI.
//
// Entry point follows gpui-component's documented pattern:
//   gpui_platform::application() -> run -> gpui_component::init(cx) -> open_window.
// The root view is our own two-pane diff view (see diff_view.rs), built on raw
// gpui with gpui-component reused as a library for syntax highlighting.

mod diff_view;
mod history_store;
mod perf;
#[cfg(test)]
mod perf_e2e;

use std::borrow::Cow;

use diff_view::{
    ClearBoth, DecreaseFontSize, DiffView, IncreaseFontSize, NextChange, OpenFile, PrevChange,
    ResetFontSize, SwapSides, ToggleHistory, ToggleSync,
};
use gpui::{
    point, px, rgb, size, App, AppContext, Bounds, KeyBinding, TitlebarOptions, WindowBounds,
    WindowOptions,
};

// Temporary sample content so the view has something to diff until file/paste
// input is wired up. Side B (shown) changes lines 2 and 5.
const SAMPLE_A: &str = "fn main() {\n    let x = 1;\n    let y = 2;\n    println!(\"{}\", x);\n    done();\n}\n";
const SAMPLE_B: &str = "fn main() {\n    let x = 10;\n    let y = 2;\n    println!(\"{}\", x);\n    finish();\n}\n";

/// When `DIFFER_BENCH_LINES=<n>` is set, generate an n-line document pair for
/// the perf harness; otherwise `None`. `DIFFER_BENCH_CHANGED=<pct>` (default 30)
/// controls what fraction of lines differ, so the harness can stress a big,
/// tint-heavy diff (many highlighted lines in the viewport), not just a couple.
fn bench_docs() -> Option<(String, String)> {
    let n: usize = std::env::var("DIFFER_BENCH_LINES").ok()?.parse().ok()?;
    let pct: usize = std::env::var("DIFFER_BENCH_CHANGED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30)
        .min(100);
    let step = if pct == 0 { usize::MAX } else { (100 / pct).max(1) };
    let mut a = String::with_capacity(n * 40);
    let mut b = String::with_capacity(n * 40);
    for i in 0..n {
        a.push_str(&format!("fn item_{i}(x: i32) -> i32 {{ x + {i} }}\n"));
        if i % step == 0 {
            b.push_str(&format!("fn item_{i}(y: i64) -> i64 {{ y * {i} }}\n"));
        } else {
            b.push_str(&format!("fn item_{i}(x: i32) -> i32 {{ x + {i} }}\n"));
        }
    }
    Some((a, b))
}

fn main() {
    // `with_assets` lets gpui-component's `Icon`/`IconName` resolve its bundled
    // SVG icons (embedded via rust-embed) — needed for the toolbar icons.
    let app = gpui_platform::application().with_assets(gpui_component_assets::Assets);
    app.run(|cx: &mut App| {
        gpui_component::init(cx);
        // Bundle plain JetBrains Mono so it resolves by name regardless of what
        // the user has installed (they may only have the Nerd Font variant).
        let _ = cx.text_system().add_fonts(vec![
            Cow::Borrowed(&include_bytes!("../assets/fonts/JetBrainsMono-Regular.ttf")[..]),
            Cow::Borrowed(&include_bytes!("../assets/fonts/JetBrainsMono-Bold.ttf")[..]),
            Cow::Borrowed(&include_bytes!("../assets/fonts/JetBrainsMono-Italic.ttf")[..]),
            Cow::Borrowed(&include_bytes!("../assets/fonts/JetBrainsMono-BoldItalic.ttf")[..]),
        ]);

        // Keyboard shortcuts (global). F8 / Shift-F8 to walk changes; Cmd-O to
        // open; Cmd-Shift-{X,K,L,Y} for swap / clear / sync-lock / history.
        cx.bind_keys([
            KeyBinding::new("f8", NextChange, None),
            KeyBinding::new("shift-f8", PrevChange, None),
            KeyBinding::new("cmd-o", OpenFile, None),
            KeyBinding::new("cmd-shift-x", SwapSides, None),
            KeyBinding::new("cmd-shift-k", ClearBoth, None),
            KeyBinding::new("cmd-shift-l", ToggleSync, None),
            KeyBinding::new("cmd-shift-y", ToggleHistory, None),
            KeyBinding::new("cmd-=", IncreaseFontSize, None),
            KeyBinding::new("cmd-+", IncreaseFontSize, None),
            KeyBinding::new("cmd--", DecreaseFontSize, None),
            KeyBinding::new("cmd-0", ResetFontSize, None),
        ]);
        cx.activate(true);

        // Bench harness: DIFFER_BENCH_LINES=<n> preloads an n-line document pair
        // instead of the tiny sample (paired with DIFFER_STRESS for auto-typing).
        let (doc_a, doc_b) =
            bench_docs().unwrap_or_else(|| (SAMPLE_A.to_string(), SAMPLE_B.to_string()));

        let bounds = Bounds::centered(None, size(px(900.0), px(600.0)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                // Overlay titlebar (hidden system title, custom-drawn content
                // under it) with mac traffic lights inset — matches the original
                // Differ's window style.
                titlebar: Some(TitlebarOptions {
                    title: Some("Differ".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(20.0), px(24.0))),
                }),
                ..Default::default()
            },
            |window, cx| {
                // Dark theme + JetBrains Mono for the editors (falls back to the
                // system mono if JetBrains Mono isn't installed).
                gpui_component::Theme::change(gpui_component::ThemeMode::Dark, Some(window), cx);

                // Align the chrome to the palette the original Differ shipped
                // with (a faintly-cool near-black + its signature blue accent),
                // instead of gpui-component's stock neutral dark. The diff tint
                // greens/reds live in diff_view.rs and already match.
                let theme = gpui_component::Theme::global_mut(cx);
                theme.mono_font_family = "JetBrains Mono".into();
                theme.background = rgb(0x0f1115).into();
                theme.title_bar = rgb(0x15171c).into();
                theme.foreground = rgb(0xe6e6e8).into();
                theme.accent = rgb(0x5b86ff).into();

                // gpui-component's editor requires the window's first layer to
                // be a gpui_component::Root (it hosts theme + overlay layers).
                let view = cx.new(|cx| DiffView::new(&doc_a, &doc_b, window, cx));
                let root_view: gpui::AnyView = view.into();
                cx.new(|cx| gpui_component::Root::new(root_view, window, cx))
            },
        )
        .expect("failed to open window");
    });
}
