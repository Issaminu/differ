// Emits tests/dedupe-fixtures.json — the shared parity corpus for the
// history dedupe decision. Both src/history/api.web.ts (bun:test) and
// src-tauri/src/dedupe.rs (cargo test) load the JSON and assert that
// `decide` returns `expected` for every fixture.
//
// Long strings (>EDGE_WINDOW=256) are produced via repeat() here so the
// committed JSON stays human-readable.
//
//   bun run tests/generate-dedupe-fixtures.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

interface Fixture {
  name: string;
  last: { original: string; modified: string; ago_min: number } | null;
  next: { original: string; modified: string };
  expected: "append" | "updateLast";
}

// 256+ chars so edges_match's "both short" auto-accept branch doesn't
// trigger. Aligns with EDGE_WINDOW / HASH_WINDOW.
const longA = "A".repeat(300);
const longB = "B".repeat(300);

// 1024+ chars so the suffix-similarity computation actually runs over the
// full LEV_WINDOW. Aligns with LEV_WINDOW.
const sharedPrefix = "P".repeat(400);
const xSuffix = "X".repeat(1100);
const ySuffix = "Y".repeat(1100);

const fixtures: Fixture[] = [
  {
    name: "no_previous",
    last: null,
    next: { original: "a", modified: "b" },
    expected: "append",
  },
  {
    name: "small_edit_within_cutoff",
    last: { original: "hello world", modified: "hello there", ago_min: 1 },
    next: { original: "hello world", modified: "hello there!" },
    expected: "updateLast",
  },
  {
    name: "cutoff_exceeded",
    last: { original: "hello world", modified: "hello there", ago_min: 15 },
    next: { original: "hello world", modified: "hello there!" },
    expected: "append",
  },
  {
    name: "length_delta_exceeds_512",
    last: { original: "hello", modified: "world", ago_min: 1 },
    next: { original: "hello", modified: "x".repeat(2000) },
    expected: "append",
  },
  {
    name: "both_short_high_similarity",
    last: { original: "abcdefghij", modified: "abcdefghij", ago_min: 1 },
    next: { original: "abcdefghij", modified: "abcdefghijk" },
    expected: "updateLast",
  },
  {
    name: "both_short_low_similarity",
    last: { original: "abcdefghij", modified: "qrstuvwxyz", ago_min: 1 },
    next: { original: "abcdefghij", modified: "0123456789" },
    expected: "append",
  },
  {
    name: "long_doc_edges_diverged",
    last: { original: longA, modified: longA, ago_min: 1 },
    next: { original: longB, modified: longB },
    expected: "append",
  },
  {
    name: "long_doc_prefix_match_suffix_diverged",
    // Prefix matches → edgesMatch=true. Suffix Lev distance ≈ 1024 over a
    // 1100-char window → similarity ≈ 0.07 → fails 0.85 threshold.
    // This is the case the web adapter previously got wrong (returning
    // updateLast where Rust returned append).
    last: {
      original: sharedPrefix + xSuffix,
      modified: sharedPrefix + xSuffix,
      ago_min: 1,
    },
    next: {
      original: sharedPrefix + ySuffix,
      modified: sharedPrefix + ySuffix,
    },
    expected: "append",
  },
  {
    name: "long_doc_high_similarity_small_edit",
    last: {
      original: sharedPrefix + xSuffix,
      modified: sharedPrefix + xSuffix,
      ago_min: 1,
    },
    next: {
      original: sharedPrefix + xSuffix + "!",
      modified: sharedPrefix + xSuffix + "!",
    },
    expected: "updateLast",
  },
  {
    name: "identical_input_skipped_upstream_but_decide_returns_updateLast",
    // captureHistory short-circuits via shouldSkip before calling decide,
    // but decide() in isolation should still pick updateLast (similarity=1,
    // delta=0, edges match).
    last: { original: "same", modified: "same", ago_min: 0 },
    next: { original: "same", modified: "same" },
    expected: "updateLast",
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dedupe-fixtures.json");
writeFileSync(out, JSON.stringify({ fixtures }, null, 2) + "\n");
console.log(`wrote ${out} (${fixtures.length} fixtures)`);
