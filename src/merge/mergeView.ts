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
  canEditBack,
  canEditForward,
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

// Browser-style back/forward over a unified snapshot history of both docs.
// Captures (textA, textB) on a short debounce after edits stop. Going back
// or forward applies the snapshot at the new index without re-capturing.
// Independent from CodeMirror's per-pane Cmd+Z — users keep both.
const NAV_DEBOUNCE_MS = 350;
const NAV_HISTORY_MAX = 50;

function installEditNav(
  viewA: EditorView,
  viewB: EditorView,
): { goBack: () => void; goForward: () => void; dispose: () => void } {
  let history: { a: string; b: string }[] = [
    {
      a: viewA.state.doc.toString(),
      b: viewB.state.doc.toString(),
    },
  ];
  let index = 0;
  let suspended = false;
  let captureTimer: ReturnType<typeof setTimeout> | null = null;

  const updateStats = () => {
    canEditBack.value = index > 0;
    canEditForward.value = index < history.length - 1;
  };
  updateStats();

  const captureNow = () => {
    if (suspended) return;
    const a = viewA.state.doc.toString();
    const b = viewB.state.doc.toString();
    const current = history[index];
    if (current && current.a === a && current.b === b) return;
    history = history.slice(0, index + 1);
    history.push({ a, b });
    if (history.length > NAV_HISTORY_MAX) {
      const drop = history.length - NAV_HISTORY_MAX;
      history = history.slice(drop);
    }
    index = history.length - 1;
    updateStats();
  };

  const dispose = effect(() => {
    originalText.value;
    modifiedText.value;
    if (suspended) return;
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = setTimeout(captureNow, NAV_DEBOUNCE_MS);
  });

  const apply = (snap: { a: string; b: string }) => {
    suspended = true;
    if (viewA.state.doc.toString() !== snap.a) {
      viewA.dispatch({
        changes: { from: 0, to: viewA.state.doc.length, insert: snap.a },
      });
    }
    if (viewB.state.doc.toString() !== snap.b) {
      viewB.dispatch({
        changes: { from: 0, to: viewB.state.doc.length, insert: snap.b },
      });
    }
    suspended = false;
  };

  const goBack = () => {
    if (index <= 0) return;
    index--;
    apply(history[index]);
    updateStats();
  };

  const goForward = () => {
    if (index >= history.length - 1) return;
    index++;
    apply(history[index]);
    updateStats();
  };

  return {
    goBack,
    goForward,
    dispose: () => {
      if (captureTimer) clearTimeout(captureTimer);
      dispose();
      canEditBack.value = false;
      canEditForward.value = false;
    },
  };
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
  gotoChunk: (direction: "next" | "prev") => void;
  goBack: () => void;
  goForward: () => void;
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
  const editNav = installEditNav(viewA, viewB);

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

  const gotoChunk = (direction: "next" | "prev") => {
    const view = viewA.hasFocus ? viewA : viewB.hasFocus ? viewB : viewA;
    const chunks = view.state.field(chunksField);
    if (chunks.length === 0) return;

    const side: "a" | "b" = view === viewA ? "a" : "b";
    const startOf = (i: number) =>
      side === "a" ? chunks[i].fromA : chunks[i].fromB;
    const cursor = view.state.selection.main.head;

    let target: number | null = null;
    if (direction === "next") {
      for (let i = 0; i < chunks.length; i++) {
        if (startOf(i) > cursor) {
          target = startOf(i);
          break;
        }
      }
      if (target === null) target = startOf(0);
    } else {
      for (let i = chunks.length - 1; i >= 0; i--) {
        if (startOf(i) < cursor) {
          target = startOf(i);
          break;
        }
      }
      if (target === null) target = startOf(chunks.length - 1);
    }

    const pos = Math.min(Math.max(target, 0), view.state.doc.length);
    view.focus();
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
  };

  const destroy = () => {
    document.removeEventListener("keydown", onFnTab, true);
    disposeScrollLockEffect();
    stopScrollSync?.();
    equalize?.dispose();
    editNav.dispose();
    viewA.destroy();
    viewB.destroy();
    wrapper.remove();
  };

  document.documentElement.dataset.theme = mode;

  return {
    setDocs,
    setTheme,
    setLanguage,
    gotoChunk,
    goBack: editNav.goBack,
    goForward: editNav.goForward,
    destroy,
  };
}

export { EditorState };
