// Per-scenario CPU profiler. Generates one .cpuprofile file per scenario,
// each captured *only* during the hot loop — no warmup, no fixture build,
// no Bench overhead in the trace. Drop the resulting files into
// https://www.speedscope.app to inspect flame graphs.
//
//   bun run bench:flame             # all scenarios
//   bun run bench:flame -- --filter combined large
//
// Output goes to bench/profiles/.

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { Session } from "node:inspector/promises";
import { Chunk } from "@codemirror/merge";
import { ChangeSet } from "@codemirror/state";

import {
  buildDecorations,
  buildGutterRangeSet,
} from "../src/merge/diffDecorations.ts";
import { detectLanguage } from "../src/merge/languageDetect.ts";
import { FIXTURES, buildFixture } from "./fixtures.ts";

const OUT_DIR = path.resolve(import.meta.dirname, "profiles");

const filterArg = (() => {
  const i = process.argv.indexOf("--filter");
  if (i < 0) return [];
  return process.argv.slice(i + 1).filter((s) => !s.startsWith("--"));
})();

function shouldRun(name: string): boolean {
  if (filterArg.length === 0) return true;
  return filterArg.some((f) => name.toLowerCase().includes(f.toLowerCase()));
}

interface ProfileResult {
  name: string;
  iterations: number;
  durationMs: number;
  outFile: string;
}

class Profiler {
  private session: Session;

  constructor() {
    this.session = new Session();
    this.session.connect();
  }

  async start(): Promise<void> {
    await this.session.post("Profiler.enable");
    // 100µs sampling — fine grain, ~10k samples per second of work.
    await this.session.post("Profiler.setSamplingInterval", { interval: 100 });
    await this.session.post("Profiler.start");
  }

  async stop(): Promise<unknown> {
    const { profile } = await this.session.post("Profiler.stop");
    return profile;
  }

  dispose(): void {
    this.session.disconnect();
  }
}

async function profile(
  name: string,
  iterations: number,
  fn: () => void,
): Promise<ProfileResult> {
  const profiler = new Profiler();
  // Pre-tick: let the engine settle and warm caches before we start sampling.
  for (let i = 0; i < Math.min(iterations, 50); i++) fn();

  await profiler.start();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const durationMs = performance.now() - start;
  const profileData = await profiler.stop();
  profiler.dispose();

  const safe = name.replace(/[^a-z0-9._-]+/gi, "_");
  const outFile = path.join(OUT_DIR, `${safe}.cpuprofile`);
  await writeFile(outFile, JSON.stringify(profileData));
  return { name, iterations, durationMs, outFile };
}

// Pick iteration counts so each scenario takes ~300ms of sampled work — enough
// for a useful flame graph without padding the file with redundant samples.
// Slow scenarios (>100ms/iter) get exactly 1 sampled iteration.
function iterationsFor(oneRunMs: number): number {
  if (oneRunMs > 100) return 1;
  if (oneRunMs > 5) return Math.max(2, Math.ceil(300 / oneRunMs));
  return Math.min(200_000, Math.max(50, Math.ceil(300 / Math.max(oneRunMs, 0.001))));
}

// Single-run probe to measure cost. We skip multi-run averaging because the
// slow scenarios genuinely take 10s+ — looping 5x just for warmup wastes
// time we'd rather spend in the actual sampled run.
function timeOnce(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const fixtures = FIXTURES.map(buildFixture);
  const results: ProfileResult[] = [];

  for (const f of fixtures) {
    // Pre-build a baseline chunk set the same way the bench does. For the
    // pathologically-slow disjoint cases we skip baseline computation —
    // they only contribute to chunk-build profiles, not the keystroke/deco
    // ones that need a chunks0.
    let chunks0: readonly Chunk[] | null = null;
    let newB = f.textB;
    let change: ChangeSet | null = null;
    if (!f.spec.skipKeystroke) {
      console.log(`prep baseline for ${f.spec.name}...`);
      chunks0 = Chunk.build(f.textA, f.textB);
      const insertAt = Math.floor(f.textB.length / 2);
      change = ChangeSet.of(
        { from: insertAt, to: insertAt, insert: "x" },
        f.textB.length,
      );
      newB = change.apply(f.textB);
    }

    const scenarios: { kind: string; fn: () => void; skip?: boolean }[] = [
      {
        kind: "chunk-build",
        fn: () => { Chunk.build(f.textA, f.textB); },
        skip: f.spec.skipFullDiff,
      },
      {
        kind: "chunk-updateB",
        fn: () => { Chunk.updateB(chunks0!, f.textA, newB, change!); },
        skip: f.spec.skipKeystroke,
      },
      {
        kind: "deco",
        fn: () => { buildDecorations("b", chunks0!, f.textB); },
        skip: f.spec.skipKeystroke,
      },
      {
        kind: "gutter",
        fn: () => { buildGutterRangeSet("b", chunks0!, f.textB); },
        skip: f.spec.skipKeystroke,
      },
      {
        kind: "combined",
        fn: () => {
          const chunks = Chunk.updateB(chunks0!, f.textA, newB, change!);
          buildDecorations("a", chunks, f.textA);
          buildDecorations("b", chunks, newB);
          buildGutterRangeSet("a", chunks, f.textA);
          buildGutterRangeSet("b", chunks, newB);
        },
        skip: f.spec.skipKeystroke,
      },
    ];

    for (const { kind, fn, skip } of scenarios) {
      if (skip) continue;
      const name = `${kind}__${f.spec.name}`;
      if (!shouldRun(name)) continue;
      const oneMs = timeOnce(fn);
      const iter = iterationsFor(oneMs);
      console.log(`profiling ${name} — ${iter} iterations (~${oneMs.toFixed(3)}ms each)`);
      const res = await profile(name, iter, fn);
      results.push(res);
    }
  }

  // Language detection as a separate scenario class.
  const langSamples = [
    { name: "small", text: fixtures.find((f) => f.spec.name === "small/line-edits-10pct")!.b },
    { name: "medium", text: fixtures.find((f) => f.spec.name === "medium/line-edits-5pct")!.b },
    { name: "large", text: fixtures.find((f) => f.spec.name === "large/line-edits-5pct")!.b },
  ];
  for (const s of langSamples) {
    const name = `detectLanguage__${s.name}`;
    if (!shouldRun(name)) continue;
    const fn = () => { detectLanguage(s.text); };
    const oneMs = timeOnce(fn);
    const iter = iterationsFor(oneMs);
    console.log(`profiling ${name} — ${iter} iterations (~${oneMs.toFixed(3)}ms each)`);
    const res = await profile(name, iter, fn);
    results.push(res);
  }

  console.log("\nWrote profiles:");
  for (const r of results) {
    const perRun = r.durationMs / r.iterations;
    console.log(
      `  ${r.outFile}   (${r.iterations} iters, ${r.durationMs.toFixed(1)}ms total, ${perRun.toFixed(4)}ms/run)`,
    );
  }
  console.log(
    "\nView a profile at https://www.speedscope.app — pick \"Left Heavy\" for a stable flame graph.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
