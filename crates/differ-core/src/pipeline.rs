//! The per-edit recompute pipeline — the exact work the app does when a side
//! changes (diff -> stats -> changed lines -> language). Kept here (gpui-free)
//! so it's the single source of truth for both the app and the perf harness:
//! `src/bin/perf.rs` drives `compute` keystroke-by-keystroke on large docs to
//! measure the per-keystroke cost that can freeze typing.

use crate::{
    decorations::{build_decorations, count_changed_lines, Side},
    diff_with_changes,
    lang::detect_language,
    Chunk,
};

/// A changed line on one side: (line index, byte start, byte end-of-content).
pub type ChangedLine = (u32, u32, u32);

/// Everything the diff view derives from the two documents on each edit.
pub struct DiffCompute {
    /// (added lines on B, removed lines on A).
    pub added: usize,
    pub removed: usize,
    pub language: &'static str,
    pub changed_a: Vec<ChangedLine>,
    pub changed_b: Vec<ChangedLine>,
}

/// The changed lines (index + byte range) for one side.
pub fn changed_line_rows(text: &str, chunks: &[Chunk], side: Side) -> Vec<ChangedLine> {
    let deco = build_decorations(side, chunks, text);
    // changed_lines are byte offsets of changed line starts, ascending.
    let mut starts = deco.changed_lines.into_iter().peekable();
    let mut out = Vec::new();
    let mut off = 0u32;
    for (idx, line) in text.split('\n').enumerate() {
        match starts.peek() {
            Some(&s) if s == off => {
                out.push((idx as u32, off, off + line.len() as u32));
                starts.next();
            }
            _ => {}
        }
        off += line.len() as u32 + 1;
    }
    out
}

/// Run the full per-edit recompute for documents `a` (left) and `b` (right).
pub fn compute(a: &str, b: &str) -> DiffCompute {
    let chunks = diff_with_changes(a, b);

    let mut added = 0;
    let mut removed = 0;
    for c in &chunks {
        removed += count_changed_lines(a, c.from_a, c.end_a) as usize;
        added += count_changed_lines(b, c.from_b, c.end_b) as usize;
    }

    let changed_a = changed_line_rows(a, &chunks, Side::A);
    let changed_b = changed_line_rows(b, &chunks, Side::B);

    let sample = if b.len() >= a.len() { b } else { a };
    let language = detect_language(sample);

    DiffCompute { added, removed, language, changed_a, changed_b }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_matches_manual() {
        let a = "one\ntwo\nthree\n";
        let b = "one\nTWO\nthree\nfour\n";
        let c = compute(a, b);
        assert!(c.added >= 1 && c.removed >= 1);
        // changed_b line indices are valid + ascending.
        let mut prev = None;
        for (idx, s, e) in &c.changed_b {
            assert!(s <= e && (*e as usize) <= b.len());
            if let Some(p) = prev {
                assert!(*idx > p);
            }
            prev = Some(*idx);
        }
    }
}
