// Shared structural types for diff chunks. Both `@codemirror/merge`'s
// `Chunk` (which we no longer call into) and the imara-diff WASM wrapper
// emit objects shaped like this; defining the interface centrally keeps
// `mergeView.ts`, `diffDecorations.ts`, and the diff source decoupled from
// any concrete implementation.

export interface DiffChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

export interface DiffChunk {
  fromA: number;
  endA: number;
  fromB: number;
  endB: number;
  changes: readonly DiffChange[];
}
