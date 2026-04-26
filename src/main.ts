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
    const [{ diffStats: stats }, { historyOpen }] = await Promise.all([
      import("./state"),
      import("./state"),
    ]);
    let statsRev = 0;
    effect(() => {
      stats.value;
      statsRev++;
    });

    // Resolve a position spec ("top" | "middle" | "end" | number) to a
    // concrete document offset, snapped to the start of its line.
    const resolveCursor = (
      view: { state: { doc: { length: number; lineAt: (pos: number) => { from: number } } } },
      spec: "top" | "middle" | "end" | number,
    ): number => {
      const len = view.state.doc.length;
      const pos =
        spec === "top"
          ? 0
          : spec === "end"
            ? len
            : spec === "middle"
              ? Math.floor(len / 2)
              : Math.max(0, Math.min(spec, len));
      return view.state.doc.lineAt(pos).from;
    };

    (window as unknown as { __bench?: unknown }).__bench = {
      seed(a: string, b: string) {
        originalText.value = a;
        modifiedText.value = b;
      },
      stats() {
        return { ...stats.value };
      },
      // Direct access to both EditorView instances. Lets bench scenarios
      // dispatch real CM transactions for cursor placement, without
      // routing through the contenteditable layer.
      get views() {
        return merge.views;
      },
      // Place the cursor (and focus) in the named side at a logical
      // position. Snaps to line start so subsequent inserts produce
      // clean diff chunks.
      cursorAt(side: "a" | "b", pos: "top" | "middle" | "end" | number): void {
        const view = side === "a" ? merge.views.a : merge.views.b;
        const offset = resolveCursor(view, pos);
        view.dispatch({ selection: { anchor: offset } });
        view.focus();
      },
      // Toggle the history drawer — same path as the toolbar button.
      toggleHistory(): void {
        historyOpen.value = !historyOpen.value;
      },
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
      // Run `action` while sampling `requestAnimationFrame` deltas, return
      // total ms + frame-time stats. The first sample is dropped because
      // it captures the gap between scheduling rAF and the first frame
      // (heavily timestamp-dependent on when we started). Reports mean,
      // p50, p99 frame time, plus a "dropped at 60 Hz" count for any
      // frame longer than 22 ms (16.67 ms target with a tolerance for
      // measurement noise).
      async timedFps(
        action: () => Promise<unknown> | unknown,
        opts?: { waitForDiff?: boolean },
      ): Promise<{
        ms: number;
        frames: number;
        meanFrameMs: number;
        p50FrameMs: number;
        p99FrameMs: number;
        droppedAt60Hz: number;
      }> {
        const frameTimes: number[] = [];
        let lastTs = performance.now();
        let stop = false;
        const tick = () => {
          if (stop) return;
          const now = performance.now();
          frameTimes.push(now - lastTs);
          lastTs = now;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const startRev = statsRev;
        const t0 = performance.now();
        await action();
        if (opts?.waitForDiff) {
          while (statsRev === startRev) {
            await new Promise<void>((r) => setTimeout(r, 4));
          }
        }
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        const ms = performance.now() - t0;
        stop = true;
        // Drop the first sample (rAF startup jitter) and one trailing
        // settle frame, then compute stats.
        const trimmed = frameTimes.slice(1, -1);
        const sorted = [...trimmed].sort((a, b) => a - b);
        const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
        const mean = trimmed.reduce((a, b) => a + b, 0) / Math.max(1, trimmed.length);
        const dropped = trimmed.filter((t) => t > 22).length;
        return {
          ms,
          frames: trimmed.length,
          meanFrameMs: mean,
          p50FrameMs: at(0.5),
          p99FrameMs: at(0.99),
          droppedAt60Hz: dropped,
        };
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
