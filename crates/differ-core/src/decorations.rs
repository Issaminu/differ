//! Chunk → decoration mapping. Port of `src/merge/diffDecorations.ts`.
//!
//! The GPUI view consumes plain byte-offset data instead of CodeMirror's
//! `DecorationSet`/`RangeSet`: a list of changed-line starts (for the line
//! background tint + gutter marker) and char-level changed spans (for the
//! inner highlight). Semantics — the viewport range clipping and the
//! newline-scanning line walk — match the TS.
//!
//! ONE intentional divergence: the TS line walk uses `lineFrom <= max`, which
//! also emits a decoration at `to` itself. Since a chunk's end offset is a line
//! *start* (the first unchanged line after the chunk), that over-tints one
//! trailing unchanged line on every modify/delete chunk. We emit the documented
//! half-open `[from, to)` set instead (line starts strictly `< to`), which
//! matches the author's own `countChangedLines` and the code comment. See the
//! `chunk_ending_on_boundary` test.

use crate::Chunk;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    A,
    B,
}

/// Decorations for one side, clipped to a byte range. `changed_lines` holds the
/// byte offset of each changed line's start (used for both the line tint and
/// the gutter marker); `changed_spans` holds char-level `[from, to)` byte
/// ranges within those lines.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Decorations {
    pub changed_lines: Vec<u32>,
    pub changed_spans: Vec<(u32, u32)>,
}

#[inline]
fn from_on_side(side: Side, c: &Chunk) -> u32 {
    match side {
        Side::A => c.from_a,
        Side::B => c.from_b,
    }
}

#[inline]
fn to_on_side(side: Side, c: &Chunk) -> u32 {
    match side {
        Side::A => c.end_a,
        Side::B => c.end_b,
    }
}

/// Index of the next `\n` at or after `pos` in `text`'s bytes, or `None`.
#[inline]
fn next_newline(bytes: &[u8], pos: usize) -> Option<usize> {
    bytes[pos..].iter().position(|&b| b == b'\n').map(|i| pos + i)
}

/// Full-document variant (no viewport clip).
pub fn build_decorations(side: Side, chunks: &[Chunk], text: &str) -> Decorations {
    build_decorations_ranged(side, chunks, text, 0, u32::MAX)
}

/// Translate chunks → decorations for `side`, emitting only entries that
/// intersect `[range_from, range_to)` (byte offsets). Mirrors `buildDecorations`.
pub fn build_decorations_ranged(
    side: Side,
    chunks: &[Chunk],
    text: &str,
    range_from: u32,
    range_to: u32,
) -> Decorations {
    let bytes = text.as_bytes();
    let text_len = bytes.len() as u32;
    let mut out = Decorations::default();

    for c in chunks {
        let from = from_on_side(side, c);
        let to = to_on_side(side, c);
        // Empty on this side → nothing to draw (highlighted on the peer side).
        if to <= from {
            continue;
        }
        if to <= range_from || from >= range_to {
            continue;
        }

        let max = to.min(text_len);
        // Each line start in [from, to) on this side gets a changed-line entry.
        // The `line_from < max` guard keeps it half-open (see module docs).
        let mut line_from = from;
        while line_from <= max {
            if line_from < max && line_from >= range_from && line_from < range_to {
                out.changed_lines.push(line_from);
            }
            match next_newline(bytes, line_from as usize) {
                Some(nl) if (nl as u32) < max => line_from = nl as u32 + 1,
                _ => break,
            }
        }

        // Char-level inner changes — offsets in `Change` are relative to the
        // chunk start on each side, so shift by `from`.
        for ch in &c.changes {
            let (rel_from, rel_to) = match side {
                Side::A => (ch.from_a, ch.to_a),
                Side::B => (ch.from_b, ch.to_b),
            };
            let inner_from = rel_from + from;
            let inner_to = rel_to + from;
            if inner_to > inner_from && inner_from < range_to && inner_to > range_from {
                out.changed_spans.push((inner_from, inner_to));
            }
        }
    }

    out
}

/// Byte offsets of changed-line starts for the gutter. Mirrors
/// `buildGutterRangeSet` (same line walk as `build_decorations`, lines only).
pub fn build_gutter(side: Side, chunks: &[Chunk], text: &str) -> Vec<u32> {
    build_gutter_ranged(side, chunks, text, 0, u32::MAX)
}

pub fn build_gutter_ranged(
    side: Side,
    chunks: &[Chunk],
    text: &str,
    range_from: u32,
    range_to: u32,
) -> Vec<u32> {
    let bytes = text.as_bytes();
    let text_len = bytes.len() as u32;
    let mut lines = Vec::new();

    for c in chunks {
        let from = from_on_side(side, c);
        let to = to_on_side(side, c);
        if to <= from || to <= range_from || from >= range_to {
            continue;
        }
        let max = to.min(text_len);
        let mut line_from = from;
        while line_from <= max {
            if line_from < max && line_from >= range_from && line_from < range_to {
                lines.push(line_from);
            }
            match next_newline(bytes, line_from as usize) {
                Some(nl) if (nl as u32) < max => line_from = nl as u32 + 1,
                _ => break,
            }
        }
    }
    lines
}

