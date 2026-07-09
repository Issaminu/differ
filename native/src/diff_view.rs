// The two-pane diff view — built on raw gpui so decorations, gutter, and scroll
// are first-class. Syntax highlighting is reused from gpui-component's
// standalone `SyntaxHighlighter` (text -> styled spans), NOT its editor.
//
// Increment 4: render aligned A|B rows (via differ_core::align) in a single
// scroll region. Pairing each A line with its B counterpart — and inserting
// spacers for pure insertions/deletions — gives correct side-by-side alignment
// and, because both panes live in one scroll region, inherently synced
// scrolling. Each cell carries syntax highlighting + changed-line tint + gutter
// + char-level inner-change highlights.
//
// Not yet: virtualized rendering (uniform_list) for very large diffs.

use std::ops::Range;

use differ_core::{
    align::{align, AlignedRow},
    decorations::{build_decorations, Side},
    diff_with_changes,
};
use gpui::{div, prelude::*, px, rgb, rgba, Context, Div, HighlightStyle, Hsla, StyledText, Window};
use gpui_component::highlighter::{HighlightTheme, SyntaxHighlighter};
use gpui_component::input::Rope;

/// Everything needed to render one side of the diff.
struct Pane {
    text: String,
    /// Content byte range of each line (excludes the trailing '\n').
    line_ranges: Vec<Range<usize>>,
    /// Document byte ranges of char-level changes.
    char_spans: Vec<(usize, usize)>,
    /// Tree-sitter syntax spans over the whole text (document byte ranges).
    syntax: Vec<(Range<usize>, HighlightStyle)>,
    line_tint: Hsla,
    char_tint: Hsla,
    gutter_changed: Hsla,
}

impl Pane {
    fn build(text: &str, side: Side, chunks: &[differ_core::Chunk], language: &str, tint: Hsla, char_tint: Hsla, gutter: Hsla) -> Self {
        let deco = build_decorations(side, chunks, text);

        let mut line_ranges = Vec::new();
        let mut off = 0usize;
        for line in text.split('\n') {
            line_ranges.push(off..off + line.len());
            off += line.len() + 1;
        }

        let mut highlighter = SyntaxHighlighter::new(language);
        let rope = Rope::from_str(text);
        highlighter.update(None, &rope, None);
        let theme = HighlightTheme::default_dark();
        let syntax = highlighter.styles(&(0..text.len()), theme.as_ref());

        Self {
            text: text.to_string(),
            line_ranges,
            char_spans: deco.changed_spans.into_iter().map(|(f, t)| (f as usize, t as usize)).collect(),
            syntax,
            line_tint: tint,
            char_tint,
            gutter_changed: gutter,
        }
    }

    /// Compose syntax (fg) + diff char (bg) spans over line range `r` into
    /// non-overlapping runs relative to the line start.
    fn line_runs(&self, r: &Range<usize>) -> Vec<(Range<usize>, HighlightStyle)> {
        let (ls, le) = (r.start, r.end);
        let len = le - ls;

        let syntax: Vec<(Range<usize>, Hsla)> = self
            .syntax
            .iter()
            .filter_map(|(sr, s)| {
                let a = sr.start.max(ls);
                let b = sr.end.min(le);
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

    /// One side's cell for a visual row: a rendered line, or a spacer.
    fn cell(&self, line: Option<u32>, changed: bool) -> Div {
        match line {
            Some(i) => {
                let r = self.line_ranges[i as usize].clone();
                let content = self.text[r.clone()].to_string();
                let text = StyledText::new(content).with_highlights(self.line_runs(&r));
                let mut cell = div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .child(
                        div()
                            .w(px(44.0))
                            .flex_none()
                            .text_color(if changed { self.gutter_changed } else { rgb(0x6b7280).into() })
                            .child(format!("{:>4} ", i + 1)),
                    )
                    .child(div().flex_1().child(text));
                if changed {
                    cell = cell.bg(self.line_tint);
                }
                cell
            }
            // Spacer for a line that doesn't exist on this side.
            None => div().flex_1().bg(rgb(0x161616)),
        }
    }
}

pub struct DiffView {
    a: Pane,
    b: Pane,
    rows: Vec<AlignedRow>,
}

impl DiffView {
    pub fn new(a: &str, b: &str, language: &str) -> Self {
        let chunks = diff_with_changes(a, b);
        let rows = align(&chunks, a, b);
        let a_pane = Pane::build(a, Side::A, &chunks, language, rgba(0xf8514922).into(), rgba(0xf8514955).into(), rgb(0xf85149).into());
        let b_pane = Pane::build(b, Side::B, &chunks, language, rgba(0x3fb95022).into(), rgba(0x3fb95055).into(), rgb(0x3fb950).into());
        Self { a: a_pane, b: b_pane, rows }
    }
}

impl Render for DiffView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let rows: Vec<Div> = self
            .rows
            .iter()
            .map(|r| {
                div()
                    .flex()
                    .flex_row()
                    .w_full()
                    .child(self.a.cell(r.a, r.changed))
                    .child(div().w(px(1.0)).flex_none().bg(rgb(0x333333))) // divider
                    .child(self.b.cell(r.b, r.changed))
            })
            .collect();

        div()
            .id("diff-scroll")
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0x1e1e1e))
            .text_color(rgb(0xe6e6e6))
            .text_size(px(13.0))
            .overflow_y_scroll()
            .children(rows)
    }
}
