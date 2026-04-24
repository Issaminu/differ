import {
  historyOpen,
  resetBothDocs,
  swapSides,
} from "../state";
import { forceCapture } from "../history/pipeline";

function isMetaOrCtrl(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

export function installShortcuts(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isMetaOrCtrl(e)) return;

    // ⌘H — toggle history
    if (e.key.toLowerCase() === "h" && !e.shiftKey && !e.altKey) {
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
