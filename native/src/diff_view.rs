// The two-pane diff view — a thin gpui shell over the pure, headlessly-tested
// `differ_core::model::DiffModel`. The model owns all editing + diff state; the
// view forwards key events to it and renders its rows/decorations, layering
// gpui-component's SyntaxHighlighter on top (the one gpui-dependent piece).
//
// The right pane (B, "new") is editable; left (A) is read-only for now. Cursor
// is drawn as a stand-in glyph; click focuses (caret-by-click + A editing next).

use std::ops::Range;

use differ_core::{
    decorations::{build_decorations, Side},
    model::{DiffModel, KeyOutcome},
    Chunk,
};
use gpui::{
    div, prelude::*, px, rgb, rgba, uniform_list, Context, Div, FocusHandle, HighlightStyle, Hsla,
    KeyDownEvent, MouseButton, StyledText, UniformListScrollHandle, Window,
};
use gpui_component::highlighter::{HighlightTheme, SyntaxHighlighter};
use gpui_component::input::Rope;

/// Per-side rendering data (syntax + decorations), rebuilt on every edit.
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
    model: DiffModel,
    language: String,
    pane_a: Pane,
    pane_b: Pane,
    focus: FocusHandle,
    scroll_handle: UniformListScrollHandle,
}

impl DiffView {
    pub fn new(a: &str, b: &str, language: &str, cx: &mut Context<Self>) -> Self {
        let model = DiffModel::new(a, b);
        let (pane_a, pane_b) = Self::build_panes(&model, language);
        Self {
            model,
            language: language.to_string(),
            pane_a,
            pane_b,
            focus: cx.focus_handle(),
            scroll_handle: UniformListScrollHandle::new(),
        }
    }

    fn build_panes(model: &DiffModel, language: &str) -> (Pane, Pane) {
        let chunks = model.chunks();
        let pane_a = Pane::build(model.text(Side::A), Side::A, chunks, language, rgba(0xf8514922).into(), rgba(0xf8514955).into(), rgb(0xf85149).into());
        let pane_b = Pane::build(model.text(Side::B), Side::B, chunks, language, rgba(0x3fb95022).into(), rgba(0x3fb95055).into(), rgb(0x3fb950).into());
        (pane_a, pane_b)
    }

    fn rebuild_panes(&mut self) {
        let (a, b) = Self::build_panes(&self.model, &self.language);
        self.pane_a = a;
        self.pane_b = b;
    }

    fn on_key(&mut self, e: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let ks = &e.keystroke;

        if ks.modifiers.platform && ks.key == "v" {
            if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                self.model.paste(&text);
                self.rebuild_panes();
                cx.notify();
            }
            return;
        }
        if ks.modifiers.platform || ks.modifiers.control {
            return;
        }

        match self.model.apply_key(&ks.key, ks.key_char.as_deref()) {
            KeyOutcome::Edited => {
                self.rebuild_panes();
                cx.notify();
            }
            KeyOutcome::Moved => cx.notify(),
            KeyOutcome::Ignored => {}
        }
    }

    fn render_row(&self, ix: usize, cursor_line: usize) -> Div {
        let r = self.model.rows()[ix];
        let caret_b = match r.b {
            Some(bi) if bi as usize == cursor_line => {
                Some(self.model.cursor(Side::B) - self.pane_b.line_ranges[bi as usize].start)
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
        let cursor_line = self.model.cursor_line(Side::B);
        uniform_list(
            "diff-rows",
            self.model.rows().len(),
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
