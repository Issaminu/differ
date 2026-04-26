// Browser-side benchmark harness. Drives the editor in headless Chrome via
// Playwright + CDP and captures, per scenario:
//
//   - a Chrome-DevTools-loadable trace JSON (Tracing.{start,end})
//   - a CPU profile (Profiler.{start,stop}) for speedscope
//   - performance.measure() spans the page emits for high-level timings
//
// Run:
//   bun run bench:browser                # all scenarios
//   bun run bench:browser keystroke      # filter by name substring
//
// Output: bench/browser/traces/*.json + *.cpuprofile

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page, type CDPSession } from "playwright";

import { buildFixture, type Fixture } from "../fixtures.ts";

const OUT_DIR = path.resolve(import.meta.dirname, "traces");
const PREVIEW_PORT = 4173; // vite preview default
const APP_URL = `http://localhost:${PREVIEW_PORT}/`;

const filter = process.argv.slice(2).filter((s) => !s.startsWith("--"));
const matches = (name: string): boolean =>
  filter.length === 0 || filter.some((f) => name.toLowerCase().includes(f.toLowerCase()));

interface Scenario {
  name: string;
  // Set up the editor before we start tracing. Returns whatever the action
  // step needs as context.
  setup: (page: Page) => Promise<void>;
  // The action under test. Runs while CDP tracing is active.
  action: (page: Page) => Promise<void>;
}

// ---- vite preview lifecycle ----

