// Diff source for the merge view. Wraps the imara-diff WASM (Histogram
// algorithm) — see crates/diff-wasm/ for the Rust side. Always does a full
// re-diff; numbers in bench/baseline-results.txt show this is well under
// one frame even on 10k-line inputs, so we don't need an incremental
// "updateB" path the way `@codemirror/merge` did.

import { diff_with_changes } from "../../crates/diff-wasm/pkg-bundler/differ_diff_wasm.js";
import type { DiffChunk } from "./diffTypes";

export function computeDiff(a: string, b: string): readonly DiffChunk[] {
  return diff_with_changes(a, b) as readonly DiffChunk[];
}
