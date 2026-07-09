//! Native core of Differ's diff engine.
//!
//! This is a direct port of the algorithm in `crates/diff-wasm/src/lib.rs`,
//! with the `wasm-bindgen` / `js-sys` / `serde-wasm-bindgen` glue removed.
//! Instead of packing results into a JS `Int32Array` across the WASM boundary,
//! it returns plain Rust `Vec<Chunk>` for the GPUI frontend to consume
//! in-process. The algorithm, byte-offset model, and the inner byte-level pass
//! are identical, so output matches the shipping WASM diff.
//!
//! Positions are byte offsets into the UTF-8 input, matching the WASM crate.

use imara_diff::{Algorithm, Diff, InternedInput, Interner};

pub mod align;
pub mod decorations;
pub mod fixtures;
pub mod lang;
pub mod model;

/// Per-chunk size cap for the inner byte-level diff. Above this the inner pass
/// is skipped (chunk gets `changes: []`). See the WASM crate for the rationale
/// (large chunks are wholesale replacements where char highlights aren't useful
/// UX, and the inner Histogram diff hits the same N×D pathology on disjoint
/// inputs).
pub const INNER_DIFF_BYTE_LIMIT: u32 = 16 * 1024;

/// A character-level edit inside a chunk. Offsets are relative to the chunk
/// start on each side (matching CM-merge's `Chunk.changes` shape).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Change {
    pub from_a: u32,
    pub to_a: u32,
    pub from_b: u32,
    pub to_b: u32,
}

/// A line-level diff hunk. `from`/`end` are byte offsets into the respective
/// UTF-8 input; `[from_a, end_a)` on side A is replaced by `[from_b, end_b)` on
/// side B.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub from_a: u32,
    pub end_a: u32,
    pub from_b: u32,
    pub end_b: u32,
    pub changes: Vec<Change>,
}

/// Line-level diff only (empty `changes` on every chunk).
pub fn diff(a: &str, b: &str) -> Vec<Chunk> {
    diff_inner(a, b, false)
}

/// Line-level diff plus a byte-level inner pass filling `changes`.
pub fn diff_with_changes(a: &str, b: &str) -> Vec<Chunk> {
    diff_inner(a, b, true)
}

/// Returns one entry per line plus a final entry equal to `s.len()`. Line `k`
/// occupies the byte range `offsets[k]..offsets[k + 1]`.
fn line_offsets(s: &str) -> Vec<u32> {
    let mut offsets: Vec<u32> = Vec::with_capacity(s.len() / 32 + 2);
    offsets.push(0);
    let bytes = s.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' {
            offsets.push((i + 1) as u32);
        }
    }
    offsets.push(bytes.len() as u32);
    offsets
}

fn diff_inner(a: &str, b: &str, with_changes: bool) -> Vec<Chunk> {
    let input = InternedInput::new(a, b);
    let mut diff_state = Diff::compute(Algorithm::Histogram, &input);
    diff_state.postprocess_lines(&input);

    let a_offsets = line_offsets(a);
    let b_offsets = line_offsets(b);
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();

    // Reuse one Interner across all inner passes — every inner diff calls
    // `clear()` first so capacity is amortised but no leak.
    let mut inner_interner: Interner<u8> = Interner::new(0);

    diff_state
        .hunks()
        .map(|hunk| {
            let a_start = clamp(hunk.before.start as usize, a_offsets.len() - 1);
            let a_end = clamp(hunk.before.end as usize, a_offsets.len() - 1);
            let b_start = clamp(hunk.after.start as usize, b_offsets.len() - 1);
            let b_end = clamp(hunk.after.end as usize, b_offsets.len() - 1);

            let from_a = a_offsets[a_start];
            let end_a = a_offsets[a_end];
            let from_b = b_offsets[b_start];
            let end_b = b_offsets[b_end];

            let changes = if with_changes
                && from_a < end_a
                && from_b < end_b
                && (end_a - from_a) <= INNER_DIFF_BYTE_LIMIT
                && (end_b - from_b) <= INNER_DIFF_BYTE_LIMIT
            {
                let a_slice = &a_bytes[from_a as usize..end_a as usize];
                let b_slice = &b_bytes[from_b as usize..end_b as usize];
                inner_byte_diff(a_slice, b_slice, &mut inner_interner)
            } else {
                Vec::new()
            };

            Chunk {
                from_a,
                end_a,
                from_b,
                end_b,
                changes,
            }
        })
        .collect()
}

