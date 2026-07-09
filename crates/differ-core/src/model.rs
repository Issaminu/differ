//! The editable diff document model — pure state, no gpui.
//!
//! Owns both sides' text + a cursor per side, applies edits to the active side,
//! and caches the recomputed diff chunks + aligned rows. The gpui `DiffView` is
//! a thin shell over this: it forwards key events to `apply_key`/`paste` and
//! reads `rows()`/`cursor()`/`decorations()` back for rendering.
//!
//! Keeping this gpui-free is what makes the editor headlessly testable — the
//! tests below simulate keystroke sequences (including a 500-edit fuzz) and
//! assert the diff invariants hold after every edit, with no window involved.

use crate::{
    align::{align, AlignedRow},
    decorations::{build_decorations, count_changed_lines, Decorations, Side},
    diff_with_changes,
    lang::detect_language,
    Chunk,
};

/// Max undo depth (older snapshots are dropped).
const MAX_UNDO: usize = 200;

/// Point-in-time document state for undo/redo.
#[derive(Clone)]
struct Snapshot {
    a: String,
    b: String,
    cursor_a: usize,
    cursor_b: usize,
    active: Side,
}

/// What an `apply_key` call did — lets the view decide whether to recompute
/// syntax highlighting (Edited) or just repaint the cursor (Moved).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyOutcome {
    Edited,
    Moved,
    Ignored,
}

pub struct DiffModel {
    a: String,
    b: String,
    cursor_a: usize,
    cursor_b: usize,
    active: Side,
    chunks: Vec<Chunk>,
    rows: Vec<AlignedRow>,
    language: &'static str,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
}

impl DiffModel {
    pub fn new(a: impl Into<String>, b: impl Into<String>) -> Self {
        let a = a.into();
        let b = b.into();
        let cursor_b = b.len(); // start at end of the editable side so typing appends
        let mut m = Self {
            a,
            b,
            cursor_a: 0,
            cursor_b,
            active: Side::B,
            chunks: Vec::new(),
            rows: Vec::new(),
            language: "plaintext",
            undo: Vec::new(),
            redo: Vec::new(),
        };
        m.recompute();
        m
    }

    // --- accessors ---

    pub fn text(&self, side: Side) -> &str {
        match side {
            Side::A => &self.a,
            Side::B => &self.b,
        }
    }

    pub fn cursor(&self, side: Side) -> usize {
        match side {
            Side::A => self.cursor_a,
            Side::B => self.cursor_b,
        }
    }

    pub fn active(&self) -> Side {
        self.active
    }

