//! Diff history — capture, dedupe, and persistence. Ports the dedupe heuristic
//! from `src-tauri/src/dedupe.rs` (and its TS twin `src/history/api.web.ts`),
//! using epoch-millisecond timestamps instead of chrono so `differ-core` stays
//! dependency-light. The same `tests/dedupe-fixtures.json` drives the parity
//! test here as in the other two implementations.
//!
//! `History` is pure/in-memory (serde JSON in/out); the app owns the file I/O.

use serde::{Deserialize, Serialize};

const MERGE_CUTOFF_MS: i64 = 10 * 60 * 1000;
const LENGTH_DELTA_APPEND: usize = 512;
const HASH_WINDOW: usize = 256;
const LEV_WINDOW: usize = 1024;
const LEV_SIMILARITY_THRESHOLD: f64 = 0.85;

/// Cap on retained entries (oldest dropped past this).
pub const MAX_ENTRIES: usize = 200;

/// Current on-disk schema version.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub original: String,
    pub modified: String,
    pub preview: String,
    pub language: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Append,
    UpdateLast,
}

/// Decide whether a new (original, modified) capture should append a new entry
/// or merge into `last` (a continuation of the same editing session).
pub fn decide(last: Option<&HistoryEntry>, original: &str, modified: &str, now_ms: i64) -> Decision {
    let Some(last) = last else {
        return Decision::Append;
    };

    if now_ms - last.updated_at_ms > MERGE_CUTOFF_MS {
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
    if (ratio_o + ratio_m) / 2.0 < LEV_SIMILARITY_THRESHOLD {
        return Decision::Append;
    }

    Decision::UpdateLast
}

fn diff_abs(a: usize, b: usize) -> usize {
    a.abs_diff(b)
}

fn edges_match(a: &str, b: &str, window: usize) -> bool {
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
    match s.char_indices().nth(len - n) {
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
    1.0 - (levenshtein(sa, sb) as f64 / max as f64)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());
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

/// First non-empty line of `modified` (falling back to `original`), trimmed —
/// used as the history list label.
fn make_preview(original: &str, modified: &str) -> String {
    let src = if modified.trim().is_empty() { original } else { modified };
    let line = src.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    line.chars().take(120).collect()
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct History {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub entries: Vec<HistoryEntry>,
}

impl History {
    pub fn new() -> Self {
        Self { version: SCHEMA_VERSION, entries: Vec::new() }
    }

    /// Capture a diff, merging into the last entry or appending per `decide`.
    pub fn capture(&mut self, original: &str, modified: &str, language: &str, now_ms: i64) {
        // Don't record empty diffs.
        if original.trim().is_empty() && modified.trim().is_empty() {
            return;
        }
        let preview = make_preview(original, modified);
        match decide(self.entries.last(), original, modified, now_ms) {
            Decision::UpdateLast => {
                let e = self.entries.last_mut().expect("decide returned UpdateLast with no last");
                e.original = original.to_string();
                e.modified = modified.to_string();
                e.updated_at_ms = now_ms;
                e.language = language.to_string();
                e.preview = preview;
            }
            Decision::Append => {
                self.entries.push(HistoryEntry {
                    id: format!("{}-{}", now_ms, self.entries.len()),
                    created_at_ms: now_ms,
                    updated_at_ms: now_ms,
                    original: original.to_string(),
                    modified: modified.to_string(),
                    preview,
                    language: language.to_string(),
                });
                if self.entries.len() > MAX_ENTRIES {
                    let overflow = self.entries.len() - MAX_ENTRIES;
                    self.entries.drain(0..overflow);
                }
            }
        }
    }

    /// Entries most-recent first (for display).
    pub fn recent(&self) -> impl Iterator<Item = &HistoryEntry> {
        self.entries.iter().rev()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn from_json(s: &str) -> Self {
        serde_json::from_str(s).unwrap_or_else(|_| History::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(original: &str, modified: &str, updated_at_ms: i64) -> HistoryEntry {
        HistoryEntry {
            id: "x".into(),
            created_at_ms: updated_at_ms,
            updated_at_ms,
            original: original.into(),
            modified: modified.into(),
            preview: String::new(),
            language: "plaintext".into(),
        }
    }

    #[test]
    fn append_when_no_last() {
        assert_eq!(decide(None, "a", "b", 0), Decision::Append);
    }

    #[test]
    fn update_when_small_edit_within_window() {
        let last = entry("hello world", "hello there", -60_000); // 1 min ago
        assert_eq!(decide(Some(&last), "hello world", "hello there!", 0), Decision::UpdateLast);
    }

    #[test]
    fn append_when_stale() {
        let last = entry("hello world", "hello there", -15 * 60_000); // 15 min ago
        assert_eq!(decide(Some(&last), "hello world", "hello there!", 0), Decision::Append);
    }

    #[test]
    fn capture_merges_rapid_similar_edits() {
        let mut h = History::new();
        h.capture("orig", "hello", "plaintext", 0);
        h.capture("orig", "hello!", "plaintext", 1000); // 1s later, tiny change
        assert_eq!(h.entries.len(), 1, "rapid similar edit should merge");
        assert_eq!(h.entries[0].modified, "hello!");
    }

    #[test]
    fn capture_appends_distinct_diffs() {
        let mut h = History::new();
        h.capture("a", "b", "plaintext", 0);
        h.capture("totally", "different content here", "plaintext", 1000);
        assert_eq!(h.entries.len(), 2);
    }

    #[test]
    fn json_round_trips() {
        let mut h = History::new();
        h.capture("a\nb", "a\nc", "rust", 5);
        let back = History::from_json(&h.to_json());
        assert_eq!(back.entries.len(), 1);
        assert_eq!(back.entries[0].modified, "a\nc");
    }

    // Parity with src-tauri/src/dedupe.rs and src/history/api.web.ts — the same
    // fixtures drive all three implementations.
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
        let raw = include_str!("../../../tests/dedupe-fixtures.json");
        let parsed: Fixtures = serde_json::from_str(raw).expect("fixture JSON");
        let now_ms: i64 = 0;

        let mut failures = Vec::new();
        for fx in parsed.fixtures {
            let last = fx.last.map(|l| entry(&l.original, &l.modified, now_ms - l.ago_min * 60_000));
            let got = match decide(last.as_ref(), &fx.next.original, &fx.next.modified, now_ms) {
                Decision::Append => "append",
                Decision::UpdateLast => "updateLast",
            };
            if got != fx.expected {
                failures.push(format!("{}: expected {}, got {}", fx.name, fx.expected, got));
            }
        }
        assert!(failures.is_empty(), "dedupe parity failures:\n{}", failures.join("\n"));
    }
}
