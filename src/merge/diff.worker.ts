// Web Worker that owns the imara-diff WASM session. The main thread sends
// set-a / set-b / compute messages; the worker replies to compute with the
// chunks + changes Int32Arrays transferred zero-copy.
//
// Why a worker: at 70 MB the imara compute is ~600 ms of single-threaded
// CPU. Doing it on the main thread freezes the UI during that window. A
// worker keeps the editor responsive — keystrokes commit and paint
// instantly, the diff catches up whenever the worker finishes.

import { DiffSession } from "../../crates/diff-wasm/pkg-bundler/differ_diff_wasm.js";

const session = new DiffSession();

interface SetMsg {
  kind: "setA" | "setB";
  text: string;
}
interface ComputeMsg {
  kind: "compute";
  id: number;
  withChanges: boolean;
}

type WorkerMsg = SetMsg | ComputeMsg;

self.onmessage = (e: MessageEvent<WorkerMsg>) => {
  const msg = e.data;
  if (msg.kind === "setA") {
    session.set_a(msg.text);
    return;
  }
  if (msg.kind === "setB") {
    session.set_b(msg.text);
    return;
  }
  if (msg.kind === "compute") {
    session.compute_packed(msg.withChanges);
    const chunks = session.chunks_buffer();
    const changes = session.changes_buffer();
    // Transfer the underlying ArrayBuffers — zero-copy across the worker
    // boundary. The worker's references become detached after this; that's
    // fine because chunks_buffer/changes_buffer return fresh JS Int32Arrays
    // each call (copied from the Rust-owned Vec).
    (self as unknown as Worker).postMessage(
      { id: msg.id, chunks, changes },
      { transfer: [chunks.buffer, changes.buffer] },
    );
  }
};
