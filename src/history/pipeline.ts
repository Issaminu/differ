import { effect } from "@preact/signals-core";
import {
  originalText,
  modifiedText,
  activeLanguage,
  historyEntries,
} from "../state";
import { captureHistory, loadHistory } from "./api";

const CAPTURE_DEBOUNCE_MS = 2500;

let captureTimer: ReturnType<typeof setTimeout> | null = null;
let lastCaptured: { o: string; m: string } = { o: "", m: "" };

export async function bootstrapHistory(): Promise<void> {
  try {
    const file = await loadHistory();
    historyEntries.value = file.entries;
  } catch (err) {
    console.warn("history_load failed", err);
    historyEntries.value = [];
  }
}

export function installCapturePipeline(): () => void {
  return effect(() => {
    const o = originalText.value;
    const m = modifiedText.value;
    const lang = activeLanguage.value;

    if (captureTimer) clearTimeout(captureTimer);
    if (!shouldCapture(o, m)) return;
    if (lastCaptured.o === o && lastCaptured.m === m) return;

    captureTimer = setTimeout(async () => {
      try {
        const file = await captureHistory(o, m, lang);
        historyEntries.value = file.entries;
        lastCaptured = { o, m };
      } catch (err) {
        console.warn("history_capture failed", err);
      }
    }, CAPTURE_DEBOUNCE_MS);
  });
}

export async function forceCapture(): Promise<void> {
  try {
    const file = await captureHistory(
      originalText.peek(),
      modifiedText.peek(),
      activeLanguage.peek(),
      true,
    );
    historyEntries.value = file.entries;
    lastCaptured = { o: originalText.peek(), m: modifiedText.peek() };
  } catch (err) {
    console.warn("forceCapture failed", err);
  }
}

function shouldCapture(original: string, modified: string): boolean {
  if (!original && !modified) return false;
  if (original === modified) return false;
  if (original.length < 2 && modified.length < 2) return false;
  return true;
}
