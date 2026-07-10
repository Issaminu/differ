//! End-to-end keystroke harness for the *real* editor path.
//!
//! `differ-core`'s `bin/perf` times the diff **pipeline** in isolation. This
//! instead drives the actual [`DiffView`] + gpui-component `InputState` through
//! a headless gpui window: real `insert`s fire the real `InputEvent::Change` ->
//! debounced off-thread recompute -> `apply_compute` -> `set_diff_highlights`
//! path — the same path that panicked at ~15k LOC. These tests are a
//! regression guard for that class of crash and a stability smoke check for
//! typing / pasting on large documents.
//!
//! Requires gpui's `test-support` feature (enabled as a dev-dependency).

#![cfg(test)]

use std::time::{Duration, Instant};

use gpui::{AppContext, Entity, TestAppContext, VisualTestContext, WindowHandle};

use crate::diff_view::DiffView;

/// Comfortably past the 30ms recompute debounce.
const DEBOUNCE_FLUSH: Duration = Duration::from_millis(60);

/// Build a `DiffView` in a headless window. Returns the view entity and the
/// window handle; wrap the handle in a `VisualTestContext` to drive edits.
///
/// Note: we make `DiffView` the window root directly rather than wrapping it in
/// `gpui_component::Root`. `Root::new` installs a macOS accessibility hit-test
/// forwarder that dereferences the real `NSView`, which the headless test
/// platform doesn't back. The editor construction + recompute path exercised
/// here doesn't need Root's overlay layers.
fn open_diff(cx: &mut TestAppContext, a: &str, b: &str) -> (Entity<DiffView>, WindowHandle<DiffView>) {
    let a = a.to_string();
    let b = b.to_string();
    let mut view: Option<Entity<DiffView>> = None;
    let window = cx.update(|cx| {
        cx.open_window(Default::default(), |window, cx| {
            gpui_component::init(cx);
            gpui_component::Theme::change(gpui_component::ThemeMode::Dark, Some(window), cx);
            let v = cx.new(|cx| DiffView::new(&a, &b, window, cx));
            view = Some(v.clone());
            v
        })
        .unwrap()
    });
    (view.unwrap(), window)
}

/// `n` lines of representative source-ish text.
fn make_lines(n: usize) -> String {
    let mut s = String::with_capacity(n * 40);
    for i in 0..n {
        s.push_str(&format!("fn item_{i}(x: i32) -> i32 {{ x + {i} }}\n"));
    }
    s
}

/// Fire the debounce timer and drain both executors so a scheduled recompute
/// runs to completion (timer await -> off-thread compute -> main-thread apply).
fn flush(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.executor().advance_clock(DEBOUNCE_FLUSH);
    cx.run_until_parked();
}

/// Type one string into editor A at the cursor, then let the recompute settle.
fn type_into_a(cx: &mut VisualTestContext, view: &Entity<DiffView>, text: &str) {
    cx.update(|window, app| {
        let editor = view.read(app).editor_a();
        editor.update(app, |ed, cx| ed.insert(text, window, cx));
    });
    flush(cx);
}

/// Type one string into editor B at the cursor, then let the recompute settle.
fn type_into_b(cx: &mut VisualTestContext, view: &Entity<DiffView>, text: &str) {
    cx.update(|window, app| {
        let editor = view.read(app).editor_b();
        editor.update(app, |ed, cx| ed.insert(text, window, cx));
    });
    flush(cx);
}

fn stats(cx: &mut VisualTestContext, view: &Entity<DiffView>) -> (usize, usize) {
    cx.update(|_, app| view.read(app).stats())
}

fn change_counts(cx: &mut VisualTestContext, view: &Entity<DiffView>) -> (usize, usize) {
    cx.update(|_, app| view.read(app).change_counts())
}

fn editor_a_len(cx: &mut VisualTestContext, view: &Entity<DiffView>) -> usize {
    cx.update(|_, app| view.read(app).editor_a().read(app).value().len())
}

fn value_a(cx: &mut VisualTestContext, view: &Entity<DiffView>) -> String {
    cx.update(|_, app| view.read(app).editor_a().read(app).value().to_string())
}

fn value_b(cx: &mut VisualTestContext, view: &Entity<DiffView>) -> String {
    cx.update(|_, app| view.read(app).editor_b().read(app).value().to_string())
}

#[gpui::test]
fn e2e_typing_on_large_document_stays_stable(cx: &mut TestAppContext) {
    // ~8k lines, a handful of pre-existing differences on side B.
    let a = make_lines(8_000);
    let b = a
        .replace("x + 100 }", "x + 9001 }")
        .replace("x + 4000 }", "x + 9002 }")
        .replace("x + 7999 }", "x + 9003 }");
    let (view, window) = open_diff(cx, &a, &b);
    let mut cx = VisualTestContext::from_window(window.into(), cx);

    // Baseline diff computed synchronously in DiffView::new.
    let (base_added, base_removed) = stats(&mut cx, &view);
    assert!(base_added + base_removed > 0, "expected some baseline diff");

    let start_len = editor_a_len(&mut cx, &view);

    // 50 real keystrokes at the cursor, each triggering the full recompute path.
    let t = Instant::now();
    for _ in 0..50 {
        type_into_a(&mut cx, &view, "x");
    }
    let elapsed = t.elapsed();

    // Survived without panicking, edits landed, diff still reflects changes.
    assert_eq!(editor_a_len(&mut cx, &view), start_len + 50, "all 50 keystrokes should have landed");
    let (added, _) = stats(&mut cx, &view);
    let (changes_a, _) = change_counts(&mut cx, &view);
    assert!(added > 0 && changes_a > 0, "typed edits should register as changes");

    eprintln!("[e2e] 50 keystrokes @ 8k lines settled in {elapsed:?} (virtual clock)");
}

