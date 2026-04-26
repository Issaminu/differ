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

import { loadRealFixtures, type RealFixture } from "../fixtures/realFetch.ts";

const OUT_DIR = path.resolve(import.meta.dirname, "traces");
const PREVIEW_PORT = 4173; // vite preview default
const APP_URL = `http://localhost:${PREVIEW_PORT}/`;

const filter = process.argv.slice(2).filter((s) => !s.startsWith("--"));
const matches = (name: string): boolean =>
  filter.length === 0 || filter.some((f) => name.toLowerCase().includes(f.toLowerCase()));

interface Scenario {
  name: string;
  // Set up the editor before we start tracing — runs on a fresh page after
  // the editor has mounted but before any CDP capture starts.
  setup: (page: Page) => Promise<void>;
  // The action under test. Runs while CDP tracing is active. Returns the
  // wall-clock ms reported by `window.__bench.timed` (action → next paint).
  action: (page: Page) => Promise<number>;
}

// In-page bench API exposed by main.ts when the bundle is built with
// VITE_BENCH=1. We re-declare its shape here so we don't import the runtime.
interface BenchHook {
  seed(a: string, b: string): void;
  stats(): { added: number; removed: number };
  timed<T>(action: () => Promise<T> | T): Promise<{ ms: number; result: T }>;
}
type WithBench = { __bench: BenchHook };

declare global {
  interface Window {
    __bench: BenchHook;
  }
}

// ---- vite preview lifecycle ----

async function startPreview(): Promise<ChildProcess> {
  // We bench the *web* build because the Tauri target tries to import
  // Tauri-only APIs at startup, which fails in plain Chrome. The web build
  // is what real browser users would load anyway. VITE_BENCH=1 unlocks the
  // window.__bench hook the harness uses to seed editor state directly.
  const benchEnv = { VITE_TARGET: "web", VITE_BENCH: "1" };
  console.log("Building web bundle (with VITE_BENCH=1)...");
  await runOnce("bun", ["x", "tsc", "--noEmit"], benchEnv);
  await runOnce("bun", ["x", "vite", "build"], benchEnv);

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

function runOnce(
  cmd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// ---- helpers ----

// Wait until the editor has mounted, the wasm bootstrap has settled, and
// window.__bench is exposed (the harness needs it to seed state and time).
async function waitForEditorReady(page: Page): Promise<void> {
  await page.waitForSelector(".differ-pane[data-side='a'] .cm-content");
  await page.waitForSelector(".differ-pane[data-side='b'] .cm-content");
  await page.waitForFunction(
    () => typeof (window as unknown as Partial<WithBench>).__bench === "object",
    null,
    { timeout: 10000 },
  );
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

async function settle(page: Page, ms = 200): Promise<void> {
  await page.waitForTimeout(ms);
}

// Seed both panes via the in-page bench hook. This bypasses Playwright's
// slow `locator.fill` path so the wall-clock numbers reflect the editor's
// own behaviour, not the test framework's.
async function seed(page: Page, a: string, b: string): Promise<void> {
  await page.evaluate(([aText, bText]) => window.__bench.seed(aText, bText), [a, b]);
}

// Wait until the diff signal has any non-zero added/removed count. More
// reliable than polling for a CSS class because the bench hook reads from
// the signal that drives the diffStats badge — populated immediately after
// every chunks update. Throws if no diff appears within the timeout.
async function waitForDiff(page: Page, timeoutMs = 30000): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = window.__bench.stats();
      return s.added > 0 || s.removed > 0;
    },
    null,
    { timeout: timeoutMs },
  );
}

// Wrap an action with CDP Tracing + CPU profiling. The action must return
// the in-page wall-clock ms (action → next paint) — that's the number we
// actually report. Wall-clock ms measured here on the Node side would
// include the CDP round-trip, which we don't care about.
//
// Saves a .trace.json (DevTools Performance loadable) and .cpuprofile
// (speedscope) per scenario.
async function captureTrace(
  page: Page,
  client: CDPSession,
  name: string,
  action: () => Promise<number>,
): Promise<{ inPageMs: number }> {
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

  const inPageMs = await action();

  await client.send("Tracing.end");
  const events = await tracePromise;
  const profile = (await client.send("Profiler.stop")).profile;
  await client.send("Profiler.disable");

  const safe = name.replace(/[^a-z0-9._-]+/gi, "_");
  await writeFile(
    path.join(OUT_DIR, `${safe}.trace.json`),
    JSON.stringify({ traceEvents: events }),
  );
  await writeFile(
    path.join(OUT_DIR, `${safe}.cpuprofile`),
    JSON.stringify(profile),
  );
  return { inPageMs };
}

// ---- scenarios ----

