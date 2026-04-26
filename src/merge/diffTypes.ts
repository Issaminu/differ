// Shared structural types for diff chunks. The merge view consumes a
// `DiffChunkSet` that's backed by two flat `Int32Array` buffers from the
// imara-diff WASM (see crates/diff-wasm/). Reading chunk fields by index
// instead of materialising ~100 k JS objects per recompute eliminates the
// next-largest GC contributor at scale per the trace analysis.
//
// `DiffChunk` / `DiffChange` remain as the convenient single-chunk shape
// for places that only need to inspect one chunk (tests, the Node bench,
// validation). They aren't allocated per chunk in the editor path.

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

// One chunk = 6 ints in the packed buffer:
//   [fromA, endA, fromB, endB, changesStart, changesCount]
export const CHUNK_STRIDE = 6;
// One change = 4 ints in the packed buffer:
//   [fromA, toA, fromB, toB]
export const CHANGE_STRIDE = 4;

export class DiffChunkSet {
  constructor(
    private readonly chunks: Int32Array,
    private readonly changes: Int32Array,
    public readonly aText: string,
    public readonly bText: string,
  ) {}

  static empty(): DiffChunkSet {
    return new DiffChunkSet(new Int32Array(0), new Int32Array(0), "", "");
  }

  get length(): number {
    return this.chunks.length / CHUNK_STRIDE;
  }

  fromA(i: number): number {
    return this.chunks[i * CHUNK_STRIDE];
  }
  endA(i: number): number {
    return this.chunks[i * CHUNK_STRIDE + 1];
  }
  fromB(i: number): number {
    return this.chunks[i * CHUNK_STRIDE + 2];
  }
  endB(i: number): number {
    return this.chunks[i * CHUNK_STRIDE + 3];
  }
  changesStart(i: number): number {
    return this.chunks[i * CHUNK_STRIDE + 4];
  }
  changesCount(i: number): number {
    return this.chunks[i * CHUNK_STRIDE + 5];
  }

  // Inner-change accessors. `idx` is an absolute index into the changes
  // array (i.e. `changesStart(i) + j` for the jth change of chunk i).
  changeFromA(idx: number): number {
    return this.changes[idx * CHANGE_STRIDE];
  }
  changeToA(idx: number): number {
    return this.changes[idx * CHANGE_STRIDE + 1];
  }
  changeFromB(idx: number): number {
    return this.changes[idx * CHANGE_STRIDE + 2];
  }
  changeToB(idx: number): number {
    return this.changes[idx * CHANGE_STRIDE + 3];
  }

  // Convenience for code that wants the array-of-objects view (tests,
  // bench harness). Don't use this on the hot path — that's the whole
  // point of the packed layout.
  toArray(): DiffChunk[] {
    const out: DiffChunk[] = [];
    for (let i = 0; i < this.length; i++) {
      const start = this.changesStart(i);
      const count = this.changesCount(i);
      const changes: DiffChange[] = [];
      for (let j = 0; j < count; j++) {
        const idx = start + j;
        changes.push({
          fromA: this.changeFromA(idx),
          toA: this.changeToA(idx),
          fromB: this.changeFromB(idx),
          toB: this.changeToB(idx),
        });
      }
      out.push({
        fromA: this.fromA(i),
        endA: this.endA(i),
        fromB: this.fromB(i),
        endB: this.endB(i),
        changes,
      });
    }
    return out;
  }
}
