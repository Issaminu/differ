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
  // Per-fixture route registration — runs on a fresh page so it can install
  // page.route() before any in-page fetch happens.
  prepare: (page: Page) => Promise<void>;
  // Set up the editor before we start tracing.
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
    cwd: REPO_ROOT,
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

// Anchor child processes (vite build, vite preview) at the repo root so the
// bench works regardless of where node was invoked from.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function runOnce(
  cmd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: "inherit",
      cwd: REPO_ROOT,
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

// Register a page-side route for the current fixture so the in-page code
// can `fetch('/__bench/<id>?side=a')` to pull the doc text without us
// having to serialize the whole string through the CDP control channel.
// At 200 MB that round-trip becomes the dominant cost otherwise.
async function registerFixtureRoute(
  page: Page,
  id: string,
  a: string,
  b: string,
): Promise<void> {
  await page.route(`**/__bench/${id}*`, async (route, req) => {
    const url = new URL(req.url());
    const side = url.searchParams.get("side");
    const body = side === "a" ? a : side === "b" ? b : "";
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body,
    });
  });
}

// Seed both panes via the in-page bench hook, fetching content from the
// per-fixture route registered above. Returns once the seed call has run
// (without waiting for paint — the caller usually wraps this in __bench.timed).
async function seedFromRoute(page: Page, id: string): Promise<void> {
  await page.evaluate(async (fixId) => {
    const [a, b] = await Promise.all([
      fetch(`/__bench/${fixId}?side=a`).then((r) => r.text()),
      fetch(`/__bench/${fixId}?side=b`).then((r) => r.text()),
    ]);
    window.__bench.seed(a, b);
  }, id);
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

  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i];
    const id = `f${i}`;
    const prepare = (page: Page) => registerFixtureRoute(page, id, fixture.a, fixture.b);

    // 1. "Paste both panes": start clean, then fetch the fixture content
    // from the route and seed both panes inside `timed()`. The fetch+seed
    // sequence is what the timed measurement covers — the route is local
    // (page.route intercepts before the network stack) so the cost is
    // limited to JS string handling on the page side.
    scenarios.push({
      name: `${fixture.name}/paste-both`,
      prepare,
      setup: async (page) => {
        await page.evaluate(() => window.__bench.seed("", ""));
        await settle(page);
      },
      action: async (page) =>
        page.evaluate(
          (fixId) =>
            window.__bench
              .timed(async () => {
                const [a, b] = await Promise.all([
                  fetch(`/__bench/${fixId}?side=a`).then((r) => r.text()),
                  fetch(`/__bench/${fixId}?side=b`).then((r) => r.text()),
                ]);
                window.__bench.seed(a, b);
              })
              .then((r) => r.ms),
          id,
        ),
    });

    // 2. "Keystroke on established diff": seed both panes during setup,
    // wait for paint, then time a single character insertion on side B.
    scenarios.push({
      name: `${fixture.name}/keystroke`,
      prepare,
      setup: async (page) => {
        await seedFromRoute(page, id);
        await waitForDiff(page, 240_000);
        await settle(page);
      },
      action: async (page) =>
        page.evaluate(() =>
          window.__bench
            .timed(() => {
              const cm = document.querySelector(
                ".differ-pane[data-side='b'] .cm-content",
              ) as HTMLElement;
              cm.focus();
              document.execCommand("insertText", false, "X");
            })
            .then((r) => r.ms),
        ),
    });

    // 3. "Full programmatic scroll": seed, then scroll the right pane
    // through its full extent, one rAF between each step. Reported ms is
    // wall time end-to-end; divide by step count for per-frame.
    scenarios.push({
      name: `${fixture.name}/scroll`,
      prepare,
      setup: async (page) => {
        await seedFromRoute(page, id);
        await waitForDiff(page, 240_000);
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
    // Higher V8 limits so the 200 MB tier doesn't OOM mid-run. The defaults
    // are conservative (~512 MB old gen) which would crash on a single-page
    // diff this size.
    const browser = await chromium.launch({
      args: ["--js-flags=--max-old-space-size=8192", "--max-old-space-size=8192"],
    });
    const summary: { name: string; ms: number | null; error?: string }[] = [];

    for (const scenario of scenarios) {
      if (!matches(scenario.name)) continue;
      console.log(`\n=== ${scenario.name} ===`);

      const context = await browser.newContext();
      const page = await context.newPage();
      // Generous default — single actions on 200 MB inputs can legitimately
      // take many seconds (mostly compute, some allocation).
      page.setDefaultTimeout(240_000);
      const client = await context.newCDPSession(page);
      try {
        await scenario.prepare(page);
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