async function startPreview(): Promise<ChildProcess> {
  // We bench the *web* build because the Tauri target tries to import
  // Tauri-only APIs at startup, which fails in plain Chrome. The web build
  // is what real browser users would load anyway.
  console.log("Building web bundle...");
  await runOnce("bun", ["run", "build:web"]);

  console.log("Starting vite preview...");
  const proc = spawn("bun", ["x", "vite", "preview", "--port", String(PREVIEW_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  // Wait for the "Local:" line.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("preview start timed out")), 15000);
    proc.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Local:")) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on("exit", (code) => reject(new Error(`preview exited early: ${code}`)));
  });
  return proc;
}

function runOnce(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// ---- helpers ----

// Wait until the editor has mounted both panes and the wasm has loaded.
// Both panes get CodeMirror's `.cm-content` element on mount; the diff also
// waits for our chunksField to be populated (at least one tick after mount).
async function waitForEditorReady(page: Page): Promise<void> {
  await page.waitForSelector(".differ-pane[data-side='a'] .cm-content");
  await page.waitForSelector(".differ-pane[data-side='b'] .cm-content");
  // Give effects + wasm init a beat to settle. The bootstrap is async due
  // to top-level-await on the wasm import.
  await page.waitForFunction(
    () => {
      const cm = document.querySelector(".differ-pane[data-side='a'] .cm-content");
      return cm !== null && (cm as HTMLElement).isContentEditable;
    },
    null,
    { timeout: 10000 },
  );
  // One more requestAnimationFrame to flush the first paint.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

// Fill a pane by setting the contents directly via CodeMirror's ContentEditable
// surface. `locator.fill()` works for our editor (it dispatches the
// composition events CM listens for); we proved that in the Claude Preview
// smoke test.
async function fillPane(page: Page, side: "a" | "b", text: string): Promise<void> {
  await page.locator(`.differ-pane[data-side='${side}'] .cm-content`).fill(text);
}

async function settle(page: Page, ms = 300): Promise<void> {
  await page.waitForTimeout(ms);
}

// Wrap the action with CDP Tracing + CPU profiling. Saves both files under
// bench/browser/traces/<name>.{json,cpuprofile}.
async function captureTrace(
  page: Page,
  client: CDPSession,
  name: string,
  action: () => Promise<void>,
): Promise<{ wallMs: number }> {
  await page.evaluate((label) => performance.mark(`${label}.start`), name);

  await client.send("Profiler.enable");
  await client.send("Profiler.setSamplingInterval", { interval: 100 });
  await client.send("Profiler.start");

  const tracePromise = new Promise<unknown[]>((resolve) => {
    const events: unknown[] = [];
    client.on("Tracing.dataCollected", (data) => {
      events.push(...(data.value as unknown[]));
    });
    client.once("Tracing.tracingComplete", () => resolve(events));
  });
  await client.send("Tracing.start", {
    categories:
      "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,latencyInfo",
    options: "sampling-frequency=10000",
    transferMode: "ReportEvents",
  });

  const t0 = performance.now();
  await action();
  const wallMs = performance.now() - t0;

  await client.send("Tracing.end");
  const events = await tracePromise;
  const profile = (await client.send("Profiler.stop")).profile;
  await client.send("Profiler.disable");

  await page.evaluate((label) => performance.mark(`${label}.end`), name);

  const safe = name.replace(/[^a-z0-9._-]+/gi, "_");
  await writeFile(
    path.join(OUT_DIR, `${safe}.trace.json`),
    JSON.stringify({ traceEvents: events }),
  );
  await writeFile(
    path.join(OUT_DIR, `${safe}.cpuprofile`),
    JSON.stringify(profile),
  );
  return { wallMs };
}

// ---- scenarios ----

const mediumLineEdits: Fixture = buildFixture({
  name: "medium/line-edits-5pct",
  lines: 2000,
  shape: "line-edits",
  density: 0.05,
});

const SCENARIOS: Scenario[] = [
  {
    // Initial diff render: paste a 2000-line file pair, measure how long
    // until the diff is visibly highlighted. This is the "first paint" path.
    name: "first-paint-2k",
    setup: async () => {
      // Start clean.
    },
    action: async (page) => {
      await fillPane(page, "a", mediumLineEdits.a);
      await fillPane(page, "b", mediumLineEdits.b);
      // Wait for the diff badge to update (any chunk tint visible on either pane).
      await page.waitForFunction(
        () =>
          document.querySelector(".differ-pane[data-side='b'] .cm-changedLine") !== null,
        null,
        { timeout: 10000 },
      );
    },
  },
  {
    // Per-keystroke cost on top of an established 2 k-line diff. We seed
    // both panes during setup so the action measures only the recompute +
    // repaint after one character is typed.
    name: "keystroke-on-2k-diff",
    setup: async (page) => {
      await fillPane(page, "a", mediumLineEdits.a);
      await fillPane(page, "b", mediumLineEdits.b);
      await page.waitForFunction(
        () =>
          document.querySelector(".differ-pane[data-side='b'] .cm-changedLine") !== null,
        null,
        { timeout: 10000 },
      );
      await settle(page);
    },
    action: async (page) => {
      const pane = page.locator(".differ-pane[data-side='b'] .cm-content");
      await pane.click();
      await pane.press("End");
      await pane.pressSequentially("X", { delay: 0 });
      // Two RAFs to capture compute + paint.
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );
    },
  },
  {
    // Sustained scrolling through a 2 k-line diff with ~100 chunks. The
    // chunks visible at any time should be small but the *gutter range set*
    // covers all 2 k lines, so the cost is dominated by what CM repaints
    // each frame.
    name: "scroll-2k-diff",
    setup: async (page) => {
      await fillPane(page, "a", mediumLineEdits.a);
      await fillPane(page, "b", mediumLineEdits.b);
      await page.waitForFunction(
        () =>
          document.querySelector(".differ-pane[data-side='b'] .cm-changedLine") !== null,
        null,
        { timeout: 10000 },
      );
      await settle(page);
    },
    action: async (page) => {
      // Programmatically scroll the right pane through its full extent,
      // 200 px at a time, one frame between each.
      await page.evaluate(async () => {
        const pane = document.querySelector(
          ".differ-pane[data-side='b'] .cm-scroller",
        ) as HTMLElement;
        const total = pane.scrollHeight - pane.clientHeight;
        const step = 200;
        for (let y = 0; y <= total; y += step) {
          pane.scrollTop = y;
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
      });
    },
  },
];

// ---- main ----

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const preview = await startPreview();
  let exitCode = 0;
  try {
    const browser = await chromium.launch();
    const summary: { name: string; wallMs: number; outFile: string }[] = [];

    for (const scenario of SCENARIOS) {
      if (!matches(scenario.name)) continue;
      console.log(`\n=== ${scenario.name} ===`);

      const context = await browser.newContext();
      const page = await context.newPage();
      const client = await context.newCDPSession(page);
      try {
        await page.goto(APP_URL);
        await waitForEditorReady(page);
        await scenario.setup(page);
        await settle(page);

        const { wallMs } = await captureTrace(page, client, scenario.name, () =>
          scenario.action(page),
        );
        console.log(`  wall: ${wallMs.toFixed(1)}ms`);
        summary.push({
          name: scenario.name,
          wallMs,
          outFile: `bench/browser/traces/${scenario.name}.{trace.json,cpuprofile}`,
        });
      } finally {
        await context.close();
      }
    }

    await browser.close();

    console.log("\nSummary:");
    for (const r of summary) {
      console.log(`  ${r.name.padEnd(28)} ${r.wallMs.toFixed(1).padStart(8)} ms`);
    }
    console.log(
      "\nLoad .trace.json files in Chrome DevTools → Performance → Load profile…",
    );
    console.log(
      "Load .cpuprofile files at https://www.speedscope.app or in DevTools.",
    );
  } catch (err) {
    console.error(err);
    exitCode = 1;
  } finally {
    preview.kill("SIGINT");
  }
  process.exit(exitCode);
}

main();
