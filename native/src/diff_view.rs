// Two-pane diff view on our forked gpui-component editor.
//
// Diff tints are fed INTO each editor via `set_diff_highlights` (our fork's
// addition): the editor composes them with syntax highlighting and paints them
// itself, so they're pixel-perfect, char-capable, and track scrolling natively
// — no overlay, no scroll poll.
//
// The diff still runs off the main thread on each edit (clone ropes O(1) ->
// stringify + diff on a background thread -> apply on main), generation-guarded
// and lightly debounced, so typing never blocks on big documents.

use std::ops::Range;
use std::time::Duration;

use crate::history_store;
use differ_core::{
    history::History,
    pipeline::{compute, ChangedLine, DiffCompute},
};
use gpui::{
    div, prelude::*, px, rgb, rgba, Context, Div, Entity, HighlightStyle, Hsla, SharedString,
    Stateful, Subscription, Window,
};
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::ActiveTheme;

const ADDED: u32 = 0x3fb950;
const REMOVED: u32 = 0xf85149;
// In-editor tint backgrounds (behind the text) — a touch stronger than an
// overlay since they're composited under the glyphs, not over them.
const ADDED_TINT: u32 = 0x3fb95040;
const REMOVED_TINT: u32 = 0xf8514940;

/// Coalesce keystroke bursts; the diff runs on a background thread so typing
/// never blocks — this just avoids redundant background work.
const RECOMPUTE_DEBOUNCE: Duration = Duration::from_millis(30);

pub struct DiffView {
    editor_a: Entity<InputState>,
    editor_b: Entity<InputState>,
    language: &'static str,
    stats: (usize, usize),
    recompute_gen: u64,
    history: History,
    history_open: bool,
    _subs: Vec<Subscription>,
}

impl DiffView {
    pub fn new(a: &str, b: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mk = |text: &str, window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| {
                InputState::new(window, cx)
                    .code_editor("text")
                    .line_number(true)
                    .soft_wrap(false)
                    .default_value(text)
            })
        };
        let editor_a = mk(a, window, cx);
        let editor_b = mk(b, window, cx);

        let on_change = |this: &mut Self, _e: Entity<InputState>, event: &InputEvent, cx: &mut Context<Self>| {
            if matches!(event, InputEvent::Change) {
                this.schedule_recompute(cx);
            }
        };
        let subs = vec![cx.subscribe(&editor_a, on_change), cx.subscribe(&editor_b, on_change)];

        let mut view = Self {
            editor_a,
            editor_b,
            language: "text",
            stats: (0, 0),
            recompute_gen: 0,
            history: history_store::load(),
            history_open: false,
            _subs: subs,
        };
        view.recompute(cx);
        view
    }

    /// Recompute the diff off the main thread, then apply on the main thread.
    fn schedule_recompute(&mut self, cx: &mut Context<Self>) {
        self.recompute_gen = self.recompute_gen.wrapping_add(1);
        let generation = self.recompute_gen;
        let a_rope = self.editor_a.read(cx).text().clone();
        let b_rope = self.editor_b.read(cx).text().clone();

        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(RECOMPUTE_DEBOUNCE).await;
            let superseded = this.update(cx, |this, _| this.recompute_gen != generation).unwrap_or(true);
            if superseded {
                return;
            }
            let (a, b, comp) = cx
                .background_executor()
                .spawn(async move {
                    let a: String = a_rope.chunks().collect();
                    let b: String = b_rope.chunks().collect();
                    let comp = compute(&a, &b);
                    (a, b, comp)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.recompute_gen == generation {
                    this.apply_compute(comp, &a, &b, cx);
                }
            });
        })
        .detach();
    }

    /// Synchronous recompute for one-shot actions (swap/clear/restore/init).
    fn recompute(&mut self, cx: &mut Context<Self>) {
        let a = self.editor_a.read(cx).value().to_string();
        let b = self.editor_b.read(cx).value().to_string();
        let comp = compute(&a, &b);
        self.apply_compute(comp, &a, &b, cx);
    }

    /// Apply a computed diff: stats, language, in-editor tints, history.
    fn apply_compute(&mut self, comp: DiffCompute, a: &str, b: &str, cx: &mut Context<Self>) {
        self.stats = (comp.added, comp.removed);

        if comp.language != self.language {
            self.language = comp.language;
            self.editor_a.update(cx, |ed, cx| ed.set_highlighter(comp.language, cx));
            self.editor_b.update(cx, |ed, cx| ed.set_highlighter(comp.language, cx));
        }

        let ha = to_highlights(&comp.changed_a, rgba(REMOVED_TINT).into());
        let hb = to_highlights(&comp.changed_b, rgba(ADDED_TINT).into());
        self.editor_a.update(cx, |ed, cx| ed.set_diff_highlights(ha, cx));
        self.editor_b.update(cx, |ed, cx| ed.set_diff_highlights(hb, cx));

        self.history.capture(a, b, comp.language, history_store::now_ms());
        cx.notify();
    }

    fn button(id: &'static str, label: &str, bg: Hsla, fg: Hsla) -> Stateful<Div> {
        div().id(id).flex_none().px_2().py_1().rounded_md().bg(bg).text_color(fg).cursor_pointer().child(label.to_string())
    }

    fn render_drawer(&self, cx: &mut Context<Self>) -> Div {
        let (sidebar, border, fg, muted) = {
            let t = cx.theme();
            (t.sidebar, t.border, t.foreground, t.muted_foreground)
        };
        let rows: Vec<Stateful<Div>> = self
            .history
            .recent()
            .map(|e| {
                let (orig, modif) = (e.original.clone(), e.modified.clone());
                let preview = if e.preview.trim().is_empty() { "(empty)".to_string() } else { e.preview.clone() };
                let lang = e.language.to_string();
                div()
                    .id(SharedString::from(e.id.clone()))
                    .flex()
                    .flex_col()
                    .gap_1()
                    .px_3()
                    .py_2()
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, window, cx| {
                        let (o, m) = (orig.clone(), modif.clone());
                        this.editor_a.update(cx, |ed, cx| ed.set_value(o, window, cx));
                        this.editor_b.update(cx, |ed, cx| ed.set_value(m, window, cx));
                        this.history_open = false;
                        this.recompute(cx);
                        cx.notify();
                    }))
                    .child(div().text_color(fg).child(preview))
                    .child(div().text_color(muted).text_size(px(11.0)).child(lang))
            })
            .collect();

        div()
            .flex()
            .flex_col()
            .flex_none()
            .w(px(300.0))
            .h_full()
            .border_l_1()
            .border_color(border)
            .bg(sidebar)
            .child(div().px_3().py_2().text_color(muted).text_size(px(12.0)).child("History"))
            .child(div().id("history-scroll").flex().flex_col().flex_1().overflow_y_scroll().children(rows))
    }
}

