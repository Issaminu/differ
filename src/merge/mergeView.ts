import { MergeView } from "@codemirror/merge";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, keymap, drawSelection } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap, insertTab, indentLess } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap } from "@codemirror/search";
import { createSearchPanel } from "./searchPanel";

import { effect } from "@preact/signals-core";
import { originalText, modifiedText, themeMode, scrollLocked } from "../state";
import { lightExtensions } from "../theme/light";
import { darkExtensions } from "../theme/dark";
import { loadLanguage } from "./languages";

const themeCompartmentA = new Compartment();
const themeCompartmentB = new Compartment();
const langCompartmentA = new Compartment();
const langCompartmentB = new Compartment();

function themeExt(mode: "light" | "dark"): Extension {
  return mode === "dark" ? darkExtensions : lightExtensions;
}

// Per-pane fill-height + scroll: each pane's `.cm-scroller` becomes the actual
// scroller (flex: 1) so the editor fills the viewport and search panels can
// sit in the normal flex flow above the scroller. The merge library's base
// theme forces `.cm-scroller` to `height: auto !important` + `overflow-y:
// visible !important`, which loses only to *inline* `!important`. We apply
// those inline after mount (see `forcePerPaneScroll`).

interface MergeRef {
  view: MergeView | null;
}

function switchSide(ref: MergeRef) {
  return (editor: EditorView): boolean => {
    const merge = ref.view;
    if (!merge) return false;
    const other = editor === merge.a ? merge.b : merge.a;
    other.focus();
    return true;
  };
}

function baseExtensions(
  side: "a" | "b",
  mode: "light" | "dark",
  ref: MergeRef,
): Extension[] {
  const themeComp = side === "a" ? themeCompartmentA : themeCompartmentB;
  const langComp = side === "a" ? langCompartmentA : langCompartmentB;
  const switchRun = switchSide(ref);
  return [
    lineNumbers(),
    // Replace native contenteditable caret with a managed DOM cursor —
    // rapid Tab presses left a ghost caret on the native one.
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
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      const text = u.state.doc.toString();
      if (side === "a") {
        if (originalText.peek() !== text) originalText.value = text;
      } else {
        if (modifiedText.peek() !== text) modifiedText.value = text;
      }
    }),
  ];
}

// Pad the shorter pane's .cm-content with bottom padding so both panes have
// the same scrollable height. The comparison-against-current-padding keeps
// this stable (no ResizeObserver loop once the padding is correct).
function equalizePaneHeights(
  aScroll: HTMLElement,
  bScroll: HTMLElement,
): () => void {
  const contentA = aScroll.querySelector<HTMLElement>(".cm-content");
  const contentB = bScroll.querySelector<HTMLElement>(".cm-content");
  if (!contentA || !contentB) return () => {};

  const equalize = () => {
    const aPad = parseFloat(contentA.style.paddingBottom) || 0;
    const bPad = parseFloat(contentB.style.paddingBottom) || 0;
    const aNat = contentA.offsetHeight - aPad;
    const bNat = contentB.offsetHeight - bPad;
    const target = Math.max(aNat, bNat);
    const newAPad = Math.max(0, target - aNat);
    const newBPad = Math.max(0, target - bNat);
    if (Math.round(newAPad) !== Math.round(aPad)) {
      contentA.style.paddingBottom = newAPad > 0 ? `${newAPad}px` : "";
    }
    if (Math.round(newBPad) !== Math.round(bPad)) {
      contentB.style.paddingBottom = newBPad > 0 ? `${newBPad}px` : "";
    }
  };

  const ro = new ResizeObserver(equalize);
  ro.observe(contentA);
  ro.observe(contentB);
  equalize();

  return () => ro.disconnect();
}

// Mirror vertical scroll between the two panes so diff lines stay aligned.
// We break the feedback loop by remembering the value we *just set* on each
// side — the echo scroll event will see its scrollTop already match and bail.
// A set past the target's max is clamped by the browser; we also treat that
// as an echo, otherwise the clamped value would propagate back to the source
// and drag the user's scroll back whenever the shorter side hit its max.
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

