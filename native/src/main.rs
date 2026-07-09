// Differ on GPUI — Phase 0 spike.
//
// Goal of this file: prove the toolchain end-to-end — Metal shaders compile,
// gpui + gpui-component link, a window opens and renders. It deliberately
// renders a plain gpui `div` (the most stable API surface) rather than the
// editor component; wiring gpui-component's editor + our diff view is Phase 2.
//
// Entry point follows gpui-component's documented pattern:
//   gpui_platform::application() -> run -> gpui_component::init(cx) -> open_window.

use gpui::{
    div, px, rgb, size, App, Bounds, Context, IntoElement, ParentElement, Render, Styled, Window,
    WindowBounds, WindowOptions,
};

/// Root view. Phase 2 replaces this body with the two-pane diff view backed by
/// `differ_core::diff_with_changes`.
struct DifferApp;

impl Render for DifferApp {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .size_full()
            .items_center()
            .justify_center()
            .bg(rgb(0x1e1e1e))
            .text_color(rgb(0xf0f0f0))
            .child("Differ — GPUI spike")
            .child(div().text_color(rgb(0x9aa0a6)).child("native diff engine linked ✓"))
    }
}

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
            |_window, cx| cx.new(|_cx| DifferApp),
        )
        .expect("failed to open window");
    });
}
