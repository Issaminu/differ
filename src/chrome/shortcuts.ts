import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import {
  historyOpen,
  resetBothDocs,
  swapSides,
} from "../state";
import { forceCapture } from "../history/pipeline";

function isMetaOrCtrl(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

export interface ShortcutHandlers {
  gotoChunk: (direction: "next" | "prev") => void;
  goBack: () => void;
  goForward: () => void;
}

export function installShortcuts(handlers: ShortcutHandlers): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    // ⌥↑ / ⌥↓ — jump to previous / next change.
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        handlers.gotoChunk("prev");
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        handlers.gotoChunk("next");
        return;
      }
    }

    if (!isMetaOrCtrl(e)) return;

    const k = e.key.toLowerCase();

    // ⌘Z / ⌘⇧Z (and ⌘Y) — unified back/forward across both panes.
    if (k === "z" && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) handlers.goForward();
      else handlers.goBack();
      return;
    }
    if (k === "y" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handlers.goForward();
      return;
    }

    // ⌘F — open search and always focus the Find field (CM's default would
    // leave Replace focused if it was the last field used).
    if (k === "f" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      openFind();
      return;
    }

    // ⌘H — find & replace (toggles focus between search and replace inputs)
    if (k === "h" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      openFindReplace();
      return;
    }

    // ⌘B — toggle history
    if (k === "b" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      historyOpen.value = !historyOpen.peek();
      return;
    }

    // ⌘⇧S — swap
    if (e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      swapSides();
      return;
    }

    // ⌘⇧N — force new history entry
    if (e.shiftKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      void forceCapture();
      return;
    }

    // ⌘⇧Backspace — clear both
    if (e.shiftKey && (e.key === "Backspace" || e.key === "Delete")) {
      e.preventDefault();
      resetBothDocs();
      return;
    }
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

function focusedOrFirstEditor(): EditorView | null {
  // Walk up from the active element — once the search panel is open its input
  // has focus (so .cm-editor.cm-focused is no longer set), but activeElement
  // is still inside the owning pane's .cm-editor.
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const el = active.closest<HTMLElement>(".cm-editor");
    if (el) {
      const v = EditorView.findFromDOM(el);
      if (v) return v;
    }
  }
  const focused = document.querySelector<HTMLElement>(".cm-editor.cm-focused");
  if (focused) {
    const v = EditorView.findFromDOM(focused);
    if (v) return v;
  }
  const first = document.querySelector<HTMLElement>(".cm-editor");
  if (!first) return null;
  return EditorView.findFromDOM(first);
}

// Open the search panel and focus the Find field (leaves the Replace row
// state as-is — doesn't expand or collapse it).
function openFind(): void {
  const view = focusedOrFirstEditor();
  if (!view) return;
  if (!document.activeElement || !view.dom.contains(document.activeElement)) {
    view.focus();
  }
  openSearchPanel(view);
  requestAnimationFrame(() => {
    const panel = view.dom.querySelector<HTMLElement>(".cm-vs-search");
    if (!panel) return;
    const searchInput = panel.querySelector<HTMLInputElement>('[data-role="search"]');
    if (!searchInput) return;
    searchInput.focus();
    searchInput.select();
  });
}

// Open the search panel with the replace row expanded. Repeated Ctrl-H
// presses toggle focus between the search and replace inputs.
function openFindReplace(): void {
  const view = focusedOrFirstEditor();
  if (!view) return;
  if (!document.activeElement || !view.dom.contains(document.activeElement)) {
    view.focus();
  }
  openSearchPanel(view);

  // Panel mount is synchronous but the inputs render in a microtask after
  // querySelector takes effect. One rAF is enough.
  requestAnimationFrame(() => {
    const panel = view.dom.querySelector<HTMLElement>(".cm-vs-search");
    if (!panel) return;

    const chevron = panel.querySelector<HTMLButtonElement>(
      '[data-action="toggle-replace"]',
    );
    if (chevron && chevron.getAttribute("aria-expanded") !== "true") {
      chevron.click();
    }

    const searchInput = panel.querySelector<HTMLInputElement>(
      '[data-role="search"]',
    );
    const replaceInput = panel.querySelector<HTMLInputElement>(
      '[data-role="replace"]',
    );
    if (!searchInput || !replaceInput) return;

    const active = document.activeElement;
    const target = active === searchInput ? replaceInput : searchInput;
    target.focus();
    target.select();
  });
}
