import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Text,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  type ViewUpdate,
  drawSelection,
  gutterLineClass,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
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
import {
  buildDecorations,
  buildGutterRangeSet,
  countChangedLines,
} from "./diffDecorations";
import { computeDiff } from "./diff";
import { DiffChunkSet } from "./diffTypes";

// Theme + language compartments (one per pane). Compartments let us
// reconfigure these without reconstructing the entire editor.
const themeCompartmentA = new Compartment();
const themeCompartmentB = new Compartment();
const langCompartmentA = new Compartment();
const langCompartmentB = new Compartment();

function themeExt(mode: "light" | "dark"): Extension {
  return mode === "dark" ? darkExtensions : lightExtensions;
}

// Diff chunks produced by `computeDiff(a, b)` (imara-diff via WASM). Both
// editors get the same chunk set on every doc change; each side translates
// them to its own decorations through `decorationsExt(side)`. The set is
// a packed-Int32Array view (DiffChunkSet) — see diffTypes.ts.
const setChunks = StateEffect.define<DiffChunkSet>();
const chunksField = StateField.define<DiffChunkSet>({
  create: () => DiffChunkSet.empty(),
  update(chunks, tr) {
    for (const e of tr.effects) if (e.is(setChunks)) return e.value;
    return chunks;
  },
});

function decorationsExt(side: "a" | "b"): Extension {
  return EditorView.decorations.compute(
    [chunksField, "doc"],
    (state) => buildDecorations(side, state.field(chunksField), state.doc),
  );
}