/// Map changed lines to editor highlight spans (a background tint per range).
fn to_highlights(changed: &[ChangedLine], tint: Hsla) -> Vec<(Range<usize>, HighlightStyle)> {
    changed
        .iter()
        .filter_map(|&(_, s, e)| {
            (s < e).then(|| {
                (s as usize..e as usize, HighlightStyle { background_color: Some(tint), ..Default::default() })
            })
        })
        .collect()
}

impl Render for DiffView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (added, removed) = self.stats;
        let language = self.language;
        let (bg, bar, border, fg, muted, secondary) = {
            let t = cx.theme();
            (t.background, t.title_bar, t.border, t.foreground, t.muted_foreground, t.secondary)
        };

        let toolbar = div()
            .flex()
            .flex_row()
            .items_center()
            .gap_3()
            .flex_none()
            .h(px(38.0))
            .px_3()
            .bg(bar)
            .border_b_1()
            .border_color(border)
            .text_color(muted)
            .text_size(px(12.0))
            .child(div().child(format!("Language: {language}")))
            .child(div().text_color(rgb(ADDED)).child(format!("+{added}")))
            .child(div().text_color(rgb(REMOVED)).child(format!("−{removed}")))
            .child(div().flex_1())
            .child(Self::button("btn-swap", "Swap", secondary, fg).on_click(cx.listener(|this, _, window, cx| {
                let a = this.editor_a.read(cx).value();
                let b = this.editor_b.read(cx).value();
                this.editor_a.update(cx, |ed, cx| ed.set_value(b, window, cx));
                this.editor_b.update(cx, |ed, cx| ed.set_value(a, window, cx));
                this.recompute(cx);
                cx.notify();
            })))
            .child(Self::button("btn-clear", "Clear", secondary, fg).on_click(cx.listener(|this, _, window, cx| {
                this.editor_a.update(cx, |ed, cx| ed.set_value("", window, cx));
                this.editor_b.update(cx, |ed, cx| ed.set_value("", window, cx));
                this.recompute(cx);
                cx.notify();
            })))
            .child(Self::button("btn-history", "History", secondary, fg).on_click(cx.listener(|this, _, _window, cx| {
                this.history_open = !this.history_open;
                history_store::save(&this.history);
                cx.notify();
            })));

        let editors = div()
            .flex()
            .flex_row()
            .flex_1()
            .child(Input::new(&self.editor_a).bordered(false).flex_1().h_full().text_size(px(13.0)))
            .child(div().w(px(1.0)).flex_none().bg(border))
            .child(Input::new(&self.editor_b).bordered(false).flex_1().h_full().text_size(px(13.0)));

        let body = div().flex().flex_col().flex_1().child(toolbar).child(editors);
        let mut root = div().flex().flex_row().size_full().bg(bg).child(body);
        if self.history_open {
            root = root.child(self.render_drawer(cx));
        }
        root
    }
}
