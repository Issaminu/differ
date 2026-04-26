// Diff source for the merge view. Wraps the imara-diff WASM (Histogram
// algorithm) — see crates/diff-wasm/ for the Rust side — and runs it
// inside a Web Worker so big-doc keystrokes commit + paint without
// waiting for the diff to land. Chunks come back as transferred
// Int32Arrays (zero-copy).
//
// Per-call protocol:
//   1. setA / setB if the side's text has changed (reference-equality skip
//      same as before — saves ~70 MB of postMessage clone on a typical
//      keystroke that only touches one side)
//   2. compute → worker computes and posts back chunks + changes buffers
//
// No backpressure / cancellation here: requests are processed in order in
// the worker's message queue. mergeView already debounces recompute via
// scheduleRecompute so we never have more than a small handful inflight.

import { DiffChunkSet } from "./diffTypes";

const worker = new Worker(new URL("./diff.worker.ts", import.meta.url), {
  type: "module",
});

interface ComputeResponse {
  id: number;
  chunks: Int32Array;
  changes: Int32Array;
}

let nextRequestId = 1;
const pending = new Map<number, (response: ComputeResponse) => void>();

worker.onmessage = (e: MessageEvent<ComputeResponse>) => {
  const cb = pending.get(e.data.id);
  if (cb) {
    pending.delete(e.data.id);
    cb(e.data);
  }
};

let lastA: string | null = null;
let lastB: string | null = null;

export async function computeDiff(a: string, b: string): Promise<DiffChunkSet> {
  if (lastA !== a) {
    worker.postMessage({ kind: "setA", text: a });
    lastA = a;
  }
  if (lastB !== b) {
    worker.postMessage({ kind: "setB", text: b });
    lastB = b;
  }
  const id = nextRequestId++;
  const result = await new Promise<ComputeResponse>((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ kind: "compute", id, withChanges: true });
  });
  return new DiffChunkSet(result.chunks, result.changes, a, b);
}
