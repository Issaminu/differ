// On-disk persistence for diff history. differ_core::history::History is pure;
// this owns the file I/O (macOS app-support path for now — cross-platform dirs
// can come later).

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use differ_core::history::History;

fn history_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push("Library/Application Support/Differ");
    std::fs::create_dir_all(&p).ok()?;
    p.push("history.json");
    Some(p)
}

pub fn load() -> History {
    match history_path().and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(s) => History::from_json(&s),
        None => History::new(),
    }
}

pub fn save(history: &History) {
    if let Some(p) = history_path() {
        let _ = std::fs::write(p, history.to_json());
    }
}

/// Current time as epoch milliseconds (the unit differ_core::history uses).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
