const CHUNK_STRIDE = 6;
const CHANGE_STRIDE = 4;

export interface DiffSessionLike {
  set_a(text: string): void;
  set_b(text: string): void;
  compute_packed(withChanges: boolean): void;
  chunks_buffer(): Int32Array;
  changes_buffer(): Int32Array;
}

// Structural match for src/merge/diffTypes.ts without importing that runtime
// class. Node's built-in TS runner cannot strip constructor parameter
// properties, so importing DiffChunkSet directly breaks the bench scripts.
export class BenchDiffChunkSet {
  private readonly chunks: Int32Array;
  private readonly changes: Int32Array;
  readonly aText: string;
  readonly bText: string;

  constructor(chunks: Int32Array, changes: Int32Array, aText: string, bText: string) {
    this.chunks = chunks;
    this.changes = changes;
    this.aText = aText;
    this.bText = bText;
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
}

export function chunkSetFromSession(
  session: DiffSessionLike,
  aText: string,
  bText: string,
): BenchDiffChunkSet {
  return new BenchDiffChunkSet(
    session.chunks_buffer(),
    session.changes_buffer(),
    aText,
    bText,
  );
}

export function computeChunkSet(
  session: DiffSessionLike,
  aText: string,
  bText: string,
  withChanges = true,
): BenchDiffChunkSet {
  session.set_a(aText);
  session.set_b(bText);
  session.compute_packed(withChanges);
  return chunkSetFromSession(session, aText, bText);
}

export function insertOneCharAtMiddle(text: string): string {
  const insertAt = Math.floor(text.length / 2);
  return text.slice(0, insertAt) + "x" + text.slice(insertAt);
}

export function viewportAround(text: string, center: number, width = 12_000): [number, number] {
  const half = Math.floor(width / 2);
  const from = Math.max(0, center - half);
  return [from, Math.min(text.length, from + width)];
}
