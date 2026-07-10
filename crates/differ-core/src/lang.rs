//! Language auto-detection — a faithful port of `src/merge/languageDetect.ts`.
//!
//! Same approach: a few anchored "fast win" patterns (shebang/doctype/xml/yaml
//! front-matter), a JSON parse attempt, then weighted keyword-signal scoring
//! normalised per KB, with a confidence floor. Returns a language id string;
//! ids the syntax highlighter doesn't know simply fall back to plain text.
//!
//! Pure + gpui-free, so it's unit-tested here against representative samples.

use std::sync::LazyLock;

use regex::Regex;

struct Signal {
    re: Regex,
    lang: &'static str,
    weight: f64,
}

fn sig(pattern: &str, lang: &'static str, weight: f64) -> Signal {
    Signal { re: Regex::new(pattern).expect("valid detection regex"), lang, weight }
}

/// Anchored patterns that decide immediately when matched (checked in order).
static FAST_WINS: LazyLock<Vec<Signal>> = LazyLock::new(|| {
    vec![
        sig(r"(?im)^#!.*\bpython\b", "python", 999.0),
        sig(r"(?im)^#!.*\b(node|deno|bun)\b", "javascript", 999.0),
        sig(r"(?im)^#!.*\b(bash|sh|zsh)\b", "shell", 999.0),
        sig(r"(?im)^#!.*\bruby\b", "ruby", 999.0),
        sig(r"(?i)^<!doctype\s+html", "html", 999.0),
        sig(r"(?i)^<\?xml", "xml", 999.0),
        sig(r"(?i)^\s*<html[\s>]", "html", 800.0),
        sig(r"(?m)^\s*---\s*\n[\w.-]+:\s", "yaml", 800.0),
    ]
});

