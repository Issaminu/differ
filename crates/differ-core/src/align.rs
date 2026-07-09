//! Side-by-side line alignment. Turns the diff chunks into a sequence of
//! visual rows, each pairing an A line with a B line (or a spacer `None` where
//! one side has no counterpart — a pure insertion or deletion). Rendering these
//! rows in a single scroll region gives correct alignment AND inherently synced
//! scrolling between the two panes.
//!
//! Pure logic (no gpui), so it's unit-tested here.

use crate::Chunk;

/// One visual row: a line index on each side, or `None` for a spacer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlignedRow {
    pub a: Option<u32>,
    pub b: Option<u32>,
    /// True inside a diff chunk (this row participates in a change).
    pub changed: bool,
}

/// Byte offset of each line start (0, then after every '\n'). Its length equals
/// the line count as produced by `text.split('\n')`.
fn line_starts(text: &str) -> Vec<u32> {
    let mut v = vec![0u32];
    for (i, &b) in text.as_bytes().iter().enumerate() {
        if b == b'\n' {
            v.push((i + 1) as u32);
        }
    }
    v
}

/// Map a byte offset (always a line start, per the diff's line-offset model) to
/// its line index. Falls back to the insertion point for an EOF offset with no
/// trailing newline.
fn idx_of(starts: &[u32], off: u32) -> usize {
    starts.binary_search(&off).unwrap_or_else(|e| e)
}

