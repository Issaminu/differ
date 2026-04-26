// Diff source for the merge view. Wraps the imara-diff WASM (Histogram
// algorithm) — see crates/diff-wasm/ for the Rust side.
//
// Uses a stateful DiffSession so the unchanged side of the doc isn't
// re-copied into WASM memory on every recompute. On a per-keystroke
// recompute against a 70 MB doc that drops one full JS→WASM string copy
// (~70 MB of allocation churn) — measured as the next-largest GC source
// after the cached-string change in mergeView.ts.

import {
  DiffSession,
} from "../../crates/diff-wasm/pkg-bundler/differ_diff_wasm.js";
import type { DiffChunk } from "./diffTypes";

const session = new DiffSession();
let lastA: string | null = null;
let lastB: string | null = null;

export function computeDiff(a: string, b: string): readonly DiffChunk[] {
  // Reference-equality check: when handleDocChange only updates side B,
  // syncedOriginal still points at the same string instance, so we skip
  // pushing it across the WASM boundary again.
  if (lastA !== a) {
    session.set_a(a);
    lastA = a;
  }
  if (lastB !== b) {
    session.set_b(b);
    lastB = b;
  }
  return session.diff_with_changes() as readonly DiffChunk[];
}