/// Count newline-separated lines in `text` covered by `[from, end)`. A
/// non-empty range covers at least one line; each `\n` inside starts another.
/// Mirrors `countChangedLines`.
pub fn count_changed_lines(text: &str, from: u32, end: u32) -> u32 {
    if end <= from || text.is_empty() {
        return 0;
    }
    let bytes = text.as_bytes();
    let stop = (end - 1).min(bytes.len() as u32);
    let mut count = 1;
    let mut pos = from;
    while pos < stop {
        match next_newline(bytes, pos as usize) {
            Some(nl) if (nl as u32) < stop => {
                count += 1;
                pos = nl as u32 + 1;
            }
            _ => break,
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{diff_with_changes, fixtures};

    #[test]
    fn changed_line_starts_are_real_line_starts() {
        // Every emitted changed-line offset must be 0 or immediately follow a
        // '\n' — i.e. an actual line start in the text.
        for spec in fixtures::FIXTURES {
            let (a, b) = fixtures::build_fixture(spec);
            let chunks = diff_with_changes(&a, &b);
            for (side, text) in [(Side::A, &a), (Side::B, &b)] {
                let bytes = text.as_bytes();
                let deco = build_decorations(side, &chunks, text);
                for &ls in &deco.changed_lines {
                    assert!(
                        ls == 0 || bytes[ls as usize - 1] == b'\n',
                        "{}: changed line {ls} is not a line start",
                        spec.name
                    );
                }
            }
        }
    }

    #[test]
    fn char_spans_stay_within_the_text() {
        for spec in fixtures::FIXTURES {
            let (a, b) = fixtures::build_fixture(spec);
            let chunks = diff_with_changes(&a, &b);
            for (side, text) in [(Side::A, &a), (Side::B, &b)] {
                let deco = build_decorations(side, &chunks, text);
                for (f, t) in &deco.changed_spans {
                    assert!(f < t && *t <= text.len() as u32, "{}: span out of range", spec.name);
                }
            }
        }
    }

    #[test]
    fn gutter_matches_decoration_lines() {
        // The gutter walk and the decoration line walk must agree.
        for spec in fixtures::FIXTURES {
            let (a, b) = fixtures::build_fixture(spec);
            let chunks = diff_with_changes(&a, &b);
            for (side, text) in [(Side::A, &a), (Side::B, &b)] {
                let deco = build_decorations(side, &chunks, text);
                let gutter = build_gutter(side, &chunks, text);
                assert_eq!(deco.changed_lines, gutter, "{}: gutter/deco line mismatch", spec.name);
            }
        }
    }

    #[test]
    fn count_changed_lines_matches_the_line_walk() {
        // count_changed_lines over a chunk's span must equal the number of
        // changed-line entries build_decorations emits for that chunk.
        let (a, b) = fixtures::build_fixture(&fixtures::FIXTURES[0]);
        let chunks = diff_with_changes(&a, &b);
        for c in &chunks {
            if c.end_b > c.from_b {
                let deco_lines = {
                    let d = build_decorations(Side::B, std::slice::from_ref(c), &b);
                    d.changed_lines.len() as u32
                };
                assert_eq!(count_changed_lines(&b, c.from_b, c.end_b), deco_lines);
            }
        }
    }

    #[test]
    fn viewport_clip_is_a_subset_of_full() {
        // Clipping to a window must never emit a line outside the window, and
        // every clipped line must be present in the full set.
        let (a, b) = fixtures::build_fixture(&fixtures::FIXTURES[6]); // medium/char-edits
        let chunks = diff_with_changes(&a, &b);
        let full = build_decorations(Side::B, &chunks, &b);
        let (from, to) = (1000u32, 5000u32);
        let clipped = build_decorations_ranged(Side::B, &chunks, &b, from, to);
        for &ls in &clipped.changed_lines {
            assert!(ls >= from && ls < to, "clipped line {ls} outside window");
            assert!(full.changed_lines.contains(&ls), "clipped line {ls} missing from full set");
        }
    }

    #[test]
    fn chunk_ending_on_boundary_does_not_over_tint() {
        // Regression for the shipping TS off-by-one (empirically confirmed):
        // a chunk covering ONLY line 0 of "x\ny\nz\n" (from_b=0, end_b=2) must
        // decorate only line 0 — not the unchanged "y" line whose start == end_b.
        let text = "x\ny\nz\n";
        let chunk = Chunk { from_a: 0, end_a: 2, from_b: 0, end_b: 2, changes: vec![] };
        assert_eq!(build_decorations(Side::B, std::slice::from_ref(&chunk), text).changed_lines, vec![0]);
        assert_eq!(build_gutter(Side::B, std::slice::from_ref(&chunk), text), vec![0]);
    }
}
