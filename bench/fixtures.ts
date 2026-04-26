// Synthetic fixture generator for diff benchmarks.
//
// We want fixtures that mirror real diff editor inputs — same line count
// on both sides for a believable "edit", with controllable change density
// and change shape (whole-line vs intra-line). Real source code is
// reproduced via a tiny grammar so we get realistic line lengths and
// alpha/punctuation mix without checking corpus files into the repo.

import { Text } from "@codemirror/state";

export type DiffShape =
  // Same line count, every Nth line edited (typical refactor).
  | "line-edits"
  // Same line count, characters changed within each Nth line (rename, typo fix).
  | "char-edits"
  // Block of lines inserted in B (paste, new function).
  | "block-insert"
  // Totally different content (paste over).
  | "disjoint";

export interface FixtureSpec {
  name: string;
  lines: number;
  shape: DiffShape;
  // 0..1 — fraction of lines (or chars) affected when applicable.
  density: number;
  // When true, the full-diff (Chunk.build) bench skips this fixture because a
  // single iteration would dominate the suite.
  skipFullDiff?: boolean;
  // When true, the per-keystroke bench (Chunk.updateB / combined) also skips
  // this fixture. Disjoint inputs land here because Chunk.updateB observably
  // falls back to a full rebuild when the chunk set is one giant chunk.
  skipKeystroke?: boolean;
}

const WORDS = [
  "function", "const", "let", "return", "value", "data", "request", "response",
  "user", "name", "path", "id", "result", "config", "client", "server",
  "promise", "async", "await", "next", "prev", "node", "tree", "leaf",
  "render", "mount", "update", "effect", "signal", "view", "state", "doc",
];

// Mulberry32 — deterministic seeded PRNG so fixtures are stable across runs.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeLine(rand: () => number, indent = 0): string {
  const pad = "  ".repeat(indent);
  const wordCount = 4 + Math.floor(rand() * 8);
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(WORDS[Math.floor(rand() * WORDS.length)]);
  }
  return pad + words.join(" ") + ";";
}

function makeBaseline(lines: number, seed: number): string[] {
  const rand = rng(seed);
  const out: string[] = [];
  let indent = 0;
  for (let i = 0; i < lines; i++) {
    if (rand() < 0.05 && indent < 3) indent++;
    else if (rand() < 0.05 && indent > 0) indent--;
    out.push(makeLine(rand, indent));
  }
  return out;
}

function tweakLine(line: string, rand: () => number, density: number): string {
  // Replace ~density fraction of words with a different word from the dict.
  const parts = line.split(" ");
  for (let i = 0; i < parts.length; i++) {
    if (rand() < density) {
      parts[i] = WORDS[Math.floor(rand() * WORDS.length)] + (parts[i].endsWith(";") ? ";" : "");
    }
  }
  return parts.join(" ");
}

export interface Fixture {
  spec: FixtureSpec;
  a: string;
  b: string;
  textA: Text;
  textB: Text;
}

export function buildFixture(spec: FixtureSpec): Fixture {
  const baseline = makeBaseline(spec.lines, 0xc0ffee ^ spec.lines);
  let aLines = baseline.slice();
  let bLines = baseline.slice();
  const rand = rng(0xbada55 ^ spec.lines ^ Math.floor(spec.density * 1000));

  switch (spec.shape) {
    case "line-edits": {
      const stride = Math.max(1, Math.floor(1 / spec.density));
      for (let i = 0; i < bLines.length; i += stride) {
        bLines[i] = makeLine(rand, 0);
      }
      break;
    }
    case "char-edits": {
      const stride = Math.max(1, Math.floor(1 / spec.density));
      for (let i = 0; i < bLines.length; i += stride) {
        bLines[i] = tweakLine(bLines[i], rand, 0.3);
      }
      break;
    }
    case "block-insert": {
      const insertCount = Math.max(1, Math.floor(spec.lines * spec.density));
      const insertAt = Math.floor(spec.lines / 2);
      const inserted: string[] = [];
      for (let i = 0; i < insertCount; i++) inserted.push(makeLine(rand, 1));
      bLines = [...bLines.slice(0, insertAt), ...inserted, ...bLines.slice(insertAt)];
      break;
    }
    case "disjoint": {
      bLines = makeBaseline(spec.lines, 0xfeedfa11 ^ spec.lines);
      break;
    }
  }

  const a = aLines.join("\n");
  const b = bLines.join("\n");
  return {
    spec,
    a,
    b,
    textA: Text.of(aLines),
    textB: Text.of(bLines),
  };
}

// The matrix we run the bench against. Sizes are chosen to span:
//   - 200: typical short snippet pair (the most common UX path)
//   - 2000: medium file (a real source file)
//   - 10000: stress / "user pasted a giant config"
export const FIXTURES: FixtureSpec[] = [
  // small
  { name: "small/line-edits-10pct", lines: 200, shape: "line-edits", density: 0.1 },
  { name: "small/char-edits-10pct", lines: 200, shape: "char-edits", density: 0.1 },
  { name: "small/block-insert-20pct", lines: 200, shape: "block-insert", density: 0.2 },
  { name: "small/disjoint", lines: 200, shape: "disjoint", density: 1, skipKeystroke: true },

  // medium
  { name: "medium/line-edits-5pct", lines: 2000, shape: "line-edits", density: 0.05 },
  { name: "medium/line-edits-50pct", lines: 2000, shape: "line-edits", density: 0.5 },
  { name: "medium/char-edits-10pct", lines: 2000, shape: "char-edits", density: 0.1 },
  { name: "medium/block-insert-10pct", lines: 2000, shape: "block-insert", density: 0.1 },
  // Full diff on this scenario is ~42s/iteration — pathological cost worth
  // flagging, but unviable as a sampled bench. Same story for keystrokes:
  // updateB falls back to a full rebuild when chunks0 is one giant chunk.
  // Pre-computed once for the decoration sections (which use the chunk set
  // and are cheap regardless of chunk shape).
  { name: "medium/disjoint", lines: 2000, shape: "disjoint", density: 1, skipFullDiff: true, skipKeystroke: true },

  // large (stress)
  { name: "large/line-edits-5pct", lines: 10000, shape: "line-edits", density: 0.05 },
  { name: "large/char-edits-5pct", lines: 10000, shape: "char-edits", density: 0.05 },
  // Note: there is intentionally no `large/disjoint`. Baseline Chunk.build for
  // 10k disjoint lines extrapolates to multiple hours given the cubic scaling
  // demonstrated by the small/medium disjoint runs — even a one-time
  // pre-compute makes the suite unusable.
];
