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

import {
  buildDecorations,
  buildGutterRangeSet,
  countChangedLines,
} from "../src/merge/diffDecorations.ts";
import { detectLanguage } from "../src/merge/languageDetect.ts";
import { FIXTURES, buildFixture } from "./fixtures.ts";
import {
  chunkSetFromSession,
  computeChunkSet,
  insertOneCharAtMiddle,
  viewportAround,
  type BenchDiffChunkSet,
  type DiffSessionLike,
} from "./packedDiff.ts";

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
  const imaraMod = await import(
    "../crates/diff-wasm/pkg-node/differ_diff_wasm.js"
  ).catch(() => null);
  const imara = imaraMod as null | {
    DiffSession: new () => DiffSessionLike & { free?: () => void };
  };

  const countStats = (chunks: BenchDiffChunkSet): void => {
    let added = 0;
    let removed = 0;
    for (let i = 0; i < chunks.length; i++) {
      removed += countChangedLines(chunks.aText, chunks.fromA(i), chunks.endA(i));
      added += countChangedLines(chunks.bText, chunks.fromB(i), chunks.endB(i));
    }
    if (added + removed < 0) throw new Error("unreachable");
  };

  for (const f of fixtures) {
    const scenarios: { kind: string; fn: () => void; skip?: boolean }[] = [
      {
        kind: "legacy-chunk-build",
        fn: () => { Chunk.build(f.textA, f.textB); },
        skip: f.spec.skipFullDiff,
      },
    ];

    if (imara) {
      console.log(`prep packed baseline for ${f.spec.name}...`);
      const baselineSession = new imara.DiffSession();
      const chunks0 = computeChunkSet(baselineSession, f.a, f.b, true);
      baselineSession.free?.();
      const newB = insertOneCharAtMiddle(f.b);
      const viewportA = viewportAround(f.a, Math.floor(f.a.length / 2));
      const viewportB = viewportAround(newB, Math.floor(newB.length / 2));

      const fullSession = new imara.DiffSession();
      const editSession = new imara.DiffSession();
      editSession.set_a(f.a);
      editSession.set_b(f.b);
      editSession.compute_packed(true);

      scenarios.push(
        {
          kind: "imara-set-compute-buffers",
          fn: () => {
            fullSession.set_a(f.a);
            fullSession.set_b(f.b);
            fullSession.compute_packed(true);
            fullSession.chunks_buffer();
            fullSession.changes_buffer();
          },
        },
        {
          kind: "imara-setB-compute-buffers",
          fn: () => {
            editSession.set_b(newB);
            editSession.compute_packed(true);
            editSession.chunks_buffer();
            editSession.changes_buffer();
          },
        },
        {
          kind: "deco-full",
          fn: () => { buildDecorations("b", chunks0); },
        },
        {
          kind: "deco-viewport",
          fn: () => { buildDecorations("b", chunks0, viewportB[0], viewportB[1]); },
        },
        {
          kind: "gutter-full",
          fn: () => { buildGutterRangeSet("b", chunks0); },
        },
        {
          kind: "combined-production",
          fn: () => {
            editSession.set_b(newB);
            editSession.compute_packed(true);
            const chunks = chunkSetFromSession(editSession, f.a, newB);
            countStats(chunks);
            buildDecorations("a", chunks, viewportA[0], viewportA[1]);
            buildDecorations("b", chunks, viewportB[0], viewportB[1]);
            buildGutterRangeSet("a", chunks);
            buildGutterRangeSet("b", chunks);
          },
        },
      );
    }

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
