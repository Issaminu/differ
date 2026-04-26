// Benchmarks for the diff editor's CPU hot paths.
//
//   - `Chunk.build`       : the diff algorithm itself (full recompute).
//   - `Chunk.updateB`     : incremental update on a typed-on-the-right edit.
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
import { ChangeSet } from "@codemirror/state";

import {
  buildDecorations,
  buildGutterRangeSet,
} from "../src/merge/diffDecorations.ts";
import { detectLanguage } from "../src/merge/languageDetect.ts";
import { FIXTURES, buildFixture, type Fixture } from "./fixtures.ts";

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
  return {
    name: t.name,
    hz: t.result.throughput.mean ?? 0,
    meanMs: t.result.latency.mean ?? 0,
    p50Ms: t.result.latency.p50 ?? 0,
    p99Ms: t.result.latency.p99 ?? 0,
    rmePct: t.result.latency.rme ?? 0,
    samples: t.result.latency.samplesCount ?? 0,
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

// Section 1: full diff (Chunk.build). Skip the marked-pathological cases —
// see fixtures.ts for the why. Uses tighter iteration caps because some of
// these scenarios exceed 100ms/iter.
await runSection(
  "Chunk.build (full diff)",
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

// Section 1b: same scenarios via the imara-diff WASM wrapper (line-level).
// Loaded lazily so the rest of the suite still runs if the .wasm hasn't been
// built yet. Includes the disjoint cases that we *had* to skip for CM-merge —
// imara should handle them in human time.
const imaraMod = await import(
  "../crates/diff-wasm/pkg-node/differ_diff_wasm.js"
).catch(() => null);
if (imaraMod) {
  const imara = imaraMod as {
    diff: (a: string, b: string) => unknown[];
    diff_with_changes: (a: string, b: string) => unknown[];
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
} else {
  progress(
    "\n(imara-diff WASM not found at crates/diff-wasm/pkg-node — run `bun run bench:build-wasm` to enable that section)\n",
  );
}

// Pre-compute baseline chunks + a 1-char insertion for incremental scenarios.
progress("\nPre-computing baseline chunks...\n");
interface Baseline {
  fixture: Fixture;
  chunks0: readonly Chunk[];
  newB: Fixture["textB"];
  change: ChangeSet;
}
const baselines = new Map<string, Baseline>();
for (const f of fixtures) {
  progress(`  ${f.spec.name.padEnd(35)}  diffing... `);
  const t0 = performance.now();
  const chunks0 = Chunk.build(f.textA, f.textB);
  const insertAt = Math.floor(f.textB.length / 2);
  const change = ChangeSet.of(
    { from: insertAt, to: insertAt, insert: "x" },
    f.textB.length,
  );
  const newB = change.apply(f.textB);
  baselines.set(f.spec.name, { fixture: f, chunks0, newB, change });
  progress(
    `${(performance.now() - t0).toFixed(0)}ms (${chunks0.length} chunks)\n`,
  );
}

// Section 2: incremental update — what runs on every keystroke. Skip
// fixtures where updateB observably falls back to a full diff (one giant
// chunk) — those would dominate the suite without showing anything new.
await runSection(
  "Chunk.updateB (1-char edit on B)",
  fixtures
    .filter((f) => !f.spec.skipKeystroke)
    .map((f) => {
      const bl = baselines.get(f.spec.name)!;
      return {
        name: f.spec.name,
        fn: () => {
          Chunk.updateB(bl.chunks0, f.textA, bl.newB, bl.change);
        },
      };
    }),
);

await runSection(
  "buildDecorations (side b)",
  fixtures.map((f) => {
    const bl = baselines.get(f.spec.name)!;
    return {
      name: f.spec.name,
      fn: () => {
        buildDecorations("b", bl.chunks0, f.textB);
      },
    };
  }),
);

await runSection(
  "buildGutterRangeSet (side b)",
  fixtures.map((f) => {
    const bl = baselines.get(f.spec.name)!;
    return {
      name: f.spec.name,
      fn: () => {
        buildGutterRangeSet("b", bl.chunks0, f.textB);
      },
    };
  }),
);

// Section 5: combined — what the editor actually does on a single keystroke.
await runSection(
  "per-keystroke combined",
  fixtures
    .filter((f) => !f.spec.skipKeystroke)
    .map((f) => {
      const bl = baselines.get(f.spec.name)!;
      return {
        name: f.spec.name,
        fn: () => {
          const chunks = Chunk.updateB(bl.chunks0, f.textA, bl.newB, bl.change);
          buildDecorations("a", chunks, f.textA);
          buildDecorations("b", chunks, bl.newB);
          buildGutterRangeSet("a", chunks, f.textA);
          buildGutterRangeSet("b", chunks, bl.newB);
        },
      };
    }),
);

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
