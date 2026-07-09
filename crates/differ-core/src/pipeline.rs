//! The per-edit recompute pipeline — the exact work the app does when a side
//! changes (diff -> stats -> tint spans -> language). Kept here (gpui-free) so
//! it's the single source of truth for both the app and the perf harness
//! (`src/bin/perf.rs`), which drives `compute` keystroke-by-keystroke.

use std::ops::Range;

use crate::{
    decorations::{build_decorations, count_changed_lines, Side},
    diff_with_changes,
    lang::detect_language,
    Chunk,
};

/// A tint region: whole changed line vs the exact changed characters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TintKind {
    Line,
    Char,
}

/// A tint span (byte range) + its kind. Spans are non-overlapping and sorted.
pub type Tint = (Range<usize>, TintKind);

/// Everything the diff view derives from the two documents on each edit.
pub struct DiffCompute {
    /// (added lines on B, removed lines on A).
    pub added: usize,
    pub removed: usize,
    pub language: &'static str,
    pub tints_a: Vec<Tint>,
    pub tints_b: Vec<Tint>,
}

/// Build non-overlapping tint spans for one side: each changed line is tinted
/// `Line`, except the exact changed characters within it, which are tinted
/// `Char`. A moving pointer over the (sorted) char spans keeps this O(n).
fn build_tints(text: &str, chunks: &[Chunk], side: Side) -> Vec<Tint> {
    let deco = build_decorations(side, chunks, text);
    let changed: std::collections::HashSet<u32> = deco.changed_lines.iter().copied().collect();
    let mut char_spans = deco.changed_spans; // absolute (u32, u32), ascending
    char_spans.sort_unstable();

    let mut out = Vec::new();
    let mut ci = 0usize; // first char span that might still be relevant
    let mut off = 0u32;
    for line in text.split('\n') {
        let (ls, le) = (off, off + line.len() as u32);
        if changed.contains(&ls) {
            // Drop char spans that end at/before this line.
            while ci < char_spans.len() && char_spans[ci].1 <= ls {
                ci += 1;
            }
            let mut cursor = ls;
            let mut k = ci;
            while k < char_spans.len() && char_spans[k].0 < le {
                let (cs, ce) = char_spans[k];
                let (s, e) = (cs.max(ls), ce.min(le));
                if s < e {
                    if s > cursor {
                        out.push((cursor as usize..s as usize, TintKind::Line));
                    }
                    out.push((s as usize..e as usize, TintKind::Char));
                    cursor = e;
                }
                k += 1;
            }
            if cursor < le {
                out.push((cursor as usize..le as usize, TintKind::Line));
            }
        }
        off = le + 1;
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

    let tints_a = build_tints(a, &chunks, Side::A);
    let tints_b = build_tints(b, &chunks, Side::B);

    let sample = if b.len() >= a.len() { b } else { a };
    let language = detect_language(sample);

    DiffCompute { added, removed, language, tints_a, tints_b }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_produces_stats_and_tints() {
        let a = "one\ntwo\nthree\n";
        let b = "one\nTWO\nthree\nfour\n";
        let c = compute(a, b);
        assert!(c.added >= 1 && c.removed >= 1);
        assert!(!c.tints_b.is_empty());
    }

    /// Tints must be non-overlapping, sorted, and within bounds — the editor's
    /// combine_highlights needs that (overlapping same-field styles are
    /// nondeterministic).
    #[test]
    fn tints_are_non_overlapping_and_in_bounds() {
        for spec in crate::fixtures::FIXTURES {
            let (a, b) = crate::fixtures::build_fixture(spec);
            let c = compute(&a, &b);
            for (label, tints, len) in [("a", &c.tints_a, a.len()), ("b", &c.tints_b, b.len())] {
                let mut prev_end = 0usize;
                for (r, _) in tints {
                    assert!(r.start < r.end, "{}: empty tint in {label}", spec.name);
                    assert!(r.end <= len, "{}: tint out of bounds in {label}", spec.name);
                    assert!(r.start >= prev_end, "{}: overlapping/unsorted tint in {label}", spec.name);
                    prev_end = r.end;
                }
            }
        }
    }

    #[test]
    fn char_tint_marks_the_changed_word() {
        // Single-word change should yield a Char tint over that word.
        let a = "the quick brown fox\n";
        let b = "the quick red fox\n";
        let c = compute(a, b);
        assert!(c.tints_b.iter().any(|(_, k)| *k == TintKind::Char), "expected a char-level tint");
    }
}
