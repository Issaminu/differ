// Diff source for the merge view. Wraps the imara-diff WASM (Histogram
// algorithm) — see crates/diff-wasm/ for the Rust side.
//
// Uses a stateful DiffSession + the packed-Int32Array output path so the
// per-recompute work is two arena-style buffers (one for chunks, one for
// changes), not ~100 k chunk objects materialised through serde-wasm-bindgen.
// Combined with set_a/set_b reference-equality skipping, a per-keystroke
// recompute on a 70 MB doc avoids two of the three big GC contributors that
// the trace analysis surfaced.

import {
  DiffSession,
} from "../../crates/diff-wasm/pkg-bundler/differ_diff_wasm.js";
import { DiffChunkSet } from "./diffTypes";

const session = new DiffSession();
let lastA: string | null = null;
let lastB: string | null = null;

export function computeDiff(a: string, b: string): DiffChunkSet {
  if (lastA !== a) {
    session.set_a(a);
    lastA = a;
  }
  if (lastB !== b) {
    session.set_b(b);
    lastB = b;
  }
  session.compute_packed(true);
  return new DiffChunkSet(session.chunks_buffer(), session.changes_buffer(), a, b);
}
