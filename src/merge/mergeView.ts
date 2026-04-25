import { Chunk } from "@codemirror/merge";
import {
  Compartment,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  Text,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  drawSelection,
  gutterLineClass,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  insertTab,
} from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap } from "@codemirror/search";
import { effect } from "@preact/signals-core";

import { createSearchPanel } from "./searchPanel";
import {
  diffStats,
  modifiedText,
  originalText,
  scrollLocked,
  themeMode,
} from "../state";
import { lightExtensions } from "../theme/light";
import { darkExtensions } from "../theme/dark";
import { loadLanguage } from "./languages";

// Theme + language compartments (one per pane). Compartments let us
// reconfigure these without reconstructing the entire editor.
const themeCompartmentA = new Compartment();
const themeCompartmentB = new Compartment();
const langCompartmentA = new Compartment();
const langCompartmentB = new Compartment();

function themeExt(mode: "light" | "dark"): Extension {
  return mode === "dark" ? darkExtensions : lightExtensions;
}

// Diff chunks produced by `Chunk.build(docA, docB)`. Both editors get the
// same chunk set on every doc change; each side translates them to its own
// decorations through `decorationsExt(side)`.
const setChunks = StateEffect.define<readonly Chunk[]>();
const chunksField = StateField.define<readonly Chunk[]>({
  create: () => [],
  update(chunks, tr) {
    for (const e of tr.effects) if (e.is(setChunks)) return e.value;
    return chunks;
  },
});

