// Benchmarks for the diff editor's CPU hot paths.
//
//   - `DiffSession`       : production imara-diff WASM full recompute.
//   - buildDecorations    : translate chunks → CodeMirror DecorationSet.
//   - buildGutterRangeSet : translate chunks → gutter line marker RangeSet.
//   - detectLanguage      : the keyword-scoring heuristic.
//
// Run:
//   bun run bench
//   bun run bench -- --filter combined
//
// Tinybench has bench-level (not task-level) time/iteration budgets, so we
// run one Bench per size tier — small/medium get a generous sample window,
// large gets a tight one because a single iteration can be ~seconds.

import { writeSync } from "node:fs";
import { Bench, type BenchOptions } from "tinybench";
import { Chunk } from "@codemirror/merge";

import {
  buildDecorations,
  buildGutterRangeSet,
  countChangedLines,
} from "../src/merge/diffDecorations.ts";
import { detectLanguage } from "../src/merge/languageDetect.ts";
import { FIXTURES, buildFixture, type Fixture } from "./fixtures.ts";
import {
  chunkSetFromSession,
  computeChunkSet,
  insertOneCharAtMiddle,
  viewportAround,
  type BenchDiffChunkSet,
  type DiffSessionLike,
} from "./packedDiff.ts";

// Node's process.stderr.write is async when piped to a non-TTY, so writes
// from inside a tight synchronous loop never flush until the loop ends.
// fs.writeSync to fd 2 is genuinely synchronous and shows up immediately.
function progress(line: string): void {
  writeSync(2, line);
}

const filterArg = (() => {
  const i = process.argv.indexOf("--filter");
  return i >= 0 ? process.argv[i + 1] ?? "" : "";
})();

function shouldRun(name: string): boolean {
  return !filterArg || name.toLowerCase().includes(filterArg.toLowerCase());
}

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1) return n.toFixed(digits);
  if (n >= 0.01) return n.toFixed(3);
  return n.toExponential(2);
}

interface Row {
  name: string;
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  hz: number;
  rmePct: number;
  samples: number;
}

function rowOf(t: { name: string; result: NonNullable<Bench["tasks"][number]["result"]> }): Row {
  // Tinybench occasionally returns a result missing `throughput` (or with
  // partial latency stats) when a task runs fewer iterations than its
  // sampling math expects — e.g. a 14 s single-iteration `medium/line-edits-50pct`
  // Chunk.build. Read everything defensively.
  const lat = t.result.latency ?? ({} as Record<string, number | undefined>);
  const tp = t.result.throughput ?? ({} as Record<string, number | undefined>);
  return {
    name: t.name,
    hz: tp.mean ?? 0,
    meanMs: lat.mean ?? 0,
    p50Ms: lat.p50 ?? 0,
    p99Ms: lat.p99 ?? 0,
    rmePct: lat.rme ?? 0,
    samples: lat.samplesCount ?? 0,
  };
}

function printTable(rows: Row[]): void {
  const cols = [
    { key: "name" as const, head: "scenario", w: Math.max(8, ...rows.map((r) => r.name.length)) },
    { key: "meanMs" as const, head: "mean (ms)", w: 11 },
    { key: "p50Ms" as const, head: "p50 (ms)", w: 10 },
    { key: "p99Ms" as const, head: "p99 (ms)", w: 10 },
    { key: "hz" as const, head: "ops/s", w: 12 },
    { key: "rmePct" as const, head: "rme%", w: 8 },
    { key: "samples" as const, head: "n", w: 6 },
  ];
  const sep = cols.map((c) => "-".repeat(c.w)).join("-+-");
  const head = cols.map((c) => c.head.padEnd(c.w)).join(" | ");
  console.log(head);
  console.log(sep);
  for (const r of rows) {
    const line = cols
      .map((c) => {
        const v = r[c.key];
        const s = c.key === "name" ? String(v) : c.key === "samples" ? String(v) : fmt(v as number);
        return s.padEnd(c.w);
      })
      .join(" | ");
    console.log(line);
  }
}

// Sample budgets per size tier. `iterations` is a *minimum* — tinybench keeps
// running until time AND iterations are both satisfied. The defaults assume
// each iteration is at most a few ms; sections that include slower scenarios
// (full Chunk.build) override with tighter caps.
type Tier = { prefix: string; opts: BenchOptions };

const FAST_TIERS: Tier[] = [
  { prefix: "small/",  opts: { time: 600, warmupTime: 150, iterations: 200, warmupIterations: 30 } },
  { prefix: "medium/", opts: { time: 600, warmupTime: 150, iterations: 50,  warmupIterations: 10 } },
  { prefix: "large/",  opts: { time: 400, warmupTime: 100, iterations: 20,  warmupIterations: 3  } },
];

