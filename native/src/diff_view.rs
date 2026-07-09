// The two-pane diff view — built on raw gpui so decorations, gutter, and scroll
// are first-class. Syntax highlighting is reused from gpui-component's
// standalone `SyntaxHighlighter`.
//
// Increment 7: make it an interactive editor. The right pane (B, the "new"
// side) is editable — keystrokes mutate its buffer and the diff + decorations
// + alignment recompute live. Left pane (A) stays read-only for now; editing A
// + side switching + precise caret geometry come next. Cursor is drawn as a
// stand-in glyph at the cursor's line/offset.

use std::ops::Range;

use differ_core::{
    align::{align, AlignedRow},
    decorations::{build_decorations, Side},
    diff_with_changes, Chunk,
};
use gpui::{
    div, prelude::*, px, rgb, rgba, Context, Div, FocusHandle, HighlightStyle, Hsla, KeyDownEvent,
    MouseButton, StyledText, UniformListScrollHandle, Window, uniform_list,
};
use gpui_component::highlighter::{HighlightTheme, SyntaxHighlighter};
use gpui_component::input::Rope;

/// Rendering data for one side of the diff (rebuilt on every edit).
struct Pane {
    text: String,
    line_ranges: Vec<Range<usize>>,
    char_spans: Vec<(usize, usize)>,
    syntax: Vec<(Range<usize>, HighlightStyle)>,
    line_tint: Hsla,
    char_tint: Hsla,
    gutter_changed: Hsla,
}

impl Pane {
    fn build(text: &str, side: Side, chunks: &[Chunk], language: &str, tint: Hsla, char_tint: Hsla, gutter: Hsla) -> Self {
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

    /// One side's cell for a visual row. `caret_at` is a line-relative byte
    /// offset at which to draw the stand-in caret (only the focused editable
    /// side passes it).
    fn cell(&self, line: Option<u32>, changed: bool, caret_at: Option<usize>) -> Div {
        match line {
            Some(i) => {
                let r = self.line_ranges[i as usize].clone();
                let runs = self.line_runs(&r);
                let mut content = self.text[r].to_string();
                if let Some(off) = caret_at {
                    content.insert(off.min(content.len()), '\u{2502}');
                }
                let text = StyledText::new(content).with_highlights(runs);
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
            None => div().flex_1().bg(rgb(0x161616)),
        }
    }
}

pub struct DiffView {
    a: String,
    b: String,
    language: String,
    /// Cursor as a byte offset into `b` (the editable side).
    cursor_b: usize,
    focus: FocusHandle,

    // Cached render model — rebuilt by `recompute` on every edit.
    pane_a: Pane,
    pane_b: Pane,
    rows: Vec<AlignedRow>,

    scroll_handle: UniformListScrollHandle,
}

impl DiffView {
    pub fn new(a: &str, b: &str, language: &str, cx: &mut Context<Self>) -> Self {
        let (pane_a, pane_b, rows) = Self::compute(a, b, language);
        Self {
            a: a.to_string(),
            b: b.to_string(),
            language: language.to_string(),
            cursor_b: b.len(), // start at end so typing appends
            focus: cx.focus_handle(),
            pane_a,
            pane_b,
            rows,
            scroll_handle: UniformListScrollHandle::new(),
        }
    }

    fn compute(a: &str, b: &str, language: &str) -> (Pane, Pane, Vec<AlignedRow>) {
        let chunks = diff_with_changes(a, b);
        let rows = align(&chunks, a, b);
        let pane_a = Pane::build(a, Side::A, &chunks, language, rgba(0xf8514922).into(), rgba(0xf8514955).into(), rgb(0xf85149).into());
        let pane_b = Pane::build(b, Side::B, &chunks, language, rgba(0x3fb95022).into(), rgba(0x3fb95055).into(), rgb(0x3fb950).into());
        (pane_a, pane_b, rows)
    }

    /// Recompute the diff + decorations + alignment after an edit to B.
    fn recompute(&mut self) {
        let (pane_a, pane_b, rows) = Self::compute(&self.a, &self.b, &self.language);
        self.pane_a = pane_a;
        self.pane_b = pane_b;
        self.rows = rows;
    }

    fn insert(&mut self, s: &str) {
        self.b.insert_str(self.cursor_b, s);
        self.cursor_b += s.len();
    }

    fn backspace(&mut self) {
        if self.cursor_b == 0 {
            return;
        }
        let prev = self.b[..self.cursor_b].char_indices().next_back().map(|(i, _)| i).unwrap_or(0);
        self.b.replace_range(prev..self.cursor_b, "");
        self.cursor_b = prev;
    }

    fn on_key(&mut self, e: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let ks = &e.keystroke;

        if ks.modifiers.platform && ks.key == "v" {
            if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                self.insert(&text);
                self.recompute();
                cx.notify();
            }
            return;
        }
        if ks.modifiers.platform || ks.modifiers.control {
            return;
        }

        match ks.key.as_str() {
            "backspace" => self.backspace(),
            "enter" => self.insert("\n"),
            "tab" => self.insert("    "),
            "space" => self.insert(" "),
            "left" => {
                self.cursor_b = self.b[..self.cursor_b].char_indices().next_back().map(|(i, _)| i).unwrap_or(0);
                cx.notify();
                return;
            }
            "right" => {
                if self.cursor_b < self.b.len() {
                    self.cursor_b = self.b[self.cursor_b..].char_indices().nth(1).map(|(i, _)| self.cursor_b + i).unwrap_or(self.b.len());
                }
                cx.notify();
                return;
            }
            _ => {
                if let Some(ch) = ks.key_char.clone() {
                    self.insert(&ch);
                } else {
                    return;
                }
            }
        }
        self.recompute();
        cx.notify();
    }

    /// Line index (in B) containing the cursor.
    fn cursor_line_b(&self) -> usize {
        self.b[..self.cursor_b].bytes().filter(|&c| c == b'\n').count()
    }

    fn render_row(&self, ix: usize, cursor_line: usize) -> Div {
        let r = self.rows[ix];
        let caret_b = match r.b {
            Some(bi) if bi as usize == cursor_line => {
                Some(self.cursor_b - self.pane_b.line_ranges[bi as usize].start)
            }
            _ => None,
        };
        div()
            .flex()
            .flex_row()
            .w_full()
            .child(self.pane_a.cell(r.a, r.changed, None))
            .child(div().w(px(1.0)).flex_none().bg(rgb(0x333333)))
            .child(self.pane_b.cell(r.b, r.changed, caret_b))
    }
}

impl Render for DiffView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let cursor_line = self.cursor_line_b();
        uniform_list(
            "diff-rows",
            self.rows.len(),
            cx.processor(move |this, range: Range<usize>, _window, _cx| {
                range.map(|ix| this.render_row(ix, cursor_line)).collect::<Vec<_>>()
            }),
        )
        .track_focus(&self.focus)
        .on_key_down(cx.listener(Self::on_key))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _ev, window, cx| {
                this.focus.focus(window, cx);
                cx.notify();
            }),
        )
        .track_scroll(&self.scroll_handle)
        .size_full()
        .bg(rgb(0x1e1e1e))
        .text_color(rgb(0xe6e6e6))
        .text_size(px(13.0))
    }
}
