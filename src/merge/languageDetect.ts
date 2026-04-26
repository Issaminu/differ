import type { LanguageId } from "../state";

interface Signal {
  pattern: RegExp;
  lang: LanguageId;
  weight: number;
}

const fastWins: Signal[] = [
  { pattern: /^#!.*\bpython\b/im, lang: "python", weight: 999 },
  { pattern: /^#!.*\b(node|deno|bun)\b/im, lang: "javascript", weight: 999 },
  { pattern: /^#!.*\b(bash|sh|zsh)\b/im, lang: "shell", weight: 999 },
  { pattern: /^#!.*\bruby\b/im, lang: "ruby", weight: 999 },
  { pattern: /^<!doctype\s+html/i, lang: "html", weight: 999 },
  { pattern: /^<\?xml/i, lang: "xml", weight: 999 },
  { pattern: /^\s*<html[\s>]/i, lang: "html", weight: 800 },
  { pattern: /^\s*---\s*\n[\w.-]+:\s/m, lang: "yaml", weight: 800 },
];

const keywordSignals: Signal[] = [
  // Python
  { pattern: /\bdef\s+\w+\s*\(/g, lang: "python", weight: 3 },
  { pattern: /\b(from|import)\s+[\w.]+/g, lang: "python", weight: 2 },
  { pattern: /\bself\b/g, lang: "python", weight: 1 },
  { pattern: /:\s*$/gm, lang: "python", weight: 0.5 },

  // TypeScript — must score above JS to win when types present
  { pattern: /\binterface\s+\w+/g, lang: "typescript", weight: 4 },
  { pattern: /\btype\s+\w+\s*=/g, lang: "typescript", weight: 4 },
  { pattern: /:\s*(string|number|boolean|void|any|unknown|never)\b/g, lang: "typescript", weight: 3 },
  { pattern: /\bas\s+(const|\w+)/g, lang: "typescript", weight: 2 },
  { pattern: /<\w+(?:\s*,\s*\w+)*>\s*\(/g, lang: "typescript", weight: 1 },

  // JavaScript
  { pattern: /\b(function|const|let|var)\s+\w+/g, lang: "javascript", weight: 2 },
  { pattern: /=>\s*[({[\w]/g, lang: "javascript", weight: 1 },
  { pattern: /\brequire\s*\(/g, lang: "javascript", weight: 1 },

  // Rust
  { pattern: /\bfn\s+\w+\s*\(/g, lang: "rust", weight: 4 },
  { pattern: /\bimpl\s+(\w+\s+for\s+)?\w+/g, lang: "rust", weight: 4 },
  { pattern: /\blet\s+mut\s+/g, lang: "rust", weight: 3 },
  { pattern: /\b(use|pub|crate)\s+/g, lang: "rust", weight: 1 },
  { pattern: /::/g, lang: "rust", weight: 0.3 },

  // Go
  { pattern: /\bfunc\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/g, lang: "go", weight: 4 },
  { pattern: /\bpackage\s+\w+/g, lang: "go", weight: 3 },
  { pattern: /:=\s*/g, lang: "go", weight: 1 },

  // Swift
  { pattern: /\bfunc\s+\w+\s*\(/g, lang: "swift", weight: 3 },
  { pattern: /\b(var|let)\s+\w+\s*:/g, lang: "swift", weight: 2 },
  { pattern: /@\w+/gm, lang: "swift", weight: 0.5 },

  // Java / Kotlin
  { pattern: /\b(public|private|protected)\s+(static\s+)?(class|void|int|String)\b/g, lang: "java", weight: 4 },
  { pattern: /\bSystem\.out\./g, lang: "java", weight: 2 },
  { pattern: /\bfun\s+\w+\s*\(/g, lang: "kotlin", weight: 4 },

  // C/C++
  { pattern: /#include\s+[<"]/g, lang: "cpp", weight: 3 },
  { pattern: /\b(std::|nullptr|template\s*<)/g, lang: "cpp", weight: 3 },
  { pattern: /\bint\s+main\s*\(/g, lang: "c", weight: 2 },

  // CSS / SCSS
  { pattern: /[\w-]+\s*:\s*[^;]+;\s*$/gm, lang: "css", weight: 1 },
  { pattern: /@(media|keyframes|import|supports)\b/g, lang: "css", weight: 3 },
  { pattern: /\$[\w-]+\s*:/g, lang: "sass", weight: 4 },

  // HTML
  { pattern: /<\/?\w+[\s>]/g, lang: "html", weight: 0.5 },

  // Shell
  { pattern: /^\s*(if|for|while|case)\s.*\b(then|do)\b/gm, lang: "shell", weight: 3 },
  { pattern: /\$\{?\w+\}?/g, lang: "shell", weight: 0.3 },

  // Markdown
  { pattern: /^#{1,6}\s+.+$/gm, lang: "markdown", weight: 2 },
  { pattern: /\[.+\]\(.+\)/g, lang: "markdown", weight: 2 },
  { pattern: /^[-*+]\s+/gm, lang: "markdown", weight: 0.5 },

  // YAML
  { pattern: /^\s*[\w.-]+:\s*$/gm, lang: "yaml", weight: 2 },
  { pattern: /^\s*- [\w"']/gm, lang: "yaml", weight: 1 },

  // SQL
  { pattern: /\b(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|CREATE\s+TABLE)\b/gi, lang: "sql", weight: 3 },

  // Ruby
  { pattern: /\bdef\s+\w+(\s*\(.*\))?\s*$/gm, lang: "ruby", weight: 3 },
  { pattern: /\bend\s*$/gm, lang: "ruby", weight: 1 },
  { pattern: /\bputs\s+/g, lang: "ruby", weight: 2 },
];

// Above this size we don't even try to detect — the cost of running regex
// scoring + JSON.parse outweighs the value, and in practice docs this big
// are usually log files or data dumps where syntax highlighting wouldn't
// help anyway. Users can still pick a language manually from the toolbar.
const PLAINTEXT_THRESHOLD = 5 * 1024 * 1024;

// Slice we run fastWins regex against. They're all anchored "starts with"
// patterns (shebangs, doctype, xml decl, yaml front-matter), so a small
// header is enough; previously we ran them against the whole document and
// the YAML pattern alone burned 127 ms per keystroke on a 70 MB doc.
const FAST_WIN_HEADER_BYTES = 4096;

export function detectLanguage(text: string): LanguageId {
  if (!text || text.trim().length < 2) return "plaintext";
  if (text.length > PLAINTEXT_THRESHOLD) return "plaintext";

  // JSON — try to parse a trimmed sample
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      /* fall through */
    }
  }

  const header =
    text.length > FAST_WIN_HEADER_BYTES ? text.slice(0, FAST_WIN_HEADER_BYTES) : text;
  for (const s of fastWins) {
    if (s.pattern.test(header)) return s.lang;
  }

  const sample = text.length > 8000 ? text.slice(0, 8000) : text;
  const scores = new Map<LanguageId, number>();
  const kb = Math.max(0.5, sample.length / 1024);

  for (const sig of keywordSignals) {
    const matches = sample.match(sig.pattern);
    if (!matches) continue;
    const score = (matches.length * sig.weight) / kb;
    scores.set(sig.lang, (scores.get(sig.lang) ?? 0) + score);
  }

  if (scores.size === 0) return "plaintext";

  let best: LanguageId = "plaintext";
  let bestScore = 0;
  for (const [lang, score] of scores) {
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }

  return bestScore >= 1.5 ? best : "plaintext";
}
