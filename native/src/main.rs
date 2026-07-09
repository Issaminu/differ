// Differ on GPUI.
//
// Entry point follows gpui-component's documented pattern:
//   gpui_platform::application() -> run -> gpui_component::init(cx) -> open_window.
// The root view is our own two-pane diff view (see diff_view.rs), built on raw
// gpui with gpui-component reused as a library for syntax highlighting.

mod diff_view;
mod history_store;

use diff_view::DiffView;
use gpui::{
    px, size, App, AppContext, Bounds, WindowBounds, WindowOptions,
};

// Temporary sample content so the view has something to diff until file/paste
// input is wired up. Side B (shown) changes lines 2 and 5.
const SAMPLE_A: &str = "fn main() {\n    let x = 1;\n    let y = 2;\n    println!(\"{}\", x);\n    done();\n}\n";
const SAMPLE_B: &str = "fn main() {\n    let x = 10;\n    let y = 2;\n    println!(\"{}\", x);\n    finish();\n}\n";

fn main() {
    let app = gpui_platform::application();
    app.run(|cx: &mut App| {
        gpui_component::init(cx);
        cx.activate(true);

        let bounds = Bounds::centered(None, size(px(900.0), px(600.0)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
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
