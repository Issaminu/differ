//! Synthetic diff fixtures — a faithful Rust port of `bench/fixtures.ts`.
//!
//! Uses the same Mulberry32 PRNG, the same word list, and the same generation
//! logic (including the exact `rand()` call ordering) so the native benchmark
//! runs on inputs of identical size and shape to the TypeScript/WASM harness.
//! That makes the native-vs-WASM diff timings a fair comparison.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffShape {
    /// Same line count, every Nth line replaced (typical refactor).
    LineEdits,
    /// Same line count, characters changed within each Nth line (rename/typo).
    CharEdits,
    /// A block of lines inserted in B (paste / new function).
    BlockInsert,
    /// Totally different content (paste over).
    Disjoint,
}

#[derive(Debug, Clone, Copy)]
pub struct FixtureSpec {
    pub name: &'static str,
    pub lines: usize,
    pub shape: DiffShape,
    /// 0..1 — fraction of lines (or chars) affected when applicable.
    pub density: f64,
}

const WORDS: &[&str] = &[
    "function", "const", "let", "return", "value", "data", "request", "response", "user", "name",
    "path", "id", "result", "config", "client", "server", "promise", "async", "await", "next",
    "prev", "node", "tree", "leaf", "render", "mount", "update", "effect", "signal", "view",
    "state", "doc",
];

/// Mulberry32 — deterministic seeded PRNG. Bit-for-bit identical to the JS
/// version in `bench/fixtures.ts` (all ops are 32-bit wrapping; the one full
/// f64 add in the original is reproduced by `wrapping_add` since the result is
/// immediately truncated to 32 bits by the XOR-assign).
struct Rng {
    s: u32,
}

impl Rng {
    fn new(seed: u32) -> Self {
        Rng { s: seed }
    }

    fn next(&mut self) -> f64 {
        self.s = self.s.wrapping_add(0x6d2b_79f5);
        let mut t = self.s;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

fn make_line(rng: &mut Rng, indent: usize) -> String {
    let pad = "  ".repeat(indent);
    let word_count = 4 + (rng.next() * 8.0).floor() as usize;
    let mut words: Vec<&str> = Vec::with_capacity(word_count);
    for _ in 0..word_count {
        words.push(WORDS[(rng.next() * WORDS.len() as f64).floor() as usize]);
    }
    format!("{}{};", pad, words.join(" "))
}

fn make_baseline(lines: usize, seed: u32) -> Vec<String> {
    let mut rng = Rng::new(seed);
    let mut out: Vec<String> = Vec::with_capacity(lines);
    let mut indent: usize = 0;
    for _ in 0..lines {
        // Mirrors the JS `if (rand() < 0.05 && indent < 3) ... else if (rand()
        // < 0.05 && indent > 0) ...` — the second rand() only fires when the
        // first branch's condition is false.
        if rng.next() < 0.05 && indent < 3 {
            indent += 1;
        } else if rng.next() < 0.05 && indent > 0 {
            indent -= 1;
        }
        out.push(make_line(&mut rng, indent));
    }
    out
}

fn tweak_line(line: &str, rng: &mut Rng, density: f64) -> String {
    let parts: Vec<String> = line.split(' ').map(|s| s.to_string()).collect();
    let mut out: Vec<String> = Vec::with_capacity(parts.len());
    for part in parts {
        if rng.next() < density {
            let word = WORDS[(rng.next() * WORDS.len() as f64).floor() as usize];
            if part.ends_with(';') {
                out.push(format!("{};", word));
            } else {
                out.push(word.to_string());
            }
        } else {
            out.push(part);
        }
    }
    out.join(" ")
}

/// Build a fixture's (A, B) text pair. Deterministic for a given spec.
pub fn build_fixture(spec: &FixtureSpec) -> (String, String) {
    let baseline = make_baseline(spec.lines, 0x00c0_ffee ^ spec.lines as u32);
    let a_lines = baseline.clone();
    let mut b_lines = baseline;

    let mut rng = Rng::new(0x00ba_da55 ^ spec.lines as u32 ^ (spec.density * 1000.0).floor() as u32);

    match spec.shape {
        DiffShape::LineEdits => {
            let stride = ((1.0 / spec.density).floor() as usize).max(1);
            let mut i = 0;
            while i < b_lines.len() {
                b_lines[i] = make_line(&mut rng, 0);
                i += stride;
            }
        }
        DiffShape::CharEdits => {
            let stride = ((1.0 / spec.density).floor() as usize).max(1);
            let mut i = 0;
            while i < b_lines.len() {
                b_lines[i] = tweak_line(&b_lines[i], &mut rng, 0.3);
                i += stride;
            }
        }
        DiffShape::BlockInsert => {
            let insert_count = ((spec.lines as f64 * spec.density).floor() as usize).max(1);
            let insert_at = spec.lines / 2;
            let mut inserted: Vec<String> = Vec::with_capacity(insert_count);
            for _ in 0..insert_count {
                inserted.push(make_line(&mut rng, 1));
            }
            let mut merged: Vec<String> = Vec::with_capacity(b_lines.len() + insert_count);
            merged.extend_from_slice(&b_lines[..insert_at]);
            merged.extend(inserted);
            merged.extend_from_slice(&b_lines[insert_at..]);
            b_lines = merged;
        }
        DiffShape::Disjoint => {
            b_lines = make_baseline(spec.lines, 0xfeed_fa11 ^ spec.lines as u32);
        }
    }

    (a_lines.join("\n"), b_lines.join("\n"))
}

/// The benchmark matrix — mirrors `FIXTURES` in `bench/fixtures.ts`.
pub const FIXTURES: &[FixtureSpec] = &[
    // small
    FixtureSpec { name: "small/line-edits-10pct", lines: 200, shape: DiffShape::LineEdits, density: 0.1 },
    FixtureSpec { name: "small/char-edits-10pct", lines: 200, shape: DiffShape::CharEdits, density: 0.1 },
    FixtureSpec { name: "small/block-insert-20pct", lines: 200, shape: DiffShape::BlockInsert, density: 0.2 },
    FixtureSpec { name: "small/disjoint", lines: 200, shape: DiffShape::Disjoint, density: 1.0 },
    // medium
    FixtureSpec { name: "medium/line-edits-5pct", lines: 2000, shape: DiffShape::LineEdits, density: 0.05 },
    FixtureSpec { name: "medium/line-edits-50pct", lines: 2000, shape: DiffShape::LineEdits, density: 0.5 },
    FixtureSpec { name: "medium/char-edits-10pct", lines: 2000, shape: DiffShape::CharEdits, density: 0.1 },
    FixtureSpec { name: "medium/block-insert-10pct", lines: 2000, shape: DiffShape::BlockInsert, density: 0.1 },
    FixtureSpec { name: "medium/disjoint", lines: 2000, shape: DiffShape::Disjoint, density: 1.0 },
    // large (stress)
    FixtureSpec { name: "large/line-edits-5pct", lines: 10000, shape: DiffShape::LineEdits, density: 0.05 },
    FixtureSpec { name: "large/char-edits-5pct", lines: 10000, shape: DiffShape::CharEdits, density: 0.05 },
];
