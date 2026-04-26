// Thin wrapper around imara-diff exposed to the Differ frontend.
//
// imara-diff's public API is line-token oriented: `InternedInput::new(a, b)`
// auto-tokenizes both `&str` inputs by line, `Diff::compute` runs the
// algorithm, and `Diff::hunks()` yields edit ranges as line-index intervals
// on each side. We translate those line intervals into character offsets so
// the result drops in to the same call sites that today consume
// `@codemirror/merge`'s `Chunk[]`. Inner character-level changes are emitted
// as an empty array for now — line granularity is enough to confirm whether
// imara's Histogram algorithm is fast enough to obviate the two-pass
// progressive design.

use imara_diff::{Algorithm, Diff, InternedInput};
use serde::Serialize;
use wasm_bindgen::prelude::*;

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
    let input = InternedInput::new(a, b);
    let mut diff_state = Diff::compute(Algorithm::Histogram, &input);
    diff_state.postprocess_lines(&input);

    let a_offsets = line_offsets(a);
    let b_offsets = line_offsets(b);

    let chunks: Vec<Chunk> = diff_state
        .hunks()
        .map(|hunk| {
            let a_start = clamp(hunk.before.start as usize, a_offsets.len() - 1);
            let a_end = clamp(hunk.before.end as usize, a_offsets.len() - 1);
            let b_start = clamp(hunk.after.start as usize, b_offsets.len() - 1);
            let b_end = clamp(hunk.after.end as usize, b_offsets.len() - 1);
            Chunk {
                from_a: a_offsets[a_start],
                end_a: a_offsets[a_end],
                from_b: b_offsets[b_start],
                end_b: b_offsets[b_end],
                changes: Vec::new(),
            }
        })
        .collect();

    serde_wasm_bindgen::to_value(&chunks).map_err(JsValue::from)
}

fn clamp(idx: usize, max: usize) -> usize {
    if idx > max {
        max
    } else {
        idx
    }
}
