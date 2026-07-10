// On-disk persistence for diff history. differ_core::history::History is pure;
// this owns the file I/O (macOS app-support path for now — cross-platform dirs
// can come later).

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use differ_core::history::History;

fn data_path(name: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push("Library/Application Support/Differ");
    std::fs::create_dir_all(&p).ok()?;
    p.push(name);
    Some(p)
}

pub fn load() -> History {
    match data_path("history.json").and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(s) => History::from_json(&s),
        None => History::new(),
    }
}

pub fn save(history: &History) {
    if let Some(p) = data_path("history.json") {
        let _ = std::fs::write(p, history.to_json());
    }
}

/// Persisted editor font size in px (a single plain number — no schema needed).
pub fn load_font_size() -> Option<f32> {
    let raw = std::fs::read_to_string(data_path("font_size")?).ok()?;
    raw.trim().parse::<f32>().ok().filter(|n| n.is_finite())
}

pub fn save_font_size(size: f32) {
    if let Some(p) = data_path("font_size") {
        let _ = std::fs::write(p, size.to_string());
    }
}

/// Current time as epoch milliseconds (the unit differ_core::history uses).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
