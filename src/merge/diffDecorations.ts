import { RangeSet, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, GutterMarker } from "@codemirror/view";

import type { DiffChunkSet } from "./diffTypes";

export type Side = "a" | "b";

// Translate diff chunks → CM decorations.
//   - changed lines on this side get .cm-changedLine (background tint)
//   - characters that actually differ within those lines get .cm-changedText
// Empty-on-this-side chunks render nothing — the line that exists is
// highlighted on the peer's side (left = original, right = new).
//
// Reads directly from the packed Int32Array buffers in `chunks` (no
// per-chunk JS objects) — that single change is the largest GC reducer in
// the recompute path at scale.
export function buildDecorations(
  side: Side,
  chunks: DiffChunkSet,
  ourDoc: Text,
): DecorationSet {
  type Entry = { from: number; to: number; deco: Decoration };
  const entries: Entry[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const fromOnSide = side === "a" ? chunks.fromA(i) : chunks.fromB(i);
    const toOnSide = side === "a" ? chunks.endA(i) : chunks.endB(i);
    if (toOnSide <= fromOnSide) continue;

    let pos = fromOnSide;
    const max = Math.min(toOnSide, ourDoc.length);
    while (pos <= max) {
      const line = ourDoc.lineAt(pos);
      entries.push({
        from: line.from,
        to: line.from,
        deco: Decoration.line({ class: "cm-changedLine" }),
      });
      if (line.to >= max) break;
      pos = line.to + 1;
    }

    const changesStart = chunks.changesStart(i);
    const changesCount = chunks.changesCount(i);
    for (let j = 0; j < changesCount; j++) {
      const idx = changesStart + j;
      const innerFrom =
        (side === "a" ? chunks.changeFromA(idx) : chunks.changeFromB(idx)) +
        fromOnSide;
      const innerTo =
        (side === "a" ? chunks.changeToA(idx) : chunks.changeToB(idx)) +
        fromOnSide;
      if (innerTo > innerFrom) {
        entries.push({
          from: innerFrom,
          to: innerTo,
          deco: Decoration.mark({ class: "cm-changedText" }),
        });
      }
    }
  }

  return Decoration.set(
    entries.map((e) => e.deco.range(e.from, e.to)),
    true,
  );
}

class ChangedGutterMarker extends GutterMarker {
  override readonly elementClass: string;
  constructor(elementClass: string) {
    super();
    this.elementClass = elementClass;
  }
}

export const removedMarker = new ChangedGutterMarker(
  "cm-changedLineGutter cm-removedLineGutter",
);
export const addedMarker = new ChangedGutterMarker(
  "cm-changedLineGutter cm-addedLineGutter",
);

// Tint the gutter (line number) for each changed line so the user can spot
// changes while scrolling massive diffs.
export function buildGutterRangeSet(
  side: Side,
  chunks: DiffChunkSet,
  doc: Text,
): RangeSet<GutterMarker> {
  const marker = side === "a" ? removedMarker : addedMarker;
  const ranges: { from: number; marker: GutterMarker }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const fromOnSide = side === "a" ? chunks.fromA(i) : chunks.fromB(i);
    const toOnSide = side === "a" ? chunks.endA(i) : chunks.endB(i);
    if (toOnSide <= fromOnSide) continue;
    let pos = fromOnSide;
    const max = Math.min(toOnSide, doc.length);
    while (pos <= max) {
      const line = doc.lineAt(pos);
      ranges.push({ from: line.from, marker });
      if (line.to >= max) break;
      pos = line.to + 1;
    }
  }
  return RangeSet.of(
    ranges.map((r) => r.marker.range(r.from)),
    true,
  );
}

export function countChangedLines(doc: Text, from: number, end: number): number {
  if (end <= from || doc.length === 0) return 0;
  const startLine = doc.lineAt(from).number;
  const endLine = doc.lineAt(Math.min(end - 1, doc.length - 1)).number;
  return endLine - startLine + 1;
}
