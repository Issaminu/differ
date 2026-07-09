// Two-pane diff view — pivoted onto gpui-component's real editor.
//
// Each pane is an `InputState` code editor (cursor, selection, caret, IME,
// syntax highlighting, scrolling, undo/redo all handled by it). We subscribe to
// each editor's Change event and recompute the diff (via differ-core) to drive
// the toolbar stats + language + history capture.
//
// NOTE: diff decorations (the red/green tints) are NOT drawn yet — InputState
// has no decoration API, so they need a highlight overlay/fork (next
// increment). This trades the tints (temporarily) for a real, non-crashing,
// fully-editable editor.

use crate::history_store;
use differ_core::{
    decorations::count_changed_lines, diff_with_changes, history::History, lang::detect_language,
};
use gpui::{
    div, prelude::*, px, rgb, Context, Div, Entity, SharedString, Stateful, Subscription, Window,
};
use gpui_component::input::{Input, InputEvent, InputState};

pub struct DiffView {
    editor_a: Entity<InputState>,
    editor_b: Entity<InputState>,
    language: &'static str,
    /// (added lines on B, removed lines on A).
    stats: (usize, usize),
    history: History,
    history_open: bool,
    _subs: Vec<Subscription>,
}

impl DiffView {
    pub fn new(a: &str, b: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor_a =
            cx.new(|cx| InputState::new(window, cx).code_editor("text").line_number(true).default_value(a));
        let editor_b =
            cx.new(|cx| InputState::new(window, cx).code_editor("text").line_number(true).default_value(b));

        // Re-diff whenever either editor's content changes.
        let on_change = |this: &mut Self, _e: Entity<InputState>, event: &InputEvent, cx: &mut Context<Self>| {
            if matches!(event, InputEvent::Change) {
                this.recompute(cx);
                cx.notify();
            }
        };
        let subs = vec![
            cx.subscribe(&editor_a, on_change),
            cx.subscribe(&editor_b, on_change),
        ];

        let mut view = Self {
            editor_a,
            editor_b,
            language: "text",
            stats: (0, 0),
            history: history_store::load(),
            history_open: false,
            _subs: subs,
        };
        view.recompute(cx);
        view
    }

    /// Recompute diff stats + language from the two editors' current contents,
    /// push the language to the editors' highlighters, and capture to history.
    fn recompute(&mut self, cx: &mut Context<Self>) {
        let a = self.editor_a.read(cx).value().to_string();
        let b = self.editor_b.read(cx).value().to_string();

        let chunks = diff_with_changes(&a, &b);
        let mut added = 0;
        let mut removed = 0;
        for c in &chunks {
            removed += count_changed_lines(&a, c.from_a, c.end_a) as usize;
            added += count_changed_lines(&b, c.from_b, c.end_b) as usize;
        }
        self.stats = (added, removed);

        let sample = if b.len() >= a.len() { &b } else { &a };
        let lang = detect_language(sample);
        if lang != self.language {
            self.language = lang;
            self.editor_a.update(cx, |ed, cx| ed.set_highlighter(lang, cx));
            self.editor_b.update(cx, |ed, cx| ed.set_highlighter(lang, cx));
        }

        self.history.capture(&a, &b, lang, history_store::now_ms());
    }

    /// A styled toolbar button (caller attaches the click handler).
    fn button(id: &'static str, label: &str) -> Stateful<Div> {
        div()
            .id(id)
            .flex_none()
            .px_2()
            .py_1()
            .rounded_md()
            .bg(rgb(0x37373d))
            .text_color(rgb(0xe6e6e6))
            .cursor_pointer()
            .child(label.to_string())
    }

    /// Right-side history panel: recent captures, click to restore into both
    /// editors.
    fn render_drawer(&self, cx: &mut Context<Self>) -> Div {
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
                        this.recompute(cx); // set_value suppresses Change, so re-diff manually
                        cx.notify();
                    }))
                    .child(div().text_color(rgb(0xe6e6e6)).child(preview))
                    .child(div().text_color(rgb(0x808080)).text_size(px(11.0)).child(lang))
            })
            .collect();

        div()
            .flex()
            .flex_col()
            .flex_none()
            .w(px(300.0))
            .h_full()
            .bg(rgb(0x252526))
            .child(div().px_3().py_2().text_color(rgb(0xcccccc)).text_size(px(12.0)).child("History"))
            .child(div().id("history-scroll").flex().flex_col().flex_1().overflow_y_scroll().children(rows))
    }
}

impl Render for DiffView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (added, removed) = self.stats;
        let language = self.language;

        let toolbar = div()
            .flex()
            .flex_row()
            .items_center()
            .gap_3()
            .flex_none()
            .h(px(38.0))
            .px_3()
            .bg(rgb(0x252526))
            .text_color(rgb(0xcccccc))
            .text_size(px(12.0))
            .child(div().child(format!("Language: {language}")))
            .child(div().text_color(rgb(0x3fb950)).child(format!("+{added}")))
            .child(div().text_color(rgb(0xf85149)).child(format!("−{removed}")))
            .child(div().flex_1()) // spacer
            .child(Self::button("btn-swap", "Swap").on_click(cx.listener(|this, _, window, cx| {
                let a = this.editor_a.read(cx).value();
                let b = this.editor_b.read(cx).value();
                this.editor_a.update(cx, |ed, cx| ed.set_value(b, window, cx));
                this.editor_b.update(cx, |ed, cx| ed.set_value(a, window, cx));
                this.recompute(cx);
                cx.notify();
            })))
            .child(Self::button("btn-clear", "Clear").on_click(cx.listener(|this, _, window, cx| {
                this.editor_a.update(cx, |ed, cx| ed.set_value("", window, cx));
                this.editor_b.update(cx, |ed, cx| ed.set_value("", window, cx));
                this.recompute(cx);
                cx.notify();
            })))
            .child(Self::button("btn-history", "History").on_click(cx.listener(|this, _, _window, cx| {
                this.history_open = !this.history_open;
                history_store::save(&this.history); // flush to disk on toggle
                cx.notify();
            })));

        let editors = div()
            .flex()
            .flex_row()
            .flex_1()
            .child(Input::new(&self.editor_a).bordered(false).flex_1().h_full().text_size(px(13.0)))
            .child(div().w(px(1.0)).flex_none().bg(rgb(0x333333)))
            .child(Input::new(&self.editor_b).bordered(false).flex_1().h_full().text_size(px(13.0)));

        let body = div().flex().flex_col().flex_1().child(toolbar).child(editors);
        let mut root = div().flex().flex_row().size_full().bg(rgb(0x1e1e1e)).child(body);
        if self.history_open {
            root = root.child(self.render_drawer(cx));
        }
        root
    }
}
