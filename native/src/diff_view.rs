// Two-pane diff view on gpui-component's editor, with a canvas overlay that
// paints the diff tints.
//
// Each pane is an InputState editor (cursor/selection/caret/IME/syntax/scroll
// all native). Over each editor we lay an absolutely-positioned `canvas` that
// paints translucent red/green rects on the changed lines. The canvas paints in
// the paint phase — after the editor has laid out this frame — and reads the
// editor's own `range_to_bounds`, so tints are positioned from the editor's
// real (scroll-correct) layout.
//
// The editor emits no scroll event, so a lightweight per-frame poll re-renders
// this view whenever either editor's scroll offset changes (that's what keeps
// the overlay glued to the text while scrolling). Changed-line ranges are
// computed on edit and cached, so scrolling never re-diffs or re-clones text.

use std::time::Duration;

use crate::history_store;
use differ_core::{history::History, pipeline::{compute, ChangedLine}};
use gpui::{
    canvas, div, fill, point, prelude::*, px, rgb, rgba, size, Bounds, Context, Div, Entity, Hsla,
    Pixels, Point, SharedString, Stateful, Subscription, Window,
};
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::ActiveTheme;

const ADDED: u32 = 0x3fb950;
const REMOVED: u32 = 0xf85149;
// Translucent tints painted over changed lines. NOTE: 8-digit 0xRRGGBBAA — the
// last byte is alpha, so these MUST be built with rgba() (rgb() drops alpha and
// truncates to 24-bit, painting a wrong opaque colour).
const ADDED_TINT: u32 = 0x3fb95033;
const REMOVED_TINT: u32 = 0xf8514933;

/// Very small debounce that only coalesces bursts of keystrokes — the diff
/// itself runs on a background thread, so typing never blocks on it. Keeps
/// tints feeling live while avoiding redundant background work during fast
/// typing/paste.
const RECOMPUTE_DEBOUNCE: Duration = Duration::from_millis(30);

