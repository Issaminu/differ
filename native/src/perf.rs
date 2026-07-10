//! Opt-in perf instrumentation for the headful bench harness.
//!
//! Enabled by `DIFFER_PERF=1`. Code records labelled durations via [`span`];
//! [`report`] prints count / mean / p50 / p95 / p99 / max per label to stderr.
//! This is how we measure the *real* end-to-end cost (app-side recompute +
//! apply + element build) while the app runs headful under the stress driver —
//! no screen-recording permission needed, the numbers come out on stderr.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

// `const fn` constructors let this be a plain static — no lazy init needed.
static SAMPLES: Mutex<BTreeMap<&'static str, Vec<f64>>> = Mutex::new(BTreeMap::new());

#[inline]
pub fn enabled() -> bool {
    std::env::var_os("DIFFER_PERF").is_some()
}

pub fn record(label: &'static str, dur: Duration) {
    if !enabled() {
        return;
    }
    let ms = dur.as_secs_f64() * 1000.0;
    if let Ok(mut m) = SAMPLES.lock() {
        m.entry(label).or_default().push(ms);
    }
}

/// Drop samples gathered during setup before a benchmark's measured phase.
///
/// The native harness builds a real window and computes its initial diff before
/// it starts typing or driving frames. Those costs are useful during startup
/// profiling, but must not contaminate steady-state figures.
pub fn reset() {
    if let Ok(mut m) = SAMPLES.lock() {
        m.clear();
    }
}

/// RAII timer: records `label`'s duration when dropped. `let _s = perf::span(..)`.
pub struct Span {
    label: &'static str,
    start: Instant,
}

impl Drop for Span {
    fn drop(&mut self) {
        record(self.label, self.start.elapsed());
    }
}

#[inline]
pub fn span(label: &'static str) -> Span {
    Span {
        label,
        start: Instant::now(),
    }
}

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((p / 100.0) * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// Print the aggregated report to stderr and clear the samples.
pub fn report() {
    if !enabled() {
        return;
    }
    let Ok(mut m) = SAMPLES.lock() else { return };
    eprintln!("===== DIFFER PERF REPORT (ms) =====");
    eprintln!(
        "{:<22} {:>6} {:>8} {:>8} {:>8} {:>8} {:>8}",
        "label", "n", "mean", "p50", "p95", "p99", "max"
    );
    for (label, v) in m.iter_mut() {
        if v.is_empty() {
            continue;
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = v.len();
        let mean = v.iter().sum::<f64>() / n as f64;
        eprintln!(
            "{:<22} {:>6} {:>8.2} {:>8.2} {:>8.2} {:>8.2} {:>8.2}",
            label,
            n,
            mean,
            pct(v, 50.0),
            pct(v, 95.0),
            pct(v, 99.0),
            v[n - 1],
        );
    }
    eprintln!("===================================");
    m.clear();
}