// For the full Chunk.build bench: small disjoint already takes ~660ms per
// iteration, so we cap iteration counts hard.
const FULL_DIFF_TIERS: Tier[] = [
  { prefix: "small/",  opts: { time: 400, warmupTime: 100, iterations: 10, warmupIterations: 2 } },
  { prefix: "medium/", opts: { time: 400, warmupTime: 100, iterations: 5,  warmupIterations: 1 } },
  { prefix: "large/",  opts: { time: 400, warmupTime: 100, iterations: 3,  warmupIterations: 1 } },
];

interface Scenario {
  name: string;
  fn: () => void;
}

async function runSection(
  label: string,
  scenarios: Scenario[],
  tiers: Tier[] = FAST_TIERS,
): Promise<void> {
  if (!shouldRun(label)) return;
  progress(`\n=== ${label} ===\n`);
  console.log(`\n=== ${label} ===`);
  const allRows: Row[] = [];

  for (const tier of tiers) {
    const tierScenarios = scenarios.filter((s) => s.name.startsWith(tier.prefix));
    if (tierScenarios.length === 0) continue;

    const bench = new Bench(tier.opts);
    for (const s of tierScenarios) bench.add(s.name, s.fn);

    for (const task of bench.tasks) {
      progress(`  ${task.name.padEnd(40)}  ...`);
      const t0 = performance.now();
      await task.warmup();
      await task.run();
      const elapsed = performance.now() - t0;
      const r = task.result;
      if (!r) {
        progress(" (no result)\n");
        continue;
      }
      const row = rowOf({ name: task.name, result: r });
      allRows.push(row);
      progress(
        `\r  ${task.name.padEnd(40)}  ${fmt(row.meanMs).padStart(8)} ms  ` +
          `(p99 ${fmt(row.p99Ms)}, n=${row.samples}, wall=${elapsed.toFixed(0)}ms)\n`,
      );
    }
  }

  console.log("");
  printTable(allRows);
}

// --- main ---

progress("Building fixtures...\n");
const fixtures: Fixture[] = FIXTURES.map((spec) => {
  const t0 = performance.now();
  const f = buildFixture(spec);
  progress(`  ${spec.name.padEnd(35)}  ${(performance.now() - t0).toFixed(0)}ms\n`);
  return f;
});
const fixturesByName = new Map(fixtures.map((f) => [f.spec.name, f] as const));

const imaraMod = await import(
  "../crates/diff-wasm/pkg-node/differ_diff_wasm.js"
).catch(() => null);

// Section 1: legacy full diff (@codemirror/merge). This is no longer the
// production diff path, but keeping it visible makes regressions and the old
// baseline easy to compare against imara.
await runSection(
  "legacy Chunk.build (full diff)",
  fixtures
    .filter((f) => !f.spec.skipFullDiff)
    .map((f) => ({
      name: f.spec.name,
      fn: () => {
        Chunk.build(f.textA, f.textB);
      },
    })),
  FULL_DIFF_TIERS,
);

// Section 2: imara object-returning wrappers. These are not the production
// editor path anymore, but they quantify the allocation cost we avoid with
// DiffSession's packed Int32Array output.
if (imaraMod) {
  const imara = imaraMod as {
    diff: (a: string, b: string) => unknown[];
    diff_with_changes: (a: string, b: string) => unknown[];
    DiffSession: new () => DiffSessionLike & { free?: () => void };
  };
  // Use the same tight tier as CM-merge's full diff so the suite stays
  // bounded if imara doesn't beat Myers as cleanly as advertised on a given
  // workload. Includes disjoint fixtures we had to skip for CM-merge.
  await runSection(
    "imara-diff line-level (full)",
    fixtures.map((f) => ({
      name: f.spec.name,
      fn: () => {
        imara.diff(f.a, f.b);
      },
    })),
    FULL_DIFF_TIERS,
  );

  // Same inputs but with the byte-level inner pass that fills `changes` —
  // matches CM-merge's character-level inner highlight surface. This is the
  // shape we'd actually ship.
  await runSection(
    "imara-diff with inner changes",
    fixtures.map((f) => ({
      name: f.spec.name,
      fn: () => {
        imara.diff_with_changes(f.a, f.b);
      },
    })),
    FULL_DIFF_TIERS,
  );

  await runSection(
    "DiffSession set+compute+buffers (paste/full)",
    fixtures.map((f) => {
      const session = new imara.DiffSession();
      return {
        name: f.spec.name,
        fn: () => {
          session.set_a(f.a);
          session.set_b(f.b);
          session.compute_packed(true);
          session.chunks_buffer();
          session.changes_buffer();
        },
      };
    }),
    FULL_DIFF_TIERS,
  );
} else {
  progress(
    "\n(imara-diff WASM not found at crates/diff-wasm/pkg-node — run `bun run bench:build-wasm` to enable that section)\n",
  );
}

