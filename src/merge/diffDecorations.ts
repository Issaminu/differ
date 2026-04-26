import type { Chunk } from "@codemirror/merge";
import { RangeSet, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, GutterMarker } from "@codemirror/view";

export type Side = "a" | "b";

// Translate diff chunks → CM decorations.
//   - changed lines on this side get .cm-changedLine (background tint)
//   - characters that actually differ within those lines get .cm-changedText
// Empty-on-this-side chunks render nothing — the line that exists is
// highlighted on the peer's side (left = original, right = new).
export function buildDecorations(
  side: Side,
  chunks: readonly Chunk[],
  ourDoc: Text,
): DecorationSet {
  type Entry = { from: number; to: number; deco: Decoration };
  const entries: Entry[] = [];

  for (const chunk of chunks) {
    const fromOnSide = side === "a" ? chunk.fromA : chunk.fromB;
    const toOnSide = side === "a" ? chunk.endA : chunk.endB;
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

    for (const change of chunk.changes) {
      const innerFrom =
        (side === "a" ? change.fromA : change.fromB) + fromOnSide;
      const innerTo =
        (side === "a" ? change.toA : change.toB) + fromOnSide;
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
  chunks: readonly Chunk[],
  doc: Text,
): RangeSet<GutterMarker> {
  const marker = side === "a" ? removedMarker : addedMarker;
  const ranges: { from: number; marker: GutterMarker }[] = [];
  for (const chunk of chunks) {
    const fromOnSide = side === "a" ? chunk.fromA : chunk.fromB;
    const toOnSide = side === "a" ? chunk.endA : chunk.endB;
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