    /// Auto-detected language id (updated on every edit); the view feeds it to
    /// the syntax highlighter. Unknown ids fall back to plain text.
    pub fn language(&self) -> &'static str {
        self.language
    }

    pub fn set_active(&mut self, side: Side) {
        self.active = side;
    }

    pub fn rows(&self) -> &[AlignedRow] {
        &self.rows
    }

    pub fn chunks(&self) -> &[Chunk] {
        &self.chunks
    }

    pub fn decorations(&self, side: Side) -> Decorations {
        build_decorations(side, &self.chunks, self.text(side))
    }

    /// Line index (0-based) containing the cursor on `side`.
    pub fn cursor_line(&self, side: Side) -> usize {
        let c = self.cursor(side);
        self.text(side)[..c].bytes().filter(|&x| x == b'\n').count()
    }

    // --- editing (acts on the active side) ---

    fn buf_cursor_mut(&mut self) -> (&mut String, &mut usize) {
        match self.active {
            Side::A => (&mut self.a, &mut self.cursor_a),
            Side::B => (&mut self.b, &mut self.cursor_b),
        }
    }

    pub fn insert(&mut self, s: &str) {
        self.record();
        {
            let (buf, cur) = self.buf_cursor_mut();
            buf.insert_str(*cur, s);
            *cur += s.len();
        }
        self.recompute();
    }

    pub fn paste(&mut self, s: &str) {
        self.insert(s);
    }

    pub fn backspace(&mut self) {
        if self.cursor(self.active) == 0 {
            return;
        }
        self.record();
        {
            let (buf, cur) = self.buf_cursor_mut();
            let prev = buf[..*cur].char_indices().next_back().map(|(i, _)| i).unwrap_or(0);
            buf.replace_range(prev..*cur, "");
            *cur = prev;
        }
        self.recompute();
    }

    /// Swap the two sides (and their cursors). Useful when the panes are
    /// reversed — mirrors the toolbar swap.
    pub fn swap(&mut self) {
        self.record();
        std::mem::swap(&mut self.a, &mut self.b);
        std::mem::swap(&mut self.cursor_a, &mut self.cursor_b);
        self.recompute();
    }

    /// Clear both sides.
    pub fn clear(&mut self) {
        self.record();
        self.a.clear();
        self.b.clear();
        self.cursor_a = 0;
        self.cursor_b = 0;
        self.recompute();
    }

    /// (added lines on B, removed lines on A) across all chunks — for the
    /// toolbar's `+N -M` indicator.
    pub fn stats(&self) -> (usize, usize) {
        let mut added = 0;
        let mut removed = 0;
        for c in &self.chunks {
            removed += count_changed_lines(&self.a, c.from_a, c.end_a) as usize;
            added += count_changed_lines(&self.b, c.from_b, c.end_b) as usize;
        }
        (added, removed)
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            a: self.a.clone(),
            b: self.b.clone(),
            cursor_a: self.cursor_a,
            cursor_b: self.cursor_b,
            active: self.active,
        }
    }

    /// Record the pre-edit state for undo; called by every mutating op. Clears
    /// the redo stack (a new edit invalidates the redo history).
    fn record(&mut self) {
        self.undo.push(self.snapshot());
        if self.undo.len() > MAX_UNDO {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    fn restore(&mut self, s: Snapshot) {
        self.a = s.a;
        self.b = s.b;
        self.cursor_a = s.cursor_a;
        self.cursor_b = s.cursor_b;
        self.active = s.active;
        self.recompute();
    }

    pub fn undo(&mut self) -> bool {
        match self.undo.pop() {
            Some(s) => {
                self.redo.push(self.snapshot());
                self.restore(s);
                true
            }
            None => false,
        }
    }

    pub fn redo(&mut self) -> bool {
        match self.redo.pop() {
            Some(s) => {
                self.undo.push(self.snapshot());
                self.restore(s);
                true
            }
            None => false,
        }
    }

    pub fn move_left(&mut self) {
        let (buf, cur) = self.buf_cursor_mut();
        *cur = buf[..*cur].char_indices().next_back().map(|(i, _)| i).unwrap_or(0);
    }

    pub fn move_right(&mut self) {
        let (buf, cur) = self.buf_cursor_mut();
        if *cur < buf.len() {
            *cur = buf[*cur..].char_indices().nth(1).map(|(i, _)| *cur + i).unwrap_or(buf.len());
        }
    }

    /// Apply a (non-modifier) key. `key` is the logical key name ("backspace",
    /// "enter", "left", …); `key_char` is the typed character for printable
    /// keys. Modifier chords (Cmd+V etc.) are handled by the view before this.
    pub fn apply_key(&mut self, key: &str, key_char: Option<&str>) -> KeyOutcome {
        match key {
            "backspace" => {
                self.backspace();
                KeyOutcome::Edited
            }
            "enter" => {
                self.insert("\n");
                KeyOutcome::Edited
            }
            "tab" => {
                self.insert("    ");
                KeyOutcome::Edited
            }
            "space" => {
                self.insert(" ");
                KeyOutcome::Edited
            }
            "left" => {
                self.move_left();
                KeyOutcome::Moved
            }
            "right" => {
                self.move_right();
                KeyOutcome::Moved
            }
            _ => match key_char {
                Some(ch) => {
                    self.insert(ch);
                    KeyOutcome::Edited
                }
                None => KeyOutcome::Ignored,
            },
        }
    }

    fn recompute(&mut self) {
        self.cursor_a = self.cursor_a.min(self.a.len());
        self.cursor_b = self.cursor_b.min(self.b.len());
        self.chunks = diff_with_changes(&self.a, &self.b);
        self.rows = align(&self.chunks, &self.a, &self.b);
        // Detect on the larger side (mirrors the TS: the side with more content
        // is the better sample), so an empty peer doesn't force plaintext.
        let sample = if self.b.len() >= self.a.len() { &self.b } else { &self.a };
        self.language = detect_language(sample);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Simulate typing a string char-by-char through the key path.
    fn type_str(m: &mut DiffModel, s: &str) {
        for ch in s.chars() {
            let cs = ch.to_string();
            m.apply_key(&cs, Some(&cs));
        }
    }

    /// The core invariant after any edit: every line of each side appears
    /// exactly once, in order, across the aligned rows; no row is fully empty.
    fn assert_rows_valid(m: &DiffModel) {
        let a_n = m.text(Side::A).split('\n').count() as u32;
        let b_n = m.text(Side::B).split('\n').count() as u32;
        let a_idx: Vec<u32> = m.rows().iter().filter_map(|r| r.a).collect();
        let b_idx: Vec<u32> = m.rows().iter().filter_map(|r| r.b).collect();
        assert_eq!(a_idx, (0..a_n).collect::<Vec<_>>(), "A lines");
        assert_eq!(b_idx, (0..b_n).collect::<Vec<_>>(), "B lines");
        for r in m.rows() {
            assert!(r.a.is_some() || r.b.is_some(), "empty row");
        }
        assert!(m.cursor(Side::B) <= m.text(Side::B).len(), "cursor OOB");
    }

    #[test]
    fn typing_edits_active_side_and_rediffs() {
        let mut m = DiffModel::new("hello\nworld\n", "hello\nworld\n");
        assert_eq!(m.chunks().len(), 0, "identical inputs -> no chunks");
        type_str(&mut m, "!!!"); // appends to end of B
        assert_eq!(m.text(Side::B), "hello\nworld\n!!!");
        assert!(!m.chunks().is_empty(), "edit should produce a diff");
        assert_rows_valid(&m);
    }

    #[test]
    fn backspace_and_enter_behave() {
        let mut m = DiffModel::new("x\n", "x\n");
        type_str(&mut m, "abc");
        assert_eq!(m.text(Side::B), "x\nabc");
        m.apply_key("backspace", None);
        assert_eq!(m.text(Side::B), "x\nab");
        m.apply_key("enter", None);
        assert_eq!(m.text(Side::B), "x\nab\n");
        assert_rows_valid(&m);
    }

    #[test]
    fn editing_side_a_works() {
        let mut m = DiffModel::new("a\nb\n", "a\nb\n");
        m.set_active(Side::A); // A's cursor starts at 0
        type_str(&mut m, "X");
        assert_eq!(m.text(Side::A), "Xa\nb\n");
        assert_eq!(m.text(Side::B), "a\nb\n", "B must be untouched");
        assert!(!m.chunks().is_empty(), "editing A should produce a diff");
        assert_rows_valid(&m);
    }

    #[test]
    fn paste_inserts_at_cursor() {
        let mut m = DiffModel::new("a\n", "a\n");
        m.paste("pasted\ntext");
        assert_eq!(m.text(Side::B), "a\npasted\ntext");
        assert_rows_valid(&m);
    }

    #[test]
    fn editing_the_real_sample_never_breaks() {
        // The exact scenario that crashed align: type into the shipped sample.
        const A: &str = "fn main() {\n    let x = 1;\n    let y = 2;\n    println!(\"{}\", x);\n    done();\n}\n";
        const B: &str = "fn main() {\n    let x = 10;\n    let y = 2;\n    println!(\"{}\", x);\n    finish();\n}\n";
        let mut m = DiffModel::new(A, B);
        type_str(&mut m, "Now");
        m.apply_key("enter", None);
        type_str(&mut m, "extra();");
        m.apply_key("backspace", None);
        assert_rows_valid(&m);
    }

    #[test]
    fn swap_exchanges_sides() {
        let mut m = DiffModel::new("left\n", "right\n");
        m.swap();
        assert_eq!(m.text(Side::A), "right\n");
        assert_eq!(m.text(Side::B), "left\n");
        assert_rows_valid(&m);
    }

    #[test]
    fn clear_empties_both_sides() {
        let mut m = DiffModel::new("a\nb\n", "c\nd\n");
        m.clear();
        assert_eq!(m.text(Side::A), "");
        assert_eq!(m.text(Side::B), "");
        assert!(m.chunks().is_empty());
    }

    #[test]
    fn stats_counts_added_and_removed() {
        // B replaces one line and adds one: 1 line differs + 1 inserted.
        let mut m = DiffModel::new("keep\nold\n", "keep\nnew\nextra\n");
        let (added, removed) = m.stats();
        assert!(added >= 1 && removed >= 1, "expected changes, got +{added} -{removed}");
        // No-diff => zero.
        m = DiffModel::new("same\n", "same\n");
        assert_eq!(m.stats(), (0, 0));
    }

    #[test]
    fn undo_redo_round_trips() {
        let mut m = DiffModel::new("x\n", "x\n");
        type_str(&mut m, "abc");
        assert_eq!(m.text(Side::B), "x\nabc");
        // Undo the three inserts.
        assert!(m.undo() && m.undo() && m.undo());
        assert_eq!(m.text(Side::B), "x\n");
        assert!(!m.undo(), "nothing left to undo");
        // Redo brings it back.
        assert!(m.redo() && m.redo() && m.redo());
        assert_eq!(m.text(Side::B), "x\nabc");
        assert_rows_valid(&m);
    }

    #[test]
    fn new_edit_clears_redo() {
        let mut m = DiffModel::new("x\n", "x\n");
        type_str(&mut m, "a");
        m.undo();
        type_str(&mut m, "b"); // new edit -> redo of "a" is gone
        assert!(!m.redo(), "redo should be cleared by a new edit");
        assert_eq!(m.text(Side::B), "x\nb");
    }

    #[test]
    fn fuzz_500_edits_never_break_the_invariant() {
        // Deterministic pseudo-random keystroke stream — the headless harness.
        // Would have caught the align tail-drift crash on its own.
        let mut m = DiffModel::new("alpha\nbeta\ngamma\ndelta\n", "alpha\nBETA\ngamma\nDELTA\n");
        let printable = ["a", "z", "1", ")", ";", "{", "}", " ", "\t-no"];
        let special = ["enter", "backspace", "left", "right", "tab", "space"];
        let mut seed = 0x1234_5678u32;
        let mut next = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            seed
        };
        for _ in 0..500 {
            let r = next();
            if r & 1 == 0 {
                m.apply_key(special[(r >> 8) as usize % special.len()], None);
            } else {
                let ch = printable[(r >> 8) as usize % printable.len()];
                m.apply_key(ch, Some(ch));
            }
            assert_rows_valid(&m);
        }
    }
}