// Override the library's `height: auto !important` / `overflow-y: visible
// !important` on the per-pane scroller. Inline !important is the only way to
// beat an external !important with equal specificity + later source order.
function forcePerPaneScroll(host: HTMLElement): void {
  const editors = host.querySelectorAll<HTMLElement>(".cm-editor");
  editors.forEach((el) => {
    el.style.setProperty("height", "100%", "important");
    el.style.minHeight = "0";
  });
  const scrollers = host.querySelectorAll<HTMLElement>(".cm-scroller");
  scrollers.forEach((el) => {
    el.style.setProperty("overflow", "auto", "important");
    el.style.setProperty("height", "100%", "important");
    el.style.minHeight = "0";
    el.style.flex = "1 1 auto";
  });
}

export interface MergeController {
  view: MergeView;
  setDocs: (a: string, b: string) => void;
  setTheme: (mode: "light" | "dark") => void;
  setLanguage: (id: string) => Promise<void>;
  destroy: () => void;
}

export function mountMergeView(host: HTMLElement): MergeController {
  const mode = themeMode.peek();
  const ref: MergeRef = { view: null };

  const view = new MergeView({
    a: {
      doc: originalText.peek(),
      extensions: baseExtensions("a", mode, ref),
    },
    b: {
      doc: modifiedText.peek(),
      extensions: baseExtensions("b", mode, ref),
    },
    parent: host,
    orientation: "a-b",
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: { margin: 3, minSize: 4 },
  });

  ref.view = view;

  forcePerPaneScroll(host);
  const stopEqualize = equalizePaneHeights(view.a.scrollDOM, view.b.scrollDOM);

  // Attach/detach scroll sync based on the scrollLocked signal.
  let stopScrollSync: (() => void) | null = null;
  const disposeScrollLockEffect = effect(() => {
    if (scrollLocked.value) {
      if (!stopScrollSync) {
        stopScrollSync = syncScroll(view.a.scrollDOM, view.b.scrollDOM);
        // Align positions immediately so the non-leading pane catches up.
        view.b.scrollDOM.scrollTop = view.a.scrollDOM.scrollTop;
      }
    } else if (stopScrollSync) {
      stopScrollSync();
      stopScrollSync = null;
    }
  });

  // Fn doesn't show up as a modifier in most keyboard events, so CM's
  // keymap parser can't bind "Fn-Tab". Intercept at the document level
  // and route to the same switch logic. getModifierState("Fn") works in
  // WebKit on macOS; elsewhere this is a no-op.
  const onFnTab = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    if (!e.getModifierState || !e.getModifierState("Fn")) return;
    if (!(document.activeElement instanceof HTMLElement)) return;
    const onA = view.a.dom.contains(document.activeElement);
    const onB = view.b.dom.contains(document.activeElement);
    if (!onA && !onB) return;
    e.preventDefault();
    (onA ? view.b : view.a).focus();
  };
  document.addEventListener("keydown", onFnTab, true);

  const setDocs = (a: string, b: string) => {
    const viewA = view.a;
    const viewB = view.b;
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

  const setTheme = (mode: "light" | "dark") => {
    const ext = themeExt(mode);
    view.a.dispatch({ effects: themeCompartmentA.reconfigure(ext) });
    view.b.dispatch({ effects: themeCompartmentB.reconfigure(ext) });
    document.documentElement.dataset.theme = mode;
  };

  const setLanguage = async (id: string) => {
    const support = await loadLanguage(id);
    const ext: Extension = support ?? [];
    view.a.dispatch({ effects: langCompartmentA.reconfigure(ext) });
    view.b.dispatch({ effects: langCompartmentB.reconfigure(ext) });
  };

  const destroy = () => {
    document.removeEventListener("keydown", onFnTab, true);
    disposeScrollLockEffect();
    stopScrollSync?.();
    stopEqualize();
    view.destroy();
  };

  document.documentElement.dataset.theme = mode;

  return { view, setDocs, setTheme, setLanguage, destroy };
}

export { EditorState };