#[gpui::test]
fn e2e_edits_introduce_changes(cx: &mut TestAppContext) {
    // Identical inputs -> zero changes to start.
    let text = make_lines(500);
    let (view, window) = open_diff(cx, &text, &text);
    let mut cx = VisualTestContext::from_window(window.into(), cx);

    assert_eq!(stats(&mut cx, &view), (0, 0), "identical inputs => no diff");
    assert_eq!(change_counts(&mut cx, &view), (0, 0));

    // Diverge side A -> a change should appear.
    type_into_a(&mut cx, &view, "// diverged");
    let (changes_a, _) = change_counts(&mut cx, &view);
    assert!(changes_a > 0, "editing A should introduce a change");
}

#[gpui::test]
fn e2e_editing_side_b_registers_changes(cx: &mut TestAppContext) {
    let text = make_lines(300);
    let (view, window) = open_diff(cx, &text, &text);
    let mut cx = VisualTestContext::from_window(window.into(), cx);
    assert_eq!(change_counts(&mut cx, &view), (0, 0));

    // Edit the right pane -> a change should register on the B side.
    type_into_b(&mut cx, &view, "// changed on B");
    let (_, changes_b) = change_counts(&mut cx, &view);
    assert!(changes_b > 0, "editing B should introduce a change on the B side");
}

#[gpui::test]
fn e2e_swap_sides_swaps_content(cx: &mut TestAppContext) {
    let (view, window) = open_diff(cx, "left\n", "right\n");
    let mut cx = VisualTestContext::from_window(window.into(), cx);
    assert_eq!(value_a(&mut cx, &view), "left\n");
    assert_eq!(value_b(&mut cx, &view), "right\n");

    cx.update(|window, app| view.update(app, |v, cx| v.swap_for_test(window, cx)));
    cx.run_until_parked();

    assert_eq!(value_a(&mut cx, &view), "right\n");
    assert_eq!(value_b(&mut cx, &view), "left\n");
}

#[gpui::test]
fn e2e_clear_empties_both(cx: &mut TestAppContext) {
    let (view, window) = open_diff(cx, "aaa\n", "bbb\n");
    let mut cx = VisualTestContext::from_window(window.into(), cx);
    assert!(stats(&mut cx, &view).0 + stats(&mut cx, &view).1 > 0);

    cx.update(|window, app| view.update(app, |v, cx| v.clear_for_test(window, cx)));
    cx.run_until_parked();

    assert_eq!(value_a(&mut cx, &view), "");
    assert_eq!(value_b(&mut cx, &view), "");
    assert_eq!(stats(&mut cx, &view), (0, 0));
    assert_eq!(change_counts(&mut cx, &view), (0, 0));
}

#[gpui::test]
fn e2e_language_override_cycle(cx: &mut TestAppContext) {
    let src = "fn main() { let x = 1; }\n";
    let (view, window) = open_diff(cx, src, src);
    let mut cx = VisualTestContext::from_window(window.into(), cx);
    assert_eq!(cx.update(|_, app| view.read(app).manual_language()), None);

    // First cycle past Auto lands on Plain Text ("text"), which drives the
    // effective language and disables highlighting.
    cx.update(|_, app| view.update(app, |v, cx| v.cycle_language_for_test(cx)));
    assert_eq!(cx.update(|_, app| view.read(app).manual_language()), Some("text"));
    assert_eq!(cx.update(|_, app| view.read(app).language()), "text");

    // Next cycle lands on Rust.
    cx.update(|_, app| view.update(app, |v, cx| v.cycle_language_for_test(cx)));
    assert_eq!(cx.update(|_, app| view.read(app).manual_language()), Some("rust"));
    assert_eq!(cx.update(|_, app| view.read(app).language()), "rust");
}

#[gpui::test]
fn e2e_rapid_edits_coalesce(cx: &mut TestAppContext) {
    // Fire a burst of inserts with NO settle between them, exercising the
    // generation-guarded debounce: superseded recomputes must drop and only the
    // final state applies — no panic, no stale diff.
    let (view, window) = open_diff(cx, "", "");
    let mut cx = VisualTestContext::from_window(window.into(), cx);

    cx.update(|window, app| {
        let editor = view.read(app).editor_a();
        for _ in 0..100 {
            editor.update(app, |ed, cx| ed.insert("a", window, cx));
        }
    });
    flush(&mut cx);

    // All 100 chars landed and the diff reflects the final state exactly once.
    assert_eq!(editor_a_len(&mut cx, &view), 100);
    let (_, removed) = stats(&mut cx, &view);
    let (changes_a, _) = change_counts(&mut cx, &view);
    assert!(removed > 0 && changes_a > 0, "final state should show A-only content as a change");
}

#[gpui::test]
fn e2e_paste_large_document(cx: &mut TestAppContext) {
    // Start tiny, then paste a big document in one insert (fires Change like a
    // real clipboard paste) — the scenario that previously froze/crashed.
    let (view, window) = open_diff(cx, "seed\n", "seed\n");
    let mut cx = VisualTestContext::from_window(window.into(), cx);

    let pasted = make_lines(12_000);
    let t = Instant::now();
    type_into_a(&mut cx, &view, &pasted);
    let elapsed = t.elapsed();

    // A 12k-line paste against a 1-line side => large diff, no panic. The
    // pasted content lives only on side A, so it shows up as "removed".
    let (added, removed) = stats(&mut cx, &view);
    let (changes_a, _) = change_counts(&mut cx, &view);
    assert!(added + removed > 1_000, "big paste should register a large diff (stats={added},{removed})");
    assert!(changes_a > 0);
    eprintln!("[e2e] 12k-line paste settled in {elapsed:?} (virtual clock)");
}
