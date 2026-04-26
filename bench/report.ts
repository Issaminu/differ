// Unified per-scenario report combining browser-side category timings
// (from the Tracing.dataCollected JSON) with function-level self-time
// (from the Profiler.cpuprofile) — same files the harness already emits.
//
// Reports ms, not percentages. Self-time on the cpuprofile is computed
// from the sample stream, then aggregated by source area (WASM / our code
// / CodeMirror / Lezer / V8 internals) so we can see *where* the time
// went, not just which leaf function had the most samples.
//
//   bun run bench:report                      # all scenarios
//   bun run bench:report stress-70mb keystroke # filter

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACES = path.join(HERE, "browser", "traces");

const filter = process.argv.slice(2);
function matches(name: string): boolean {
  return filter.length === 0 || filter.every((f) => name.toLowerCase().includes(f.toLowerCase()));
}

// ---- trace.json (browser categories) ----

interface TraceEvent {
  cat?: string;
  name?: string;
  ph?: string;
  ts?: number;
  dur?: number;
}

interface BrowserBreakdown {
  wallMs: number;
  gcMs: number;
  layoutMs: number;
  paintMs: number;
  styleMs: number;
  rafMs: number;
}

function readBrowserBreakdown(tracePath: string): BrowserBreakdown {
  const raw = JSON.parse(readFileSync(tracePath, "utf8")) as { traceEvents?: TraceEvent[] };
  const events: TraceEvent[] = Array.isArray(raw)
    ? (raw as unknown as TraceEvent[])
    : raw.traceEvents ?? [];

  let firstTs = Infinity;
  let lastTs = 0;
  let gc = 0,
    layout = 0,
    paint = 0,
    style = 0,
    raf = 0;
  for (const e of events) {
    if (e.ph !== "X" || typeof e.dur !== "number") continue;
    const name = e.name ?? "";
    if (typeof e.ts === "number") {
      if (e.ts < firstTs) firstTs = e.ts;
      if (e.ts + e.dur > lastTs) lastTs = e.ts + e.dur;
    }
    // We only consume the headline GC events to avoid double-counting
    // V8.GC_MC_BACKGROUND_MARKING + V8.GC_MARK_COMPACTOR (same work).
    if (name === "MajorGC" || name === "MinorGC" || name === "V8.GC_MC_BACKGROUND_MARKING" ||
        name === "V8.GC_SCAVENGER_BACKGROUND_SCAVENGE_PARALLEL") gc += e.dur;
    else if (name === "Layout" || name === "UpdateLayoutTree") layout += e.dur;
    else if (name === "Paint" || name === "PaintImage" || name === "CompositeLayers" ||
             name === "PrePaint" || name === "RasterTask" || name === "GPUTask") paint += e.dur;
    else if (name === "RecalculateStyles") style += e.dur;
    else if (name === "FireAnimationFrame") raf += e.dur;
  }
  return {
    wallMs: (lastTs - firstTs) / 1000,
    gcMs: gc / 1000,
    layoutMs: layout / 1000,
    paintMs: paint / 1000,
    styleMs: style / 1000,
    rafMs: raf / 1000,
  };
}

// ---- cpuprofile (JS function self-time, grouped by source area) ----

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}
interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}
interface CPUProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

interface AreaBreakdown {
  totalSampledMs: number;
  byArea: Map<string, number>;
  byFunction: Map<string, number>; // top JS functions by self-time
}

// Bucket a callframe URL into a coarse "source area" so we can see
// where time really goes without staring at minified bundle names.
// The patterns are matched against the URL of the call frame, plus a
// special bucket for native frames (which V8 reports as "(program)" or
// "(garbage collector)" or empty URLs).
function areaFor(frame: CallFrame): string {
  const name = frame.functionName ?? "";
  const url = frame.url ?? "";

  if (name === "(idle)") return "idle";
  if (name === "(garbage collector)") return "GC (sampled)";
  if (name === "(program)") return "V8 native";
  if (name.startsWith("(") && name.endsWith(")")) return "V8 native";

  if (url.includes("differ_diff_wasm")) return "imara WASM (JS shim)";
  if (url.includes("/crates/diff-wasm/")) return "imara WASM (JS shim)";
  if (url.includes("__bench")) return "bench harness";

  // The lazy-loaded language data chunks (Lezer + grammars). The bundler
  // names them dist-XXX.js by default — so we group by URL pattern that
  // happens to match either path.
  if (url.includes("/dist-") || url.includes("/assets/dist-")) return "CodeMirror / Lezer (bundle chunk)";
  if (url.includes("/index-") || url.includes("/assets/index-")) return "Differ app entry bundle";

  if (url.includes("@codemirror") || url.includes("/codemirror/")) return "CodeMirror";
  if (url.includes("@lezer") || url.includes("/lezer/")) return "Lezer";
  if (url.includes("/src/")) return "Differ source";

  if (url === "" && (name === "" || name === "(anonymous)")) return "V8 native";
  if (url === "") return "(unknown)";

  return "other";
}

