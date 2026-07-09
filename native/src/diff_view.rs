// The two-pane diff view — built on raw gpui so decorations, gutter, and scroll
// are first-class. Syntax highlighting is reused from gpui-component's
// standalone `SyntaxHighlighter` (text -> styled spans), NOT its editor.
//
// Increment 2: layer tree-sitter syntax colors under our diff decorations.
// We render per line so the gutter and changed-line background stay aligned;
// each line's text is a gpui `StyledText` carrying the syntax spans that fall
// on that line, and the row div carries the diff tint.

use std::collections::HashSet;
use std::ops::Range;

use differ_core::{
    decorations::{build_decorations, Side},
    diff_with_changes,
};
use gpui::{div, prelude::*, px, rgb, rgba, Context, HighlightStyle, StyledText, Window};
use gpui_component::highlighter::{HighlightTheme, SyntaxHighlighter};
use gpui_component::input::Rope;

pub struct DiffView {
    b: String,
    /// Byte offsets of changed line starts on side B.
    changed_b: HashSet<u32>,
    /// Tree-sitter syntax spans over the whole of side B (document byte ranges).
    spans: Vec<(Range<usize>, HighlightStyle)>,
}

impl DiffView {
    pub fn new(a: &str, b: &str, language: &str) -> Self {
        let chunks = diff_with_changes(a, b);
        let deco = build_decorations(Side::B, &chunks, b);

        // Syntax highlight side B via gpui-component's standalone highlighter.
        let mut highlighter = SyntaxHighlighter::new(language);
        let rope = Rope::from_str(b);
        highlighter.update(None, &rope, None);
        let theme = HighlightTheme::default_dark();
        let spans = highlighter.styles(&(0..b.len()), theme.as_ref());

        Self {
            b: b.to_string(),
            changed_b: deco.changed_lines.into_iter().collect(),
            spans,
        }
    }

    /// Syntax spans intersecting `[ls, le)`, clipped and rebased to be relative
    /// to the line start (so they index into the line substring).
    fn line_highlights(&self, ls: usize, le: usize) -> Vec<(Range<usize>, HighlightStyle)> {
        let mut out = Vec::new();
        for (r, style) in &self.spans {
            let s = r.start.max(ls);
            let e = r.end.min(le);
            if s < e {
                out.push((s - ls..e - ls, *style));
            }
        }
        out
    }
}

impl Render for DiffView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let mut rows = Vec::new();
        let mut offset = 0usize; // byte offset of current line start
        for (i, line) in self.b.split('\n').enumerate() {
            let ls = offset;
            let le = offset + line.len();
            let changed = self.changed_b.contains(&(ls as u32));

            let text = StyledText::new(line.to_string()).with_highlights(self.line_highlights(ls, le));

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
                .child(div().flex_1().child(text));
            if changed {
                row = row.bg(rgba(0x3fb95022));
            }
            rows.push(row);
            offset = le + 1; // skip the '\n'
        }

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0x1e1e1e))
            .text_color(rgb(0xe6e6e6))
            .p_2()
            .text_size(px(13.0))
            .children(rows)
    }
}