/// Weighted keyword signals — score = matches * weight / KB, summed per lang.
static KEYWORD_SIGNALS: LazyLock<Vec<Signal>> = LazyLock::new(|| {
    vec![
        // Python
        sig(r"\bdef\s+\w+\s*\(", "python", 3.0),
        sig(r"\b(from|import)\s+[\w.]+", "python", 2.0),
        sig(r"\bself\b", "python", 1.0),
        sig(r"(?m):\s*$", "python", 0.5),
        // TypeScript
        sig(r"\binterface\s+\w+", "typescript", 4.0),
        sig(r"\btype\s+\w+\s*=", "typescript", 4.0),
        sig(r":\s*(string|number|boolean|void|any|unknown|never)\b", "typescript", 3.0),
        sig(r"\bas\s+(const|\w+)", "typescript", 2.0),
        sig(r"<\w+(?:\s*,\s*\w+)*>\s*\(", "typescript", 1.0),
        // JavaScript
        sig(r"\b(function|const|let|var)\s+\w+", "javascript", 2.0),
        sig(r"=>\s*[({\[\w]", "javascript", 1.0),
        sig(r"\brequire\s*\(", "javascript", 1.0),
        // Rust
        sig(r"\bfn\s+\w+\s*\(", "rust", 4.0),
        sig(r"\bimpl\s+(\w+\s+for\s+)?\w+", "rust", 4.0),
        sig(r"\blet\s+mut\s+", "rust", 3.0),
        sig(r"\b(use|pub|crate)\s+", "rust", 1.0),
        sig(r"::", "rust", 0.3),
        // Go
        sig(r"\bfunc\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(", "go", 4.0),
        sig(r"\bpackage\s+\w+", "go", 3.0),
        sig(r":=\s*", "go", 1.0),
        // Swift
        sig(r"\bfunc\s+\w+\s*\(", "swift", 3.0),
        sig(r"\b(var|let)\s+\w+\s*:", "swift", 2.0),
        sig(r"(?m)@\w+", "swift", 0.5),
        // Java / Kotlin
        sig(r"\b(public|private|protected)\s+(static\s+)?(class|void|int|String)\b", "java", 4.0),
        sig(r"\bSystem\.out\.", "java", 2.0),
        sig(r"\bfun\s+\w+\s*\(", "kotlin", 4.0),
        // C / C++
        sig(r#"#include\s+[<"]"#, "cpp", 3.0),
        sig(r"\b(std::|nullptr|template\s*<)", "cpp", 3.0),
        sig(r"\bint\s+main\s*\(", "c", 2.0),
        // CSS / SCSS
        sig(r"(?m)[\w-]+\s*:\s*[^;]+;\s*$", "css", 1.0),
        sig(r"@(media|keyframes|import|supports)\b", "css", 3.0),
        sig(r"\$[\w-]+\s*:", "sass", 4.0),
        // HTML
        sig(r"</?\w+[\s>]", "html", 0.5),
        // Shell
        sig(r"(?m)^\s*(if|for|while|case)\s.*\b(then|do)\b", "shell", 3.0),
        sig(r"\$\{?\w+\}?", "shell", 0.3),
        // Markdown
        sig(r"(?m)^#{1,6}\s+.+$", "markdown", 2.0),
        sig(r"\[.+\]\(.+\)", "markdown", 2.0),
        sig(r"(?m)^[-*+]\s+", "markdown", 0.5),
        // YAML
        sig(r"(?m)^\s*[\w.-]+:\s*$", "yaml", 2.0),
        sig(r#"(?m)^\s*- [\w"']"#, "yaml", 1.0),
        // SQL
        sig(r"(?i)\b(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|CREATE\s+TABLE)\b", "sql", 3.0),
        // Ruby
        sig(r"(?m)\bdef\s+\w+(\s*\(.*\))?\s*$", "ruby", 3.0),
        sig(r"(?m)\bend\s*$", "ruby", 1.0),
        sig(r"\bputs\s+", "ruby", 2.0),
    ]
});

const PLAINTEXT_THRESHOLD: usize = 5 * 1024 * 1024;
const FAST_WIN_HEADER_BYTES: usize = 4096;
const SAMPLE_BYTES: usize = 8000;

/// Largest prefix of `text` up to `n` bytes that ends on a char boundary.
fn head(text: &str, n: usize) -> &str {
    if text.len() <= n {
        return text;
    }
    let mut end = n;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub fn detect_language(text: &str) -> &'static str {
    if text.trim().len() < 2 {
        return "plaintext";
    }
    if text.len() > PLAINTEXT_THRESHOLD {
        return "plaintext";
    }

    let trimmed = text.trim();
    if (trimmed.starts_with('{') || trimmed.starts_with('[')) && serde_json::from_str::<serde_json::Value>(trimmed).is_ok() {
        return "json";
    }

    let header = head(text, FAST_WIN_HEADER_BYTES);
    for s in FAST_WINS.iter() {
        if s.re.is_match(header) {
            return s.lang;
        }
    }

    let sample = head(text, SAMPLE_BYTES);
    let kb = (sample.len() as f64 / 1024.0).max(0.5);

    // Accumulate per-lang scores in first-appearance order so ties resolve
    // deterministically (matching the TS Map iteration order).
    let mut scores: Vec<(&'static str, f64)> = Vec::new();
    for sig in KEYWORD_SIGNALS.iter() {
        let count = sig.re.find_iter(sample).count();
        if count == 0 {
            continue;
        }
        let score = (count as f64 * sig.weight) / kb;
        match scores.iter_mut().find(|(l, _)| *l == sig.lang) {
            Some(entry) => entry.1 += score,
            None => scores.push((sig.lang, score)),
        }
    }

    let mut best = "plaintext";
    let mut best_score = 0.0;
    for (lang, score) in scores {
        if score > best_score {
            best = lang;
            best_score = score;
        }
    }

    if best_score >= 1.5 {
        best
    } else {
        "plaintext"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_common_languages() {
        assert_eq!(detect_language("fn main() {\n    let mut x = 1;\n    println!(\"{}\", x);\n}\n"), "rust");
        assert_eq!(detect_language("def greet(name):\n    print(name)\n    return None\n"), "python");
        assert_eq!(detect_language("interface Foo { a: string; b: number; }\ntype Bar = Foo;\n"), "typescript");
        assert_eq!(detect_language("package main\nfunc main() {\n    x := 1\n}\n"), "go");
    }

    #[test]
    fn detects_json_via_parse() {
        assert_eq!(detect_language("{\n  \"name\": \"differ\",\n  \"version\": 1\n}"), "json");
        // Looks like JSON but isn't valid -> not json.
        assert_ne!(detect_language("{ not valid json at all, just braces"), "json");
    }

    #[test]
    fn fast_win_shebang() {
        // NB: the ported pattern is `\bpython\b`, so "python3" does not fast-win
        // (same as the TS original) — use the bare interpreter name here.
        assert_eq!(detect_language("#!/usr/bin/env python\nprint('hi')\n"), "python");
        assert_eq!(detect_language("#!/bin/bash\necho hello\n"), "shell");
    }

    #[test]
    fn short_or_empty_is_plaintext() {
        assert_eq!(detect_language(""), "plaintext");
        assert_eq!(detect_language("x"), "plaintext");
        assert_eq!(detect_language("   \n  "), "plaintext");
        // Prose with no code signals.
        assert_eq!(detect_language("The quick brown fox jumped over the lazy dog."), "plaintext");
    }
}
