// Diff source for the merge view. Wraps the imara-diff WASM (Histogram
// algorithm) — see crates/diff-wasm/ for the Rust side.
//
// Uses a stateful DiffSession + the packed-Int32Array output path so the
// per-recompute work is two arena-style buffers (one for chunks, one for
// changes), not ~100 k chunk objects materialised through serde-wasm-bindgen.
// Combined with set_a/set_b reference-equality skipping, a per-keystroke
// recompute on a 70 MB doc avoids two of the three big GC contributors that
// the trace analysis surfaced.
//
// Note: we tried moving this into a Web Worker (commit b96241c, since
// reverted). Paste improved 15–18% but big-doc scroll regressed 45–80%
// because the worker's allocation activity competed with main-thread
// rendering. Bench numbers said it wasn't worth it; the keystroke
// "responsiveness" theoretical win didn't show up because total work
// time is unchanged. Sync stays.

import {
  DiffSession,
} from "../../crates/diff-wasm/pkg-bundler/differ_diff_wasm.js";
import { DiffChunkSet } from "./diffTypes";

const session = new DiffSession();
let lastA: string | null = null;
let lastB: string | null = null;

export function computeDiff(a: string, b: string): DiffChunkSet {
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
  session.compute_packed(true);
  return new DiffChunkSet(session.chunks_buffer(), session.changes_buffer(), a, b);
}