if (imaraMod) {
  const imara = imaraMod as {
    DiffSession: new () => DiffSessionLike & { free?: () => void };
  };

  progress("\nPre-computing packed baseline chunks...\n");
  interface Baseline {
    fixture: Fixture;
    chunks0: BenchDiffChunkSet;
    newB: string;
    viewportA: readonly [number, number];
    viewportB: readonly [number, number];
  }
  const baselines = new Map<string, Baseline>();
  for (const f of fixtures) {
    progress(`  ${f.spec.name.padEnd(35)}  diffing... `);
    const t0 = performance.now();
    const session = new imara.DiffSession();
    const chunks0 = computeChunkSet(session, f.a, f.b, true);
    session.free?.();
    const newB = insertOneCharAtMiddle(f.b);
    const centerA = Math.floor(f.a.length / 2);
    const centerB = Math.floor(newB.length / 2);
    baselines.set(f.spec.name, {
      fixture: f,
      chunks0,
      newB,
      viewportA: viewportAround(f.a, centerA),
      viewportB: viewportAround(newB, centerB),
    });
    progress(
      `${(performance.now() - t0).toFixed(0)}ms (${chunks0.length} chunks)\n`,
    );
  }

  await runSection(
    "DiffSession setB+compute+buffers (1-char edit on B)",
    fixtures.map((f) => {
      const bl = baselines.get(f.spec.name)!;
      const session = new imara.DiffSession();
      session.set_a(f.a);
      session.set_b(f.b);
      session.compute_packed(true);
      return {
        name: f.spec.name,
        fn: () => {
          session.set_b(bl.newB);
          session.compute_packed(true);
          session.chunks_buffer();
          session.changes_buffer();
        },
      };
    }),
  );

  await runSection(
    "buildDecorations full (side b)",
    fixtures.map((f) => {
      const bl = baselines.get(f.spec.name)!;
      return {
        name: f.spec.name,
        fn: () => {
          buildDecorations("b", bl.chunks0);
        },
      };
    }),
  );

  await runSection(
    "buildDecorations viewport (side b)",
    fixtures.map((f) => {
      const bl = baselines.get(f.spec.name)!;
      const [from, to] = bl.viewportB;
      return {
        name: f.spec.name,
        fn: () => {
          buildDecorations("b", bl.chunks0, from, to);
        },
      };
    }),
  );

  await runSection(
    "buildGutterRangeSet full (side b)",
    fixtures.map((f) => {
      const bl = baselines.get(f.spec.name)!;
      return {
        name: f.spec.name,
        fn: () => {
          buildGutterRangeSet("b", bl.chunks0);
        },
      };
    }),
  );

  const countStats = (chunks: BenchDiffChunkSet): void => {
    let added = 0;
    let removed = 0;
    for (let i = 0; i < chunks.length; i++) {
      removed += countChangedLines(chunks.aText, chunks.fromA(i), chunks.endA(i));
      added += countChangedLines(chunks.bText, chunks.fromB(i), chunks.endB(i));
    }
    if (added + removed < 0) throw new Error("unreachable");
  };

  await runSection(
    "per-keystroke production combined",
    fixtures.map((f) => {
      const bl = baselines.get(f.spec.name)!;
      const session = new imara.DiffSession();
      session.set_a(f.a);
      session.set_b(f.b);
      session.compute_packed(true);
      const [aFrom, aTo] = bl.viewportA;
      const [bFrom, bTo] = bl.viewportB;
      return {
        name: f.spec.name,
        fn: () => {
          session.set_b(bl.newB);
          session.compute_packed(true);
          const chunks = chunkSetFromSession(session, f.a, bl.newB);
          countStats(chunks);
          buildDecorations("a", chunks, aFrom, aTo);
          buildDecorations("b", chunks, bFrom, bTo);
          buildGutterRangeSet("a", chunks);
          buildGutterRangeSet("b", chunks);
        },
      };
    }),
  );
}

await runSection(
  "detectLanguage",
  (
    [
      ["small/line-edits-10pct", "small/"],
      ["medium/line-edits-5pct", "medium/"],
      ["large/line-edits-5pct", "large/"],
    ] as const
  ).map(([fixtureName, prefix]) => {
    const text = fixturesByName.get(fixtureName)!.b;
    return {
      name: prefix + "sample",
      fn: () => {
        detectLanguage(text);
      },
    };
  }),
);

progress("\nDone.\n");
console.log("\nDone.");