/// Byte-level inner diff for one line-hunk. Emits each inner edit as a `Change`
/// with offsets relative to the chunk start on each side.
fn inner_byte_diff(a: &[u8], b: &[u8], interner: &mut Interner<u8>) -> Vec<Change> {
    interner.clear();
    let mut input: InternedInput<u8> = InternedInput {
        before: Vec::with_capacity(a.len()),
        after: Vec::with_capacity(b.len()),
        interner: std::mem::take(interner),
    };
    input.update_before(a.iter().copied());
    input.update_after(b.iter().copied());

    let diff_state = Diff::compute(Algorithm::Histogram, &input);

    let changes = diff_state
        .hunks()
        .map(|hunk| Change {
            from_a: hunk.before.start,
            to_a: hunk.before.end,
            from_b: hunk.after.start,
            to_b: hunk.after.end,
        })
        .collect();

    // Hand the interner back so the caller's allocation amortises across chunks.
    *interner = input.interner;
    changes
}

fn clamp(idx: usize, max: usize) -> usize {
    if idx > max {
        max
    } else {
        idx
    }
}

/// Stateful diff session mirroring the WASM crate's `DiffSession`, minus the
/// packed-buffer marshalling (there's no boundary to cross natively). Owns the
/// current A/B contents so a per-keystroke recompute only re-sets the side that
/// changed; the incremental win here is skipping the string move, same as WASM.
#[derive(Default)]
pub struct DiffSession {
    a: String,
    b: String,
}

impl DiffSession {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_a(&mut self, text: String) {
        self.a = text;
    }

    pub fn set_b(&mut self, text: String) {
        self.b = text;
    }

    pub fn compute(&self, with_changes: bool) -> Vec<Chunk> {
        diff_inner(&self.a, &self.b, with_changes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_inputs_have_no_chunks() {
        let s = "alpha\nbeta\ngamma\n";
        assert!(diff_with_changes(s, s).is_empty());
    }

    #[test]
    fn single_line_change_is_one_chunk() {
        let a = "one\ntwo\nthree\n";
        let b = "one\nTWO\nthree\n";
        let chunks = diff(a, b);
        assert_eq!(chunks.len(), 1);
        let c = &chunks[0];
        // The changed hunk covers the "two" / "TWO" line only.
        assert_eq!(&a[c.from_a as usize..c.end_a as usize], "two\n");
        assert_eq!(&b[c.from_b as usize..c.end_b as usize], "TWO\n");
    }

    #[test]
    fn inner_changes_are_within_chunk_bounds() {
        let a = "the quick brown fox\n";
        let b = "the quick red fox\n";
        let chunks = diff_with_changes(a, b);
        assert_eq!(chunks.len(), 1);
        let c = &chunks[0];
        assert!(!c.changes.is_empty(), "expected inner char-level changes");
        let span_a = c.end_a - c.from_a;
        let span_b = c.end_b - c.from_b;
        for ch in &c.changes {
            assert!(ch.to_a <= span_a, "change A offset out of chunk bounds");
            assert!(ch.to_b <= span_b, "change B offset out of chunk bounds");
            assert!(ch.from_a <= ch.to_a);
            assert!(ch.from_b <= ch.to_b);
        }
    }

    /// The load-bearing invariant: applying every chunk (replace A's byte range
    /// with B's byte range) must reconstruct B exactly. This is what proves the
    /// line-offset translation is correct across all fixture shapes.
    fn apply_chunks_reconstructs_b(a: &str, b: &str) {
        let chunks = diff(a, b);
        let mut out = String::with_capacity(b.len());
        let mut cursor = 0usize; // byte cursor into A
        for c in &chunks {
            // Copy the unchanged A span before this chunk...
            out.push_str(&a[cursor..c.from_a as usize]);
            // ...then the chunk's B content.
            out.push_str(&b[c.from_b as usize..c.end_b as usize]);
            cursor = c.end_a as usize;
        }
        out.push_str(&a[cursor..]);
        assert_eq!(out, b, "applying chunks did not reconstruct B");
    }

    #[test]
    fn reconstruction_holds_across_all_fixtures() {
        for spec in fixtures::FIXTURES {
            let (a, b) = fixtures::build_fixture(spec);
            apply_chunks_reconstructs_b(&a, &b);
        }
    }

    #[test]
    fn chunks_are_ordered_and_non_overlapping() {
        for spec in fixtures::FIXTURES {
            let (a, b) = fixtures::build_fixture(spec);
            let chunks = diff_with_changes(&a, &b);
            let mut prev_end_a = 0u32;
            let mut prev_end_b = 0u32;
            for c in &chunks {
                assert!(c.from_a >= prev_end_a, "{}: chunk A overlaps previous", spec.name);
                assert!(c.from_b >= prev_end_b, "{}: chunk B overlaps previous", spec.name);
                assert!(c.from_a <= c.end_a && c.from_b <= c.end_b);
                assert!(c.end_a <= a.len() as u32 && c.end_b <= b.len() as u32);
                prev_end_a = c.end_a;
                prev_end_b = c.end_b;
            }
        }
    }
}
