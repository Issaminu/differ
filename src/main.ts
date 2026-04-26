import { effect } from "@preact/signals-core";

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
  const appWindow =
    import.meta.env.VITE_TARGET === "web"
      ? null
      : (await import("@tauri-apps/api/window")).getCurrentWindow();
  const applyTheme = () => {
    const pref = themePreference.value;
    themeMode.value = pref === "system" ? (mq.matches ? "dark" : "light") : pref;
    appWindow?.setTheme(pref === "system" ? null : pref).catch(() => {});
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

  // Bench hook — only present when the bundle was built with VITE_BENCH=1
  // (set by bench/browser/harness.ts). The browser harness uses this to
  // seed the diff state without going through Playwright's slow
  // `locator.fill`, which would otherwise dominate the wall-clock
  // numbers we care about.
  if (import.meta.env.VITE_BENCH === "1") {
    const { diffStats: stats } = await import("./state");
    // Per-update counter on diffStats. Incremented every time syncDiffState
    // writes a new value to the signal — gives `timed({ waitForDiff: true })`
    // a way to detect "the diff has been applied" without polling for value
    // changes (which can falsely match if the new diff happens to have the
    // same added/removed counts as the previous one).
    let statsRev = 0;
    effect(() => {
      // Touch the signal so the effect subscribes — bumps rev whenever
      // syncDiffState writes, including no-op writes of equal values.
      stats.value;
      statsRev++;
    });
    (window as unknown as { __bench?: unknown }).__bench = {
      seed(a: string, b: string) {
        originalText.value = a;
        modifiedText.value = b;
      },
      stats() {
        return { ...stats.value };
      },
      // Run an action and report the wall-clock ms from the start of the
      // action to the next painted frame. With `waitForDiff: true`, also
      // wait until `diffStats` is updated — i.e. until the recompute has
      // landed and chunks have been dispatched. Needed for honest
      // measurement when computeDiff is async (Web Worker).
      async timed<T>(
        action: () => Promise<T> | T,
        opts?: { waitForDiff?: boolean },
      ): Promise<{ ms: number; result: T }> {
        const startRev = statsRev;
        const t0 = performance.now();
        const result = await action();
        if (opts?.waitForDiff) {
          while (statsRev === startRev) {
            await new Promise<void>((r) => setTimeout(r, 4));
          }
        }
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        return { ms: performance.now() - t0, result };
      },
    };
  }

  // Auto-updater (desktop only — hourly GitHub releases check + native
  // menu item under "Differ" → "Check for Updates…").
  if (import.meta.env.VITE_TARGET !== "web") {
    const [{ startUpdateChecker, triggerUpdateCheck }, { listen }] =
      await Promise.all([
        import("./chrome/updater"),
        import("@tauri-apps/api/event"),
      ]);
    startUpdateChecker();
    void listen("update-check-requested", () => {
      void triggerUpdateCheck();
    });
  }
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
