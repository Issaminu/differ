use chrono::{DateTime, Duration, Utc};

use crate::history::HistoryEntry;

const MERGE_CUTOFF_MINUTES: i64 = 10;
const LENGTH_DELTA_APPEND: usize = 512;
const HASH_WINDOW: usize = 256;
const LEV_WINDOW: usize = 1024;
const LEV_SIMILARITY_THRESHOLD: f64 = 0.85;

pub enum Decision {
    Append,
    UpdateLast,
}

pub fn decide(
    last: Option<&HistoryEntry>,
    original: &str,
    modified: &str,
    now: DateTime<Utc>,
) -> Decision {
    let Some(last) = last else {
        return Decision::Append;
    };

    if now.signed_duration_since(last.updated_at) > Duration::minutes(MERGE_CUTOFF_MINUTES) {
        return Decision::Append;
    }

    let delta_o = diff_abs(last.original.len(), original.len());
    let delta_m = diff_abs(last.modified.len(), modified.len());
    if delta_o > LENGTH_DELTA_APPEND || delta_m > LENGTH_DELTA_APPEND {
        return Decision::Append;
    }

    if !edges_match(&last.original, original, HASH_WINDOW)
        || !edges_match(&last.modified, modified, HASH_WINDOW)
    {
        return Decision::Append;
    }

    let ratio_o = similarity_suffix(&last.original, original, LEV_WINDOW);
    let ratio_m = similarity_suffix(&last.modified, modified, LEV_WINDOW);
    let avg = (ratio_o + ratio_m) / 2.0;
    if avg < LEV_SIMILARITY_THRESHOLD {
        return Decision::Append;
    }

    Decision::UpdateLast
}

fn diff_abs(a: usize, b: usize) -> usize {
    if a >= b {
        a - b
    } else {
        b - a
    }
}

fn edges_match(a: &str, b: &str, window: usize) -> bool {
    // For strings shorter than the window, the prefix/suffix precheck is too
    // strict — any small edit makes both unequal. Skip it and let the
    // similarity check downstream decide.
    if a.chars().count() <= window && b.chars().count() <= window {
        return true;
    }
    prefix(a, window) == prefix(b, window) || suffix(a, window) == suffix(b, window)
}

fn prefix(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

fn suffix(s: &str, n: usize) -> &str {
    let len = s.chars().count();
    if len <= n {
        return s;
    }
    let skip = len - n;
    match s.char_indices().nth(skip) {
        Some((idx, _)) => &s[idx..],
        None => s,
    }
}

fn similarity_suffix(a: &str, b: &str, window: usize) -> f64 {
    let sa = suffix(a, window);
    let sb = suffix(b, window);
    let max = sa.chars().count().max(sb.chars().count());
    if max == 0 {
        return 1.0;
    }
    let dist = levenshtein(sa, sb);
    1.0 - (dist as f64 / max as f64)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let n = a.len();
    let m = b.len();
    if n == 0 {
        return m;
    }
    if m == 0 {
        return n;
    }

    let mut prev: Vec<usize> = (0..=m).collect();
    let mut curr: Vec<usize> = vec![0; m + 1];

    for i in 1..=n {
        curr[0] = i;
        for j in 1..=m {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[m]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(original: &str, modified: &str, ago_minutes: i64) -> HistoryEntry {
        HistoryEntry {
            id: "x".into(),
            created_at: Utc::now() - Duration::minutes(ago_minutes),
            updated_at: Utc::now() - Duration::minutes(ago_minutes),
            original: original.into(),
            modified: modified.into(),
            preview: String::new(),
            language: "plaintext".into(),
        }
    }

    #[test]
    fn append_when_no_last() {
        let d = decide(None, "a", "b", Utc::now());
        assert!(matches!(d, Decision::Append));
    }

    #[test]
    fn append_when_stale() {
        let last = entry("hello world", "hello there", 15);
        let d = decide(Some(&last), "hello world", "hello there!", Utc::now());
        assert!(matches!(d, Decision::Append));
    }

    #[test]
    fn update_when_small_edit_within_window() {
        let last = entry("hello world", "hello there", 1);
        let d = decide(Some(&last), "hello world", "hello there!", Utc::now());
        assert!(matches!(d, Decision::UpdateLast));
    }

    #[test]
    fn append_when_large_delta() {
        let last = entry("hello", "world", 1);
        let big = "x".repeat(2000);
        let d = decide(Some(&last), "hello", &big, Utc::now());
        assert!(matches!(d, Decision::Append));
    }

    // Parity with src/history/api.web.ts. Same JSON drives bun:test in
    // src/history/dedupe.test.ts — any drift between the two impls fails
    // one of the two suites in CI.
    #[derive(serde::Deserialize)]
    struct LastSpec {
        original: String,
        modified: String,
        ago_min: i64,
    }

    #[derive(serde::Deserialize)]
    struct NextSpec {
        original: String,
        modified: String,
    }

    #[derive(serde::Deserialize)]
    struct Fixture {
        name: String,
        last: Option<LastSpec>,
        next: NextSpec,
        expected: String,
    }

    #[derive(serde::Deserialize)]
    struct Fixtures {
        fixtures: Vec<Fixture>,
    }

    #[test]
    fn parity_fixtures() {
        let raw = include_str!("../../tests/dedupe-fixtures.json");
        let parsed: Fixtures = serde_json::from_str(raw).expect("fixture JSON");
        let now = chrono::DateTime::parse_from_rfc3339("2026-04-26T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let mut failures: Vec<String> = Vec::new();
        for fx in parsed.fixtures {
            let last = fx.last.map(|l| {
                let updated = now - Duration::minutes(l.ago_min);
                HistoryEntry {
                    id: "test".into(),
                    created_at: updated,
                    updated_at: updated,
                    original: l.original,
                    modified: l.modified,
                    preview: String::new(),
                    language: "plaintext".into(),
                }
            });
            let got = decide(last.as_ref(), &fx.next.original, &fx.next.modified, now);
            let got_str = match got {
                Decision::Append => "append",
                Decision::UpdateLast => "updateLast",
            };
            if got_str != fx.expected {
                failures.push(format!(
                    "{}: expected {}, got {}",
                    fx.name, fx.expected, got_str
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "dedupe parity failures:\n{}",
            failures.join("\n")
        );
    }
}
