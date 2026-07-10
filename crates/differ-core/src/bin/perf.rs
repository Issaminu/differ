//! End-to-end-ish typing perf harness.
//!
//! Simulates real keystrokes (insert a char, recompute, repeat) and measures
//! the per-keystroke cost of the app's recompute pipeline (differ_core::
//! pipeline::compute) at several document sizes. This is exactly the work that
//! runs on every keystroke in the app, so if a keystroke here exceeds one
//! 60fps frame (16.7ms), typing will stutter/freeze in the real app.
//!
//! Run: cargo run --release --bin perf --manifest-path crates/differ-core/Cargo.toml

use std::time::Instant;

use differ_core::{
    fixtures::{build_fixture, FIXTURES},
    pipeline::compute,
};

fn pct(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() as f64 * p) as usize).min(sorted.len() - 1)]
}

/// Type `keystrokes` characters into the middle of `b`, timing a full recompute
/// after each one — mirroring what the app does per InputEvent::Change.
fn run(name: &str, a: &str, b_init: &str, keystrokes: usize) {
    let mut b = b_init.to_string();
    let _ = compute(a, &b); // warm caches/allocator

    let mut times = Vec::with_capacity(keystrokes);
    for (cursor, _) in (b.len() / 2..).zip(0..keystrokes) {
        b.insert(cursor, 'x');
        let t0 = Instant::now();
        std::hint::black_box(compute(a, &b));
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
    }

    times.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let n = times.len();
    let mean = times.iter().sum::<f64>() / n as f64;
    let over = times.iter().filter(|&&t| t > 16.7).count();
    let (al, bl) = (a.split('\n').count(), b.split('\n').count());
    println!(
        "{:<26} {:>6}+{:<6} lines | mean {:>7.2}  p50 {:>7.2}  p99 {:>7.2}  max {:>7.2} ms | >16.7ms: {}/{} {}",
        name,
        al,
        bl,
        mean,
        pct(&times, 0.50),
        pct(&times, 0.99),
        *times.last().unwrap(),
        over,
        n,
        if pct(&times, 0.99) > 16.7 { "  SLOW ⚠" } else { "" },
    );
}

fn main() {
    println!("Per-keystroke recompute latency — 16.7ms = one 60fps frame; >that => typing stutters\n");
    for spec in FIXTURES.iter().filter(|s| {
        matches!(
            s.name,
            "small/line-edits-10pct" | "medium/line-edits-5pct" | "large/line-edits-5pct" | "large/char-edits-5pct"
        )
    }) {
        let (a, b) = build_fixture(spec);
        run(spec.name, &a, &b, 150);
    }
    println!("\n(large/* is 10k lines/side ~= 20k total, bracketing the reported 15k-LOC case)");
}
