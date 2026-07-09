// The two-pane diff view — built on raw gpui so decorations, gutter, and scroll
// are first-class. Syntax highlighting is reused from gpui-component's
// standalone `SyntaxHighlighter` (text -> styled spans), NOT its editor.
//
// Increment 3: two panes (A = original/removed, B = new/added) side by side,
// each with syntax highlighting, changed-line tint + gutter, and char-level
// inner-change highlights. The char highlights are composed with the syntax
// spans via an interval sweep so the runs handed to gpui's `with_highlights`
// are non-overlapping (a run carries both a syntax foreground and a diff
// background where they coincide).
//
// Not yet: synced scrolling + line alignment spacers (next increment).

use std::collections::HashSet;
use std::ops::Range;

use differ_core::{
    decorations::{build_decorations, Side},
    diff_with_changes,
};
use gpui::{div, prelude::*, px, rgb, rgba, Context, Div, Hsla, HighlightStyle, StyledText, Window};
use gpui_component::highlighter::{HighlightTheme, SyntaxHighlighter};
use gpui_component::input::Rope;

/// Everything needed to render one side of the diff.
struct Pane {
    text: String,
    /// Byte offsets of changed line starts.
    changed_lines: HashSet<u32>,
    /// Document byte ranges of char-level changes.
    char_spans: Vec<(usize, usize)>,
    /// Tree-sitter syntax spans over the whole text (document byte ranges).
    syntax: Vec<(Range<usize>, HighlightStyle)>,
    /// Line-background tint for changed lines.
    line_tint: Hsla,
    /// Stronger background for changed chars within a changed line.
    char_tint: Hsla,
    /// Gutter number colour for changed lines.
    gutter_changed: Hsla,
}

impl Pane {
    fn build(text: &str, side: Side, chunks: &[differ_core::Chunk], language: &str, tint: Hsla, char_tint: Hsla, gutter: Hsla) -> Self {
        let deco = build_decorations(side, chunks, text);
        let mut highlighter = SyntaxHighlighter::new(language);
        let rope = Rope::from_str(text);
        highlighter.update(None, &rope, None);
        let theme = HighlightTheme::default_dark();
        let syntax = highlighter.styles(&(0..text.len()), theme.as_ref());
        Self {
            text: text.to_string(),
            changed_lines: deco.changed_lines.into_iter().collect(),
            char_spans: deco.changed_spans.into_iter().map(|(f, t)| (f as usize, t as usize)).collect(),
            syntax,
            line_tint: tint,
            char_tint,
            gutter_changed: gutter,
        }
    }

    /// Compose the line's syntax spans (foreground) and diff char spans
    /// (background) into a single non-overlapping run list, relative to the
    /// line start `ls`. Both inputs are half-open document byte ranges.
    fn line_runs(&self, ls: usize, le: usize) -> Vec<(Range<usize>, HighlightStyle)> {
        let len = le - ls;
        // Clip + rebase the syntax and diff spans onto [0, len).
        let syntax: Vec<(Range<usize>, Hsla)> = self
            .syntax
            .iter()
            .filter_map(|(r, s)| {
                let a = r.start.max(ls);
                let b = r.end.min(le);
                let color = s.color?;
                (a < b).then(|| (a - ls..b - ls, color))
            })
            .collect();
        let diff: Vec<Range<usize>> = self
            .char_spans
            .iter()
            .filter_map(|&(f, t)| {
                let a = f.max(ls);
                let b = t.min(le);
                (a < b).then(|| a - ls..b - ls)
            })
            .collect();

        // Boundary sweep: every run boundary is a span edge; between two
        // consecutive boundaries the covering fg/bg are constant.
        let mut bounds: Vec<usize> = vec![0, len];
        for r in &syntax {
            bounds.push(r.0.start);
            bounds.push(r.0.end);
        }
        for r in &diff {
            bounds.push(r.start);
            bounds.push(r.end);
        }
        bounds.retain(|&b| b <= len);
        bounds.sort_unstable();
        bounds.dedup();

        let mut runs = Vec::new();
        for w in bounds.windows(2) {
            let (p0, p1) = (w[0], w[1]);
            if p0 >= p1 {
                continue;
            }
            let fg = syntax.iter().find(|(r, _)| r.start <= p0 && p0 < r.end).map(|(_, c)| *c);
            let is_diff = diff.iter().any(|r| r.start <= p0 && p0 < r.end);
            if fg.is_some() || is_diff {
                runs.push((
                    p0..p1,
                    HighlightStyle {
                        color: fg,
                        background_color: is_diff.then_some(self.char_tint),
                        ..Default::default()
                    },
                ));
            }
        }
        runs
    }

    fn render(&self) -> Div {
        let mut rows = Vec::new();
        let mut offset = 0usize;
        for (i, line) in self.text.split('\n').enumerate() {
            let ls = offset;
            let le = offset + line.len();
            let changed = self.changed_lines.contains(&(ls as u32));

            let text = StyledText::new(line.to_string()).with_highlights(self.line_runs(ls, le));
            let mut row = div()
                .flex()
                .flex_row()
                .w_full()
                .child(
                    div()
                        .w(px(48.0))
                        .flex_none()
                        .text_color(if changed { self.gutter_changed } else { rgb(0x6b7280).into() })
                        .child(format!("{:>4} ", i + 1)),
                )
                .child(div().flex_1().child(text));
            if changed {
                row = row.bg(self.line_tint);
            }
            rows.push(row);
            offset = le + 1;
        }

        div()
            .flex()
            .flex_col()
            .flex_1()
            .h_full()
            .text_color(rgb(0xe6e6e6))
            .p_2()
            .text_size(px(13.0))
            .children(rows)
    }
}

pub struct DiffView {
    a: Pane,
    b: Pane,
}

impl DiffView {
    pub fn new(a: &str, b: &str, language: &str) -> Self {
        let chunks = diff_with_changes(a, b);
        // A = original: removed/changed shown in red. B = new: added in green.
        let a_pane = Pane::build(
            a,
            Side::A,
            &chunks,
            language,
            rgba(0xf8514922).into(),
            rgba(0xf8514955).into(),
            rgb(0xf85149).into(),
        );
        let b_pane = Pane::build(
            b,
            Side::B,
            &chunks,
            language,
            rgba(0x3fb95022).into(),
            rgba(0x3fb95055).into(),
            rgb(0x3fb950).into(),
        );
        Self { a: a_pane, b: b_pane }
    }
}

impl Render for DiffView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_row()
            .size_full()
            .bg(rgb(0x1e1e1e))
            .child(self.a.render())
            .child(div().w(px(1.0)).h_full().bg(rgb(0x333333))) // divider
            .child(self.b.render())
    }
}