// Translate diff chunks → CM decorations.
//   - changed lines on this side get .cm-changedLine (background tint)
//   - characters that actually differ within those lines get .cm-changedText
// Empty-on-this-side chunks render nothing — the line that exists is
// highlighted on the peer's side (left = original, right = new).
function buildDecorations(
  side: "a" | "b",
  chunks: readonly Chunk[],
  ourDoc: Text,
): DecorationSet {
  type Entry = { from: number; to: number; deco: Decoration };
  const entries: Entry[] = [];

  for (const chunk of chunks) {
    const fromOnSide = side === "a" ? chunk.fromA : chunk.fromB;
    const toOnSide = side === "a" ? chunk.endA : chunk.endB;
    if (toOnSide <= fromOnSide) continue;

    // Mark each line that intersects [fromOnSide, toOnSide) as changed.
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

    // Inner character-level changes. `chunk.changes` positions are relative
    // to the chunk start on each side.
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

function decorationsExt(side: "a" | "b"): Extension {
  return EditorView.decorations.compute(
    [chunksField, "doc"],
    (state) => buildDecorations(side, state.field(chunksField), state.doc),
  );
}

class ChangedGutterMarker extends GutterMarker {
  constructor(public override readonly elementClass: string) {
    super();
  }
}

const removedMarker = new ChangedGutterMarker("cm-changedLineGutter cm-removedLineGutter");
const addedMarker = new ChangedGutterMarker("cm-changedLineGutter cm-addedLineGutter");

// Tint the gutter (line number) for each changed line so the user can spot
// changes while scrolling massive diffs.
function gutterLineClassExt(side: "a" | "b"): Extension {
  const marker = side === "a" ? removedMarker : addedMarker;
  return gutterLineClass.compute([chunksField, "doc"], (state) => {
    const chunks = state.field(chunksField);
    const ranges: { from: number; marker: GutterMarker }[] = [];
    for (const chunk of chunks) {
      const fromOnSide = side === "a" ? chunk.fromA : chunk.fromB;
      const toOnSide = side === "a" ? chunk.endA : chunk.endB;
      if (toOnSide <= fromOnSide) continue;
      let pos = fromOnSide;
      const max = Math.min(toOnSide, state.doc.length);
      while (pos <= max) {
        const line = state.doc.lineAt(pos);
        ranges.push({ from: line.from, marker });
        if (line.to >= max) break;
        pos = line.to + 1;
      }
    }
    return RangeSet.of(
      ranges.map((r) => r.marker.range(r.from)),
      true,
    );
  });
}

function countChangedLines(doc: Text, from: number, end: number): number {
  if (end <= from || doc.length === 0) return 0;
  const startLine = doc.lineAt(from).number;
  const endLine = doc.lineAt(Math.min(end - 1, doc.length - 1)).number;
  return endLine - startLine + 1;
}

// When the sync lock is on, pad the shorter pane's `.cm-content` so both
// panes have equal scrollable height — scrolling either side covers the
// longer pane's full range. When unlocked, padding is cleared so each pane
// stops at its own last line. Re-runs on lock toggle and on every recompute
// (doc edits change which side is shorter and by how much).
function equalizePaneHeights(
  viewA: EditorView,
  viewB: EditorView,
): { update: () => void; dispose: () => void } {
  const update = () => {
    const cA = viewA.contentDOM;
    const cB = viewB.contentDOM;
    const aPad = parseFloat(cA.style.paddingBottom) || 0;
    const bPad = parseFloat(cB.style.paddingBottom) || 0;

    let newAPad = 0;
    let newBPad = 0;
    if (scrollLocked.peek()) {
      // contentHeight includes our own padding contribution; subtract it
      // back out to get the true natural height of each side's content.
      const aH = viewA.contentHeight - aPad;
      const bH = viewB.contentHeight - bPad;
      const target = Math.max(aH, bH);
      newAPad = Math.max(0, target - aH);
      newBPad = Math.max(0, target - bH);
    }

    if (Math.round(newAPad) !== Math.round(aPad)) {
      cA.style.paddingBottom = newAPad > 0 ? `${newAPad}px` : "";
    }
    if (Math.round(newBPad) !== Math.round(bPad)) {
      cB.style.paddingBottom = newBPad > 0 ? `${newBPad}px` : "";
    }
  };

  const disposeLockEffect = effect(() => {
    scrollLocked.value;
    update();
  });

  return { update, dispose: disposeLockEffect };
}

function syncScroll(a: HTMLElement, b: HTMLElement): () => void {
  let lastSetA = -1;
  let lastSetB = -1;

  const isEcho = (self: HTMLElement, lastSet: number): boolean => {
    if (lastSet < 0) return false;
    if (self.scrollTop === lastSet) return true;
    const max = self.scrollHeight - self.clientHeight;
    return lastSet > max && Math.abs(self.scrollTop - max) <= 1;
  };

  const onA = () => {
    if (isEcho(a, lastSetA)) return;
    lastSetB = a.scrollTop;
    b.scrollTop = a.scrollTop;
  };
  const onB = () => {
    if (isEcho(b, lastSetB)) return;
    lastSetA = b.scrollTop;
    a.scrollTop = b.scrollTop;
  };

  a.addEventListener("scroll", onA, { passive: true });
  b.addEventListener("scroll", onB, { passive: true });
  return () => {
    a.removeEventListener("scroll", onA);
    b.removeEventListener("scroll", onB);
  };
}

interface PaneRef {
  views: { a: EditorView | null; b: EditorView | null };
}

function switchSide(ref: PaneRef) {
  return (editor: EditorView): boolean => {
    const { a, b } = ref.views;
    if (!a || !b) return false;
    (editor === a ? b : a).focus();
    return true;
  };
}

function baseExtensions(
  side: "a" | "b",
  mode: "light" | "dark",
  ref: PaneRef,
  onDocChange: () => void,
): Extension[] {
  const themeComp = side === "a" ? themeCompartmentA : themeCompartmentB;
  const langComp = side === "a" ? langCompartmentA : langCompartmentB;
  const switchRun = switchSide(ref);
  return [
    lineNumbers(),
    drawSelection({ cursorBlinkRate: 0 }),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    bracketMatching(),
    closeBrackets(),
    history(),
    search({ createPanel: createSearchPanel, top: true }),
    keymap.of([
      { key: "Ctrl-Tab", run: switchRun, shift: switchRun, preventDefault: true },
      { key: "Tab", run: insertTab, shift: indentLess },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
    ]),
    EditorView.lineWrapping,
    themeComp.of(themeExt(mode)),
    langComp.of([]),
    chunksField,
    decorationsExt(side),
    gutterLineClassExt(side),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      const text = u.state.doc.toString();
      if (side === "a") {
        if (originalText.peek() !== text) originalText.value = text;
      } else {
        if (modifiedText.peek() !== text) modifiedText.value = text;
      }
      onDocChange();
    }),
  ];
}

export interface MergeController {
  setDocs: (a: string, b: string) => void;
  setTheme: (mode: "light" | "dark") => void;
  setLanguage: (id: string) => Promise<void>;
  destroy: () => void;
}