function gutterLineClassExt(side: "a" | "b"): Extension {
  return gutterLineClass.compute([chunksField, "doc"], (state) =>
    buildGutterRangeSet(side, state.field(chunksField), state.doc),
  );
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

function textFromString(value: string): Text {
  return Text.of(value.split("\n"));
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
  applyDocs: (
    a: Text,
    b: Text,
    options?: { syncSignalsFromDocs?: boolean },
  ) => void,
): { goBack: () => void; goForward: () => void; dispose: () => void } {
  let history: { a: Text; b: Text }[] = [
    {
      a: viewA.state.doc,
      b: viewB.state.doc,
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
    const a = viewA.state.doc;
    const b = viewB.state.doc;
    const current = history[index];
    if (current && current.a.eq(a) && current.b.eq(b)) return;
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

  const apply = (snap: { a: Text; b: Text }) => {
    suspended = true;
    applyDocs(snap.a, snap.b, { syncSignalsFromDocs: true });
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
  onDocChange: (update: ViewUpdate) => void,
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
    search({ createPanel: createSearchPanel, top: true }),
    keymap.of([
      { key: "Ctrl-Tab", run: switchRun, shift: switchRun, preventDefault: true },
      { key: "Tab", run: insertTab, shift: indentLess },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
    ]),
    EditorView.lineWrapping,
    themeComp.of(themeExt(mode)),
    langComp.of([]),
    chunksField,
    decorationsExt(side),
    gutterLineClassExt(side),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      onDocChange(u);
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
  let bulkDocUpdateDepth = 0;
  let syncedOriginal = originalText.peek();
  let syncedModified = modifiedText.peek();

  const syncSignals = (a: string, b: string) => {
    syncedOriginal = a;
    syncedModified = b;
    if (originalText.peek() !== a) originalText.value = a;
    if (modifiedText.peek() !== b) modifiedText.value = b;
  };

  const syncDiffState = (
    chunks: DiffChunkSet,
    docA: Text,
    docB: Text,
  ) => {
    const left = ref.views.a;
    const right = ref.views.b;
    if (!left || !right) return;

    left.dispatch({ effects: setChunks.of(chunks) });
    right.dispatch({ effects: setChunks.of(chunks) });

    let added = 0;
    let removed = 0;
    for (let i = 0; i < chunks.length; i++) {
      removed += countChangedLines(docA, chunks.fromA(i), chunks.endA(i));
      added += countChangedLines(docB, chunks.fromB(i), chunks.endB(i));
    }
    diffStats.value = { added, removed };

    equalize?.update();
  };

  // Imara is fast enough that a full re-diff per change beats the old
  // incremental updateA/updateB path on big docs and matches it on small
  // ones (see bench/baseline-results.txt). One code path, no chunk-set
  // surgery to maintain.
  //
  // We rely on `syncedOriginal` / `syncedModified` being kept in lockstep
  // with the editor docs — they're updated in `setDocs`, in
  // `handleDocChange` (per-keystroke), in `applyDocs(syncSignalsFromDocs)`
  // (history restore), and used here directly. That avoids two
  // full-document `toString()` allocations on every recompute, which at
  // 70 MB per side is ~140 MB of churn we'd otherwise pay each call —
  // the dominant garbage producer per the trace analysis.
  const recompute = () => {
    const left = ref.views.a;
    const right = ref.views.b;
    if (!left || !right) return;
    syncDiffState(
      computeDiff(syncedOriginal, syncedModified),
      left.state.doc,
      right.state.doc,
    );
  };

  // Defer the diff to the next frame so the keystroke transaction can
  // commit and paint without waiting for `computeDiff`. On a 70 MB doc
  // that drops keystroke latency from ~1 s to one frame; the highlight
  // catches up a frame later. Coalesces a burst of edits into a single
  // recompute (only the latest one matters — full re-diff anyway).
  let pendingRecompute = false;
  const scheduleRecompute = () => {
    if (pendingRecompute) return;
    pendingRecompute = true;
    requestAnimationFrame(() => {
      pendingRecompute = false;
      recompute();
    });
  };

  const handleDocChange = (side: "a" | "b") => (u: ViewUpdate) => {
    const left = ref.views.a;
    const right = ref.views.b;
    if (!left || !right) return;
    if (bulkDocUpdateDepth > 0) return;

    const text = u.state.doc.toString();
    if (side === "a") {
      syncedOriginal = text;
      if (originalText.peek() !== text) originalText.value = text;
    } else {
      syncedModified = text;
      if (modifiedText.peek() !== text) modifiedText.value = text;
    }
    scheduleRecompute();
  };

  const viewA = new EditorView({
    state: EditorState.create({
      doc: originalText.peek(),
      extensions: baseExtensions("a", mode, ref, handleDocChange("a")),
    }),
    parent: paneA,
  });
  const viewB = new EditorView({
    state: EditorState.create({
      doc: modifiedText.peek(),
      extensions: baseExtensions("b", mode, ref, handleDocChange("b")),
    }),
    parent: paneB,
  });
  ref.views.a = viewA;
  ref.views.b = viewB;

  equalize = equalizePaneHeights(viewA, viewB);
  const applyDocs = (
    nextA: Text,
    nextB: Text,
    options?: { syncSignalsFromDocs?: boolean },
  ) => {
    let changed = false;
    bulkDocUpdateDepth++;
    try {
      if (!viewA.state.doc.eq(nextA)) {
        viewA.dispatch({
          changes: { from: 0, to: viewA.state.doc.length, insert: nextA },
        });
        changed = true;
      }
      if (!viewB.state.doc.eq(nextB)) {
        viewB.dispatch({
          changes: { from: 0, to: viewB.state.doc.length, insert: nextB },
        });
        changed = true;
      }
    } finally {
      bulkDocUpdateDepth--;
    }
    if (changed) recompute();
    if (options?.syncSignalsFromDocs) {
      syncSignals(viewA.state.doc.toString(), viewB.state.doc.toString());
    }
  };
  const editNav = installEditNav(viewA, viewB, applyDocs);

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
    if (a === syncedOriginal && b === syncedModified) return;
    syncedOriginal = a;
    syncedModified = b;
    applyDocs(textFromString(a), textFromString(b));
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
      side === "a" ? chunks.fromA(i) : chunks.fromB(i);
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
