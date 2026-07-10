// Differ on GPUI.
//
// Entry point follows gpui-component's documented pattern:
//   gpui_platform::application() -> run -> gpui_component::init(cx) -> open_window.
// The root view is our own two-pane diff view (see diff_view.rs), built on raw
// gpui with gpui-component reused as a library for syntax highlighting.

mod diff_view;
mod history_store;
#[cfg(test)]
mod perf_e2e;

use std::borrow::Cow;

use diff_view::{
    ClearBoth, DiffView, NextChange, OpenFile, PrevChange, SwapSides, ToggleHistory, ToggleSync,
};
use gpui::{
    point, px, size, App, AppContext, Bounds, KeyBinding, TitlebarOptions, WindowBounds,
    WindowOptions,
};

// Temporary sample content so the view has something to diff until file/paste
// input is wired up. Side B (shown) changes lines 2 and 5.
const SAMPLE_A: &str = "fn main() {\n    let x = 1;\n    let y = 2;\n    println!(\"{}\", x);\n    done();\n}\n";
const SAMPLE_B: &str = "fn main() {\n    let x = 10;\n    let y = 2;\n    println!(\"{}\", x);\n    finish();\n}\n";

fn main() {
    let app = gpui_platform::application();
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
        ]);
        cx.activate(true);

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
                gpui_component::Theme::global_mut(cx).mono_font_family = "JetBrains Mono".into();

                // gpui-component's editor requires the window's first layer to
                // be a gpui_component::Root (it hosts theme + overlay layers).
                let view = cx.new(|cx| DiffView::new(SAMPLE_A, SAMPLE_B, window, cx));
                let root_view: gpui::AnyView = view.into();
                cx.new(|cx| gpui_component::Root::new(root_view, window, cx))
            },
        )
        .expect("failed to open window");
    });
}