export function mountMergeView(host: HTMLElement): MergeController {
  const mode = themeMode.peek();
  const ref: PaneRef = { views: { a: null, b: null } };

  // Layout: a flex row with two panes. CodeMirror handles its own scrolling
  // inside each pane, no inline-style overrides needed.
  const wrapper = document.createElement("div");
  wrapper.className = "differ-merge";
  const paneA = document.createElement("div");
  paneA.className = "differ-pane";
  paneA.dataset.side = "a";
  const paneB = document.createElement("div");
  paneB.className = "differ-pane";
  paneB.dataset.side = "b";
  wrapper.append(paneA, paneB);
  host.append(wrapper);

  let equalize:
    | { update: () => void; dispose: () => void }
    | null = null;
  const recompute = () => {
    const viewA = ref.views.a;
    const viewB = ref.views.b;
    if (!viewA || !viewB) return;
    const docA = viewA.state.doc;
    const docB = viewB.state.doc;
    const chunks = Chunk.build(docA, docB);
    viewA.dispatch({ effects: setChunks.of(chunks) });
    viewB.dispatch({ effects: setChunks.of(chunks) });

    let added = 0;
    let removed = 0;
    for (const chunk of chunks) {
      removed += countChangedLines(docA, chunk.fromA, chunk.endA);
      added += countChangedLines(docB, chunk.fromB, chunk.endB);
    }
    diffStats.value = { added, removed };

    equalize?.update();
  };

  const viewA = new EditorView({
    state: EditorState.create({
      doc: originalText.peek(),
      extensions: baseExtensions("a", mode, ref, recompute),
    }),
    parent: paneA,
  });
  const viewB = new EditorView({
    state: EditorState.create({
      doc: modifiedText.peek(),
      extensions: baseExtensions("b", mode, ref, recompute),
    }),
    parent: paneB,
  });
  ref.views.a = viewA;
  ref.views.b = viewB;

  equalize = equalizePaneHeights(viewA, viewB);

  // Initial diff after both views exist.
  recompute();

  // Scroll sync, attached only while locked.
  let stopScrollSync: (() => void) | null = null;
  const disposeScrollLockEffect = effect(() => {
    if (scrollLocked.value) {
      if (!stopScrollSync) {
        stopScrollSync = syncScroll(viewA.scrollDOM, viewB.scrollDOM);
        viewB.scrollDOM.scrollTop = viewA.scrollDOM.scrollTop;
      }
    } else if (stopScrollSync) {
      stopScrollSync();
      stopScrollSync = null;
    }
  });

  // Fn-Tab pane switch (Fn isn't reported as a modifier in CM's keymap).
  const onFnTab = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    if (!e.getModifierState || !e.getModifierState("Fn")) return;
    if (!(document.activeElement instanceof HTMLElement)) return;
    const onA = viewA.dom.contains(document.activeElement);
    const onB = viewB.dom.contains(document.activeElement);
    if (!onA && !onB) return;
    e.preventDefault();
    (onA ? viewB : viewA).focus();
  };
  document.addEventListener("keydown", onFnTab, true);

  const setDocs = (a: string, b: string) => {
    if (viewA.state.doc.toString() !== a) {
      viewA.dispatch({
        changes: { from: 0, to: viewA.state.doc.length, insert: a },
      });
    }
    if (viewB.state.doc.toString() !== b) {
      viewB.dispatch({
        changes: { from: 0, to: viewB.state.doc.length, insert: b },
      });
    }
  };

  const setTheme = (next: "light" | "dark") => {
    const ext = themeExt(next);
    viewA.dispatch({ effects: themeCompartmentA.reconfigure(ext) });
    viewB.dispatch({ effects: themeCompartmentB.reconfigure(ext) });
    document.documentElement.dataset.theme = next;
  };

  const setLanguage = async (id: string) => {
    const support = await loadLanguage(id);
    const ext: Extension = support ?? [];
    viewA.dispatch({ effects: langCompartmentA.reconfigure(ext) });
    viewB.dispatch({ effects: langCompartmentB.reconfigure(ext) });
  };

  const destroy = () => {
    document.removeEventListener("keydown", onFnTab, true);
    disposeScrollLockEffect();
    stopScrollSync?.();
    equalize?.dispose();
    viewA.destroy();
    viewB.destroy();
    wrapper.remove();
  };

  document.documentElement.dataset.theme = mode;

  return { setDocs, setTheme, setLanguage, destroy };
}

export { EditorState };
