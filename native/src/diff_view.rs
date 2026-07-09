// The two-pane diff view — built on raw gpui so decorations, gutter, and scroll
// are first-class (gpui-component's editor has no decoration API). Syntax
// highlighting will be layered in via gpui-component's standalone
// `SyntaxHighlighter` in a later increment.
//
// Increment 1: render one side's text as line rows, tinting changed lines and
// their gutter numbers using differ-core's diff + decoration mapping. Proves we
// can render text + diff decorations ourselves before adding highlighting,
// two-pane layout, and synced scrolling.

use std::collections::HashSet;

use differ_core::{
    decorations::{build_decorations, Side},
    diff_with_changes,
};
use gpui::{div, prelude::*, px, rgb, rgba, Context, Window};

pub struct DiffView {
    b: String,
    /// Byte offsets of changed line starts on side B.
    changed_b: HashSet<u32>,
}

impl DiffView {
    pub fn new(a: &str, b: &str) -> Self {
        let chunks = diff_with_changes(a, b);
        let deco = build_decorations(Side::B, &chunks, b);
        Self {
            b: b.to_string(),
            changed_b: deco.changed_lines.into_iter().collect(),
        }
    }
}

impl Render for DiffView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let mut rows = Vec::new();
        // Running byte offset of the current line start — matches differ-core's
        // line_offsets (0, then after each '\n').
        let mut offset = 0u32;
        for (i, line) in self.b.split('\n').enumerate() {
            let changed = self.changed_b.contains(&offset);
            let mut row = div()
                .flex()
                .flex_row()
                .w_full()
                .child(
                    div()
                        .w(px(52.0))
                        .flex_none()
                        .text_color(if changed { rgb(0x3fb950) } else { rgb(0x6b7280) })
                        .child(format!("{:>4} ", i + 1)),
                )
                .child(div().flex_1().text_color(rgb(0xe6e6e6)).child(line.to_string()));
            if changed {
                // Subtle green line tint (added/changed on the "new" side).
                row = row.bg(rgba(0x3fb95022));
            }
            rows.push(row);
            offset += line.len() as u32 + 1;
        }

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0x1e1e1e))
            .p_2()
            .text_size(px(13.0))
            .children(rows)
    }
}
