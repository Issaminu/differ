import { RangeSet } from "@codemirror/state";
import { Decoration, type DecorationSet, GutterMarker } from "@codemirror/view";

import type { DiffChunkSet } from "./diffTypes";

export type Side = "a" | "b";

// Translate diff chunks → CM decorations.
//   - changed lines on this side get .cm-changedLine (background tint)
//   - characters that actually differ within those lines get .cm-changedText
// Empty-on-this-side chunks render nothing — the line that exists is
// highlighted on the peer's side (left = original, right = new).
//
// We walk newlines directly through the cached doc string the chunk set
// carries, instead of calling `doc.lineAt(pos)` per line. On a 70 MB
// rename with ~100 k chunks that swap saves ~500 ms (the previous
// `lineInner` hot spot in the trace).
export function buildDecorations(
  side: Side,
  chunks: DiffChunkSet,
): DecorationSet {
  type Entry = { from: number; to: number; deco: Decoration };
  const entries: Entry[] = [];
  const text = side === "a" ? chunks.aText : chunks.bText;
  const lineDeco = Decoration.line({ class: "cm-changedLine" });
  const charDeco = Decoration.mark({ class: "cm-changedText" });

  for (let i = 0; i < chunks.length; i++) {
    const fromOnSide = side === "a" ? chunks.fromA(i) : chunks.fromB(i);
    const toOnSide = side === "a" ? chunks.endA(i) : chunks.endB(i);
    if (toOnSide <= fromOnSide) continue;

    // Each line in [fromOnSide, toOnSide) gets a .cm-changedLine decoration
    // at its start. We find line starts by scanning forward for "\n".
    const max = Math.min(toOnSide, text.length);
    let lineFrom = fromOnSide;
    while (lineFrom <= max) {
      entries.push({ from: lineFrom, to: lineFrom, deco: lineDeco });
      const nl = text.indexOf("\n", lineFrom);
      if (nl < 0 || nl >= max) break;
      lineFrom = nl + 1;
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
        entries.push({ from: innerFrom, to: innerTo, deco: charDeco });
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
): RangeSet<GutterMarker> {
  const marker = side === "a" ? removedMarker : addedMarker;
  const ranges: { from: number; marker: GutterMarker }[] = [];
  const text = side === "a" ? chunks.aText : chunks.bText;
  for (let i = 0; i < chunks.length; i++) {
    const fromOnSide = side === "a" ? chunks.fromA(i) : chunks.fromB(i);
    const toOnSide = side === "a" ? chunks.endA(i) : chunks.endB(i);
    if (toOnSide <= fromOnSide) continue;
    const max = Math.min(toOnSide, text.length);
    let lineFrom = fromOnSide;
    while (lineFrom <= max) {
      ranges.push({ from: lineFrom, marker });
      const nl = text.indexOf("\n", lineFrom);
      if (nl < 0 || nl >= max) break;
      lineFrom = nl + 1;
    }
  }
  return RangeSet.of(
    ranges.map((r) => r.marker.range(r.from)),
    true,
  );
}

// Count newline-separated lines in `text` covered by `[from, end)`. A
// non-empty range always covers at least one line (the line containing
// `from`); each "\n" inside the range starts another. Used by
// syncDiffState's stats counter — was previously `doc.lineAt` × 2 per
// chunk per side.
export function countChangedLines(text: string, from: number, end: number): number {
  if (end <= from) return 0;
  if (text.length === 0) return 0;
  const stop = Math.min(end - 1, text.length);
  let count = 1;
  let pos = from;
  while (pos < stop) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0 || nl >= stop) break;
    count++;
    pos = nl + 1;
  }
  return count;
}