function buildScenarios(fixtures: RealFixture[]): Scenario[] {
  const scenarios: Scenario[] = [];

  for (const fixture of fixtures) {
    // 1. "Paste both panes": start clean, seed both panes via the bench
    // hook (one transaction per side), measure ms from seed → next paint
    // with the diff fully rendered. This is what a user feels when they
    // paste-paste-look.
    scenarios.push({
      name: `${fixture.name}/paste-both`,
      setup: async (page) => {
        await page.evaluate(() => window.__bench.seed("", ""));
        await settle(page);
      },
      action: async (page) =>
        page
          .evaluate(
            ([a, b]) =>
              window.__bench.timed(() => window.__bench.seed(a, b)).then((r) => r.ms),
            [fixture.a, fixture.b],
          ),
    });

    // 2. "Keystroke on established diff": seed both panes during setup,
    // wait for paint, then time a single character insertion on side B at
    // mid-document. Measures the per-keystroke recompute + repaint cost
    // a user feels while editing inside an already-diffed pair.
    scenarios.push({
      name: `${fixture.name}/keystroke`,
      setup: async (page) => {
        await seed(page, fixture.a, fixture.b);
        await waitForDiff(page);
        await settle(page);
      },
      action: async (page) =>
        page.evaluate(() =>
          window.__bench
            .timed(() => {
              const view = (
                document.querySelector(
                  ".differ-pane[data-side='b'] .cm-content",
                ) as HTMLElement
              ).closest(".cm-editor")! as HTMLElement & { cmView?: unknown };
              // Dispatch a real input event so CM's transaction machinery
              // runs end-to-end, not via low-level state surgery. Inserting
              // at the current selection (CM places it sensibly on focus).
              const cm = document.querySelector(
                ".differ-pane[data-side='b'] .cm-content",
              ) as HTMLElement;
              cm.focus();
              document.execCommand("insertText", false, "X");
              void view;
            })
            .then((r) => r.ms),
        ),
    });

    // 3. "Full programmatic scroll": seed, then scroll the right pane
    // through its full extent and measure the total wall time. We use
    // requestAnimationFrame between scroll steps so the browser actually
    // paints each frame. The reported ms is wall time end-to-end; divide
    // by frame count for per-frame.
    scenarios.push({
      name: `${fixture.name}/scroll`,
      setup: async (page) => {
        await seed(page, fixture.a, fixture.b);
        await waitForDiff(page);
        await settle(page);
      },
      action: async (page) =>
        page.evaluate(async () =>
          window.__bench
            .timed(async () => {
              const pane = document.querySelector(
                ".differ-pane[data-side='b'] .cm-scroller",
              ) as HTMLElement;
              const total = pane.scrollHeight - pane.clientHeight;
              const steps = 60;
              for (let i = 0; i <= steps; i++) {
                pane.scrollTop = (total * i) / steps;
                await new Promise<void>((r) => requestAnimationFrame(() => r()));
              }
            })
            .then((r) => r.ms),
        ),
    });
  }

  return scenarios;
}

// ---- main ----

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  console.log("Loading real fixtures (fetches once, then cached)...");
  const fixtures = await loadRealFixtures();
  for (const f of fixtures) {
    console.log(
      `  ${f.name.padEnd(34)}  a=${f.a.length.toLocaleString().padStart(9)}b  b=${f.b.length.toLocaleString().padStart(9)}b`,
    );
  }
  const scenarios = buildScenarios(fixtures);

  const preview = await startPreview();
  let exitCode = 0;
  try {
    const browser = await chromium.launch();
    const summary: { name: string; ms: number | null; error?: string }[] = [];

    for (const scenario of scenarios) {
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

        const { inPageMs } = await captureTrace(page, client, scenario.name, () =>
          scenario.action(page),
        );
        console.log(`  ${inPageMs.toFixed(1)} ms`);
        summary.push({ name: scenario.name, ms: inPageMs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  FAILED: ${msg.split("\n")[0]}`);
        summary.push({ name: scenario.name, ms: null, error: msg.split("\n")[0] });
      } finally {
        await context.close();
      }
    }

    await browser.close();

    console.log("\nSummary (ms = action → next paint, in-page wall clock):");
    const nameW = Math.max(8, ...summary.map((s) => s.name.length));
    console.log(`  ${"scenario".padEnd(nameW)}  ${"ms".padStart(10)}`);
    console.log(`  ${"-".repeat(nameW)}  ${"-".repeat(10)}`);
    for (const r of summary) {
      const ms = r.ms === null ? "FAILED" : r.ms.toFixed(1);
      console.log(`  ${r.name.padEnd(nameW)}  ${ms.padStart(10)}${r.error ? "  " + r.error : ""}`);
    }
    console.log("\nTraces: bench/browser/traces/*.{trace.json,cpuprofile}");
  } catch (err) {
    console.error(err);
    exitCode = 1;
  } finally {
    preview.kill("SIGINT");
  }
  process.exit(exitCode);
}

main();