pub struct DiffView {
    editor_a: Entity<InputState>,
    editor_b: Entity<InputState>,
    language: &'static str,
    /// (added lines on B, removed lines on A).
    stats: (usize, usize),
    /// Changed lines per side (cached on edit; consumed by the overlay).
    changed_a: Vec<ChangedLine>,
    changed_b: Vec<ChangedLine>,
    /// Last-seen scroll offsets, for the scroll poll.
    last_scroll_a: Point<Pixels>,
    last_scroll_b: Point<Pixels>,
    /// Debounce generation — a scheduled recompute only fires if it's still the
    /// latest (i.e. no newer keystroke came in during the debounce window).
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
                // Debounced: don't re-diff on every keystroke (that's what froze
                // typing on big docs). The editor already applied the edit.
                this.schedule_recompute(cx);
            }
        };
        let subs = vec![cx.subscribe(&editor_a, on_change), cx.subscribe(&editor_b, on_change)];

        // Start the scroll poll that keeps the overlay in sync while scrolling.
        cx.on_next_frame(window, Self::poll_scroll);

        let mut view = Self {
            editor_a,
            editor_b,
            language: "text",
            stats: (0, 0),
            changed_a: Vec::new(),
            changed_b: Vec::new(),
            last_scroll_a: Point::default(),
            last_scroll_b: Point::default(),
            recompute_gen: 0,
            history: history_store::load(),
            history_open: false,
            _subs: subs,
        };
        view.recompute(cx);
        view
    }

    /// Recompute the diff off the main thread. On each edit we cheaply clone
    /// both editors' ropes (O(1), shared structure), then stringify + diff on a
    /// background thread and apply the result on the main thread. A tiny
    /// debounce coalesces bursts; a generation guard drops stale results.
    fn schedule_recompute(&mut self, cx: &mut Context<Self>) {
        self.recompute_gen = self.recompute_gen.wrapping_add(1);
        let generation = self.recompute_gen;
        let a_rope = self.editor_a.read(cx).text().clone();
        let b_rope = self.editor_b.read(cx).text().clone();

        cx.spawn(async move |this, cx| {
            // Coalesce bursts; bail if a newer edit superseded us in the meantime.
            cx.background_executor().timer(RECOMPUTE_DEBOUNCE).await;
            let superseded = this.update(cx, |this, _| this.recompute_gen != generation).unwrap_or(true);
            if superseded {
                return;
            }

            // Heavy work (stringify both ropes + diff) on a background thread.
            let (a, b, comp) = cx
                .background_executor()
                .spawn(async move {
                    let a: String = a_rope.chunks().collect();
                    let b: String = b_rope.chunks().collect();
                    let comp = compute(&a, &b);
                    (a, b, comp)
                })
                .await;

            // Apply on the main thread, if still the latest.
            let _ = this.update(cx, |this, cx| {
                if this.recompute_gen != generation {
                    return;
                }
                this.stats = (comp.added, comp.removed);
                this.changed_a = comp.changed_a;
                this.changed_b = comp.changed_b;
                if comp.language != this.language {
                    this.language = comp.language;
                    this.editor_a.update(cx, |ed, cx| ed.set_highlighter(comp.language, cx));
                    this.editor_b.update(cx, |ed, cx| ed.set_highlighter(comp.language, cx));
                }
                this.history.capture(&a, &b, comp.language, history_store::now_ms());
                cx.notify();
            });
        })
        .detach();
    }

    /// Re-render this view when either editor scrolls (the editor emits no
    /// scroll event). Cheap: two reads + a compare; only notifies on change.
    /// Reschedules itself every frame.
    fn poll_scroll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let sa = self.editor_a.read(cx).scroll_offset();
        let sb = self.editor_b.read(cx).scroll_offset();
        if sa != self.last_scroll_a || sb != self.last_scroll_b {
            self.last_scroll_a = sa;
            self.last_scroll_b = sb;
            cx.notify();
        }
        cx.on_next_frame(window, Self::poll_scroll);
    }

    fn recompute(&mut self, cx: &mut Context<Self>) {
        let a = self.editor_a.read(cx).value().to_string();
        let b = self.editor_b.read(cx).value().to_string();

        let c = compute(&a, &b);
        self.stats = (c.added, c.removed);
        self.changed_a = c.changed_a;
        self.changed_b = c.changed_b;

        if c.language != self.language {
            self.language = c.language;
            self.editor_a.update(cx, |ed, cx| ed.set_highlighter(c.language, cx));
            self.editor_b.update(cx, |ed, cx| ed.set_highlighter(c.language, cx));
        }

        self.history.capture(&a, &b, c.language, history_store::now_ms());
    }

    /// A styled toolbar button (caller attaches the click handler).
    fn button(id: &'static str, label: &str, bg: Hsla, fg: Hsla) -> Stateful<Div> {
        div().id(id).flex_none().px_2().py_1().rounded_md().bg(bg).text_color(fg).cursor_pointer().child(label.to_string())
    }

    /// An editor pane with its diff-tint overlay canvas on top.
    fn pane(&self, editor: &Entity<InputState>, changed: &[ChangedLine], tint: Hsla) -> Div {
        let editor_for_paint = editor.clone();
        let ranges = changed.to_vec();
        let overlay = canvas(
            |_bounds, _window, _cx| (),
            move |bounds, _, window, cx| paint_diff_tints(&editor_for_paint, &ranges, tint, bounds, window, cx),
        )
        .absolute()
        .size_full();

        div()
            .relative()
            .flex_1()
            .overflow_hidden()
            .child(Input::new(editor).bordered(false).size_full().text_size(px(13.0)))
            .child(overlay)
    }
}

/// Paint translucent tint rects over the changed lines that are currently
/// visible. `bounds` is the overlay canvas's rect (== the pane's rect). Line y
/// positions come from the editor's own layout (scroll-correct).
fn paint_diff_tints(
    editor: &Entity<InputState>,
    changed: &[ChangedLine],
    tint: Hsla,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut gpui::App,
) {
    let state = editor.read(cx);
    let Some(line_height) = state.line_height() else { return };
    let visible = state.visible_row_range();
    for &(idx, s, e) in changed {
        if let Some(vis) = &visible {
            if !vis.contains(&(idx as usize)) {
                continue;
            }
        }
        if let Some(b) = state.range_to_bounds(&((s as usize)..(e as usize))) {
            let rect = Bounds {
                origin: point(bounds.origin.x, b.origin.y),
                size: size(bounds.size.width, line_height),
            };
            window.paint_quad(fill(rect, tint));
        }
    }
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
            .child(self.pane(&self.editor_a, &self.changed_a, rgba(REMOVED_TINT).into()))
            .child(div().w(px(1.0)).flex_none().bg(border))
            .child(self.pane(&self.editor_b, &self.changed_b, rgba(ADDED_TINT).into()));

        let body = div().flex().flex_col().flex_1().child(toolbar).child(editors);
        let mut root = div().flex().flex_row().size_full().bg(bg).child(body);
        if self.history_open {
            root = root.child(self.render_drawer(cx));
        }
        root
    }
}

impl DiffView {
    /// Right-side history panel: recent captures, click to restore.
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