pub fn align(chunks: &[Chunk], a: &str, b: &str) -> Vec<AlignedRow> {
    let sa = line_starts(a);
    let sb = line_starts(b);
    let (a_lines, b_lines) = (sa.len(), sb.len());

    let mut rows = Vec::new();
    let mut ai = 0usize;
    let mut bi = 0usize;

    // Emit an unchanged region from the current (ai, bi) up to (a_end, b_end).
    // Pairs the equal-length common part 1:1, then spacer-pads any residual
    // (defensive — a correct diff makes gaps equal, but line-count mapping at
    // EOF/newline boundaries can leave a remainder; never overshoot or panic).
    let mut emit_unchanged =
        |rows: &mut Vec<AlignedRow>, ai: &mut usize, bi: &mut usize, a_end: usize, b_end: usize| {
            let a_end = a_end.min(a_lines);
            let b_end = b_end.min(b_lines);
            let common = (a_end.saturating_sub(*ai)).min(b_end.saturating_sub(*bi));
            for _ in 0..common {
                rows.push(AlignedRow { a: Some(*ai as u32), b: Some(*bi as u32), changed: false });
                *ai += 1;
                *bi += 1;
            }
            while *ai < a_end {
                rows.push(AlignedRow { a: Some(*ai as u32), b: None, changed: false });
                *ai += 1;
            }
            while *bi < b_end {
                rows.push(AlignedRow { a: None, b: Some(*bi as u32), changed: false });
                *bi += 1;
            }
        };

    for c in chunks {
        let la0 = idx_of(&sa, c.from_a).min(a_lines);
        let la1 = idx_of(&sa, c.end_a).min(a_lines);
        let lb0 = idx_of(&sb, c.from_b).min(b_lines);
        let lb1 = idx_of(&sb, c.end_b).min(b_lines);

        // Unchanged region before this chunk.
        emit_unchanged(&mut rows, &mut ai, &mut bi, la0, lb0);

        // Changed region — pair line-by-line, padding the shorter side with
        // spacers so both panes stay vertically aligned.
        let (na, nb) = (la1.saturating_sub(la0), lb1.saturating_sub(lb0));
        for k in 0..na.max(nb) {
            rows.push(AlignedRow {
                a: (k < na).then_some((la0 + k) as u32),
                b: (k < nb).then_some((lb0 + k) as u32),
                changed: true,
            });
        }
        ai = la1.max(ai);
        bi = lb1.max(bi);
    }

    // Trailing unchanged region — pair the remainder independently.
    emit_unchanged(&mut rows, &mut ai, &mut bi, a_lines, b_lines);

    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{diff_with_changes, fixtures};

    /// Collect the non-spacer line indices for one side, in row order.
    fn side_indices(rows: &[AlignedRow], pick: impl Fn(&AlignedRow) -> Option<u32>) -> Vec<u32> {
        rows.iter().filter_map(|r| pick(r)).collect()
    }

    #[test]
    fn every_line_appears_exactly_once_in_order() {
        // Across all fixtures, each side's line indices must appear 0,1,2,...
        // exactly once (no dropped or duplicated lines from alignment).
        for spec in fixtures::FIXTURES {
            let (a, b) = fixtures::build_fixture(spec);
            let chunks = diff_with_changes(&a, &b);
            let rows = align(&chunks, &a, &b);

            let a_expected: Vec<u32> = (0..a.split('\n').count() as u32).collect();
            let b_expected: Vec<u32> = (0..b.split('\n').count() as u32).collect();
            assert_eq!(side_indices(&rows, |r| r.a), a_expected, "{}: A lines", spec.name);
            assert_eq!(side_indices(&rows, |r| r.b), b_expected, "{}: B lines", spec.name);
        }
    }

    #[test]
    fn no_row_is_entirely_empty() {
        for spec in fixtures::FIXTURES {
            let (a, b) = fixtures::build_fixture(spec);
            let chunks = diff_with_changes(&a, &b);
            for r in align(&chunks, &a, &b) {
                assert!(r.a.is_some() || r.b.is_some(), "{}: empty row", spec.name);
            }
        }
    }

    #[test]
    fn unchanged_rows_pair_identical_text() {
        // A row marked unchanged must reference lines with identical content.
        for spec in fixtures::FIXTURES {
            let (a, b) = fixtures::build_fixture(spec);
            let a_lines: Vec<&str> = a.split('\n').collect();
            let b_lines: Vec<&str> = b.split('\n').collect();
            let chunks = diff_with_changes(&a, &b);
            for r in align(&chunks, &a, &b) {
                if !r.changed {
                    let (ai, bi) = (r.a.unwrap() as usize, r.b.unwrap() as usize);
                    assert_eq!(a_lines[ai], b_lines[bi], "{}: unchanged row differs", spec.name);
                }
            }
        }
    }

    #[test]
    fn pure_insert_has_spacer_on_a() {
        // "x\ny\n" -> "x\nNEW\ny\n": one added line => a row with a==None.
        let a = "x\ny\n";
        let b = "x\nNEW\ny\n";
        let rows = align(&diff_with_changes(a, b), a, b);
        assert!(rows.iter().any(|r| r.a.is_none() && r.b.is_some() && r.changed));
    }

    #[test]
    fn invariant_holds_on_edge_and_edit_cases() {
        // Shapes real edits produce — trailing-newline changes, empty<->content,
        // single line, append/delete. These are what crashed the lockstep tail.
        let cases = [
            ("a\nb\nc\n", "a\nb\nc"),                     // drop trailing newline
            ("a\nb\nc", "a\nb\nc\n"),                     // add trailing newline
            ("", "hello"),                               // empty -> content
            ("hello", ""),                               // content -> empty
            ("x", "x\ny"),                               // 1 line -> 2, no trailing nl
            ("fn main(){}\n", "fn main(){}\nlet z=1;"),  // append line, no trailing nl
            ("line1\nline2\n", "line1\nline2\nline3\n"), // append line w/ trailing nl
            ("a\nb\n", "b\n"),                           // delete first line
            ("a\nb\n", "a\n"),                           // delete last content line
        ];
        for (a, b) in cases {
            let rows = align(&diff_with_changes(a, b), a, b);
            let a_expected: Vec<u32> = (0..a.split('\n').count() as u32).collect();
            let b_expected: Vec<u32> = (0..b.split('\n').count() as u32).collect();
            assert_eq!(side_indices(&rows, |r| r.a), a_expected, "A lines for {a:?} -> {b:?}");
            assert_eq!(side_indices(&rows, |r| r.b), b_expected, "B lines for {a:?} -> {b:?}");
            for r in &rows {
                assert!(r.a.is_some() || r.b.is_some(), "empty row for {a:?} -> {b:?}");
            }
        }
    }
}
