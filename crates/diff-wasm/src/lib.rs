// Thin wrapper around imara-diff exposed to the Differ frontend.
//
// imara-diff's public API is line-token oriented: `InternedInput::new(a, b)`
// auto-tokenizes both `&str` inputs by line, `Diff::compute` runs the
// algorithm, and `Diff::hunks()` yields edit ranges as line-index intervals
// on each side. We translate those line intervals into character offsets so
// the result drops in to the same call sites that today consume
// `@codemirror/merge`'s `Chunk[]`.
//
// `diff` returns line-level chunks only (empty `changes`).
// `diff_with_changes` runs a second imara pass byte-level inside each
// chunk's text range to fill `changes`, matching CM-merge's character-level
// inner-highlight surface.
//
// Note: positions are byte offsets into the UTF-8 input. For ASCII inputs
// these are equivalent to JavaScript's UTF-16 code unit offsets that
// CodeMirror consumes; for non-ASCII content we'd need a byte→UTF-16 map.
// Tracked as a follow-up — Differ's current fixtures are ASCII.

use imara_diff::{Algorithm, Diff, InternedInput, Interner};
use serde::Serialize;
use wasm_bindgen::prelude::*;

// Per-chunk size cap for the inner byte-level diff. Above this the inner
// pass is skipped (chunk gets `changes: []`). When a chunk is this large,
// it almost always represents a wholesale block replacement where character
// highlights aren't useful UX anyway, and the byte-level Histogram diff hits
// the same N×D pathology that line-level diff has on disjoint inputs (one
// 70 KB disjoint chunk on `medium/disjoint` ran ~3.3 s before this cap).
const INNER_DIFF_BYTE_LIMIT: u32 = 16 * 1024;

#[derive(Serialize)]
struct Change {
    #[serde(rename = "fromA")]
    from_a: u32,
    #[serde(rename = "toA")]
    to_a: u32,
    #[serde(rename = "fromB")]
    from_b: u32,
    #[serde(rename = "toB")]
    to_b: u32,
}

#[derive(Serialize)]
struct Chunk {
    #[serde(rename = "fromA")]
    from_a: u32,
    #[serde(rename = "endA")]
    end_a: u32,
    #[serde(rename = "fromB")]
    from_b: u32,
    #[serde(rename = "endB")]
    end_b: u32,
    changes: Vec<Change>,
}

// Returns one entry per line plus a final entry equal to `s.len()`. Line `k`
// occupies the byte range `offsets[k]..offsets[k + 1]`. imara reports line
// indices that may include a trailing-empty-line index, which is why we
// always push `s.len()` at the end.
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

#[wasm_bindgen]
pub fn diff(a: &str, b: &str) -> Result<JsValue, JsValue> {
    diff_inner(a, b, false)
}

#[wasm_bindgen]
pub fn diff_with_changes(a: &str, b: &str) -> Result<JsValue, JsValue> {
    diff_inner(a, b, true)
}

fn diff_inner(a: &str, b: &str, with_changes: bool) -> Result<JsValue, JsValue> {
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

    let chunks: Vec<Chunk> = diff_state
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
        .collect();

    serde_wasm_bindgen::to_value(&chunks).map_err(JsValue::from)
}

// Byte-level inner diff for one line-hunk. Emits each inner edit as a
// `Change` with offsets *relative to the chunk start* on each side, matching
// CM-merge's `Chunk.changes` shape.
fn inner_byte_diff(
    a: &[u8],
    b: &[u8],
    interner: &mut Interner<u8>,
) -> Vec<Change> {
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

    // Hand the interner back so the caller's allocation amortises across
    // chunks.
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
