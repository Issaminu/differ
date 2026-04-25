import { effect } from "@preact/signals-core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  originalText,
  modifiedText,
  detectedLanguage,
  manualLanguage,
  activeLanguage,
  themeMode,
  themePreference,
  type LanguageId,
} from "./state";
import { mountMergeView, type MergeController } from "./merge/mergeView";
import { detectLanguage } from "./merge/languageDetect";
import { mountSwapHover } from "./merge/swapHover";
import { mountToolbar } from "./chrome/toolbar";
import { installShortcuts } from "./chrome/shortcuts";
import { mountHistoryDrawer } from "./history/drawer";
import { bootstrapHistory, installCapturePipeline } from "./history/pipeline";

async function main(): Promise<void> {
  const appHost = document.getElementById("app")!;
  const toolbarHost = document.getElementById("toolbar")!;
  const drawerHost = document.getElementById("history-drawer")!;

  const merge = mountMergeView(appHost);
  mountSwapHover(appHost);
  mountToolbar(toolbarHost, {
    gotoChunk: merge.gotoChunk,
    goBack: merge.goBack,
    goForward: merge.goForward,
  });
  mountHistoryDrawer(drawerHost);
  installShortcuts({
    gotoChunk: merge.gotoChunk,
    goBack: merge.goBack,
    goForward: merge.goForward,
  });

  // Resolved theme = preference, unless "system" (then follow OS).
  // Also push the choice down to the native window so NSVisualEffectView
  // picks the matching light/dark variant (sidebar material looks dark on
  // a dark-appearance window even if CSS is light-themed).
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const appWindow = getCurrentWindow();
  const applyTheme = () => {
    const pref = themePreference.value;
    themeMode.value = pref === "system" ? (mq.matches ? "dark" : "light") : pref;
    appWindow.setTheme(pref === "system" ? null : pref).catch(() => {});
  };
  mq.addEventListener("change", applyTheme);
  effect(applyTheme);

  effect(() => {
    merge.setTheme(themeMode.value);
  });

  // Editor → state is wired inside mountMergeView.
  // state → editor: when signals change externally (swap, clear, history restore).
  effect(() => {
    const a = originalText.value;
    const b = modifiedText.value;
    merge.setDocs(a, b);
  });

  // Language detection — debounced
  wireLanguageDetection(merge);

  // Grammar loading — reactive to activeLanguage
  let currentLang: LanguageId = "plaintext";
  effect(() => {
    const id = activeLanguage.value;
    if (id === currentLang) return;
    currentLang = id;
    void merge.setLanguage(id);
  });

  // History: load + capture pipeline
  await bootstrapHistory();
  installCapturePipeline();
}

function wireLanguageDetection(_merge: MergeController): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const LANG_DEBOUNCE_MS = 500;

  effect(() => {
    const o = originalText.value;
    const m = modifiedText.value;
    if (manualLanguage.value !== null) return;

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const sample = m.length >= o.length ? m : o;
      const detected = detectLanguage(sample);
      if (detectedLanguage.peek() !== detected) {
        detectedLanguage.value = detected;
      }
    }, LANG_DEBOUNCE_MS);
  });
}

main().catch((err) => {
  console.error("bootstrap failed", err);
});