function readCpuBreakdown(cpuPath: string): AreaBreakdown {
  const profile: CPUProfile = JSON.parse(readFileSync(cpuPath, "utf8"));
  const nodeById = new Map<number, ProfileNode>(profile.nodes.map((n) => [n.id, n]));

  // Sample-based self-time: each sample lands at one node; that node owns
  // the time delta between consecutive samples.
  const selfByNode = new Map<number, number>();
  let totalUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    const dt = profile.timeDeltas[i] ?? 0;
    selfByNode.set(id, (selfByNode.get(id) ?? 0) + dt);
    totalUs += dt;
  }

  const byArea = new Map<string, number>();
  const byFunction = new Map<string, number>();
  for (const [nodeId, us] of selfByNode) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const area = areaFor(node.callFrame);
    byArea.set(area, (byArea.get(area) ?? 0) + us);
    const fn = node.callFrame.functionName || "(anonymous)";
    byFunction.set(fn, (byFunction.get(fn) ?? 0) + us);
  }
  return {
    totalSampledMs: totalUs / 1000,
    byArea: new Map([...byArea].map(([k, v]) => [k, v / 1000])),
    byFunction: new Map([...byFunction].map(([k, v]) => [k, v / 1000])),
  };
}

// ---- main ----

function pad(s: string, n: number): string {
  return s.padEnd(n);
}
function padR(s: string, n: number): string {
  return s.padStart(n);
}
function fmtMs(ms: number): string {
  if (ms >= 100) return ms.toFixed(0);
  if (ms >= 10) return ms.toFixed(1);
  if (ms >= 1) return ms.toFixed(2);
  return ms.toFixed(3);
}

function printScenario(traceFile: string, cpuFile: string, name: string): void {
  const browser = readBrowserBreakdown(traceFile);
  const cpu = readCpuBreakdown(cpuFile);

  console.log(`\n=== ${name} ===`);
  console.log(`  wall: ${fmtMs(browser.wallMs)} ms   sampled JS: ${fmtMs(cpu.totalSampledMs)} ms`);
  console.log(`  browser categories (ms):`);
  console.log(
    `    GC ${padR(fmtMs(browser.gcMs), 8)}   Layout ${padR(fmtMs(browser.layoutMs), 8)}   ` +
      `Paint ${padR(fmtMs(browser.paintMs), 8)}   Style ${padR(fmtMs(browser.styleMs), 8)}   ` +
      `rAF ${padR(fmtMs(browser.rafMs), 8)}`,
  );
  console.log(`  JS self-time by source area (ms, sampled):`);
  const areas = [...cpu.byArea.entries()].sort((a, b) => b[1] - a[1]);
  for (const [area, ms] of areas) {
    if (ms < 1) continue;
    const pct = ((ms / cpu.totalSampledMs) * 100).toFixed(1);
    console.log(`    ${pad(area, 36)} ${padR(fmtMs(ms), 8)} ms  (${padR(pct, 5)}%)`);
  }
  console.log(`  top 10 JS functions by self-time (ms):`);
  const fns = [...cpu.byFunction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [fn, ms] of fns) {
    if (ms < 0.5) continue;
    console.log(`    ${pad(fn, 40)} ${padR(fmtMs(ms), 8)} ms`);
  }
}

function listScenarios(): { name: string; trace: string; cpu: string }[] {
  const files = readdirSync(TRACES);
  const map = new Map<string, { trace?: string; cpu?: string }>();
  for (const f of files) {
    const trace = f.endsWith(".trace.json");
    const cpu = f.endsWith(".cpuprofile");
    if (!trace && !cpu) continue;
    const base = f.replace(/\.(trace\.json|cpuprofile)$/, "");
    const entry = map.get(base) ?? {};
    if (trace) entry.trace = path.join(TRACES, f);
    if (cpu) entry.cpu = path.join(TRACES, f);
    map.set(base, entry);
  }
  return Array.from(map.entries())
    .filter(([, v]) => v.trace && v.cpu)
    .map(([k, v]) => ({ name: k, trace: v.trace!, cpu: v.cpu! }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const scenarios = listScenarios().filter((s) => matches(s.name));
if (scenarios.length === 0) {
  console.error(`no scenarios match filter: ${filter.join(", ")}`);
  process.exit(1);
}
for (const s of scenarios) {
  printScenario(s.trace, s.cpu, s.name);
}
