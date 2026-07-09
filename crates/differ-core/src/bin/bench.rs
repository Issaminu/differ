//! Native diff benchmark — the counterpart to `bench/diff.bench.ts`.
//!
//! Runs the same fixture matrix through the native `differ-core` engine and
//! reports mean latency per recompute, so the numbers line up against the
//! WASM harness's "DiffSession set+compute" and per-keystroke sections.
//!
//! Run: `cargo run --release --bin diff-bench` (release matters — LTO + opt3).

use std::time::Instant;

use differ_core::{
    fixtures::{build_fixture, FixtureSpec, FIXTURES},
    DiffSession,
};

struct Row {
    name: String,
    mean_ms: f64,
    p50_ms: f64,
    p99_ms: f64,
    samples: usize,
    chunks: usize,
}

/// Time a closure until both a minimum sample count and a wall-clock budget are
/// met, mirroring tinybench's "time AND iterations" stop condition.
fn measure(name: &str, min_iters: usize, budget_ms: u128, chunks: usize, mut f: impl FnMut()) -> Row {
    // Warmup.
    f();
    let mut times: Vec<f64> = Vec::new();
    let start = Instant::now();
    while times.len() < min_iters || start.elapsed().as_millis() < budget_ms {
        let t0 = Instant::now();
        f();
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
        // Hard cap so a pathological scenario can't run forever.
        if times.len() >= 5000 {
            break;
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = times.len();
    let mean = times.iter().sum::<f64>() / n as f64;
    let p = |q: f64| times[((n as f64 * q) as usize).min(n - 1)];
    Row {
        name: name.to_string(),
        mean_ms: mean,
        p50_ms: p(0.50),
        p99_ms: p(0.99),
        samples: n,
        chunks,
    }
}

/// Per-tier sample budgets, mirroring FULL_DIFF_TIERS in the TS harness.
fn budget_for(name: &str) -> (usize, u128) {
    if name.starts_with("small/") {
        (10, 400)
    } else if name.starts_with("medium/") {
        (5, 400)
    } else {
        (3, 400)
    }
}

fn print_table(title: &str, rows: &[Row]) {
    println!("\n=== {title} ===");
    let name_w = rows.iter().map(|r| r.name.len()).max().unwrap_or(8).max(8);
    println!(
        "{:<name_w$} | {:>10} | {:>10} | {:>10} | {:>8} | {:>6}",
        "scenario", "mean (ms)", "p50 (ms)", "p99 (ms)", "chunks", "n",
        name_w = name_w
    );
    println!("{}", "-".repeat(name_w + 58));
    for r in rows {
        println!(
            "{:<name_w$} | {:>10.4} | {:>10.4} | {:>10.4} | {:>8} | {:>6}",
            r.name, r.mean_ms, r.p50_ms, r.p99_ms, r.chunks, r.samples,
            name_w = name_w
        );
    }
}

fn insert_one_char_at_middle(text: &str) -> String {
    // Byte-safe midpoint on our ASCII fixtures.
    let mid = text.len() / 2;
    let mut s = String::with_capacity(text.len() + 1);
    s.push_str(&text[..mid]);
    s.push('x');
    s.push_str(&text[mid..]);
    s
}

fn main() {
    eprintln!("Building fixtures...");
    let built: Vec<(&FixtureSpec, String, String)> = FIXTURES
        .iter()
        .map(|spec| {
            let (a, b) = build_fixture(spec);
            (spec, a, b)
        })
        .collect();

    // Section 1: full recompute (set A + set B + compute_with_changes). This is
    // the paste / initial-diff path, comparable to the WASM
    // "DiffSession set+compute+buffers (paste/full)" section.
    let mut full_rows = Vec::new();
    for (spec, a, b) in &built {
        let (min_iters, budget) = budget_for(spec.name);
        let mut session = DiffSession::new();
        let chunk_count = {
            session.set_a(a.clone());
            session.set_b(b.clone());
            session.compute(true).len()
        };
        eprint!("  {:<40} ...", spec.name);
        let row = measure(spec.name, min_iters, budget, chunk_count, || {
            session.set_a(a.clone());
            session.set_b(b.clone());
            let _ = session.compute(true);
        });
        eprintln!("\r  {:<40} {:>8.4} ms (n={})", spec.name, row.mean_ms, row.samples);
        full_rows.push(row);
    }
    print_table("full recompute (set A+B + compute w/ changes)", &full_rows);

    // Section 2: per-keystroke — one char inserted into B, side A unchanged.
    // Comparable to the WASM "setB+compute (1-char edit on B)" section.
    let mut key_rows = Vec::new();
    for (spec, a, b) in &built {
        let (min_iters, budget) = budget_for(spec.name);
        let new_b = insert_one_char_at_middle(b);
        let mut session = DiffSession::new();
        session.set_a(a.clone());
        session.set_b(b.clone());
        let base_chunks = session.compute(true).len();
        eprint!("  {:<40} ...", spec.name);
        let row = measure(spec.name, min_iters, budget, base_chunks, || {
            session.set_b(new_b.clone());
            let _ = session.compute(true);
        });
        eprintln!("\r  {:<40} {:>8.4} ms (n={})", spec.name, row.mean_ms, row.samples);
        key_rows.push(row);
    }
    print_table("per-keystroke (setB + compute, 1-char edit on B)", &key_rows);

    eprintln!("\nDone.");
}
