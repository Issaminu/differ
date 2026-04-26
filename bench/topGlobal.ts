// Aggregator across every browser-bench cpuprofile + trace.
// For each event/area, sums total self-time across all scenarios so we
// can see what would have the biggest impact if optimised globally —
// rather than picking one scenario at a time.
//
//   bun run bench:top-global

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACES = path.join(HERE, "browser", "traces");

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}
interface ProfileNode {
  id: number;
  callFrame: CallFrame;
}
interface CPUProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

function areaFor(frame: CallFrame): string {
  const name = frame.functionName ?? "";
  const url = frame.url ?? "";

  if (name === "(idle)") return "idle (rAF/microtask wait)";
  if (name === "(garbage collector)") return "GC (sampled)";
  if (name === "(program)") return "V8 native";
  if (name.startsWith("(") && name.endsWith(")")) return "V8 native";

  if (url.includes("differ_diff_wasm") || url.includes("/crates/diff-wasm/"))
    return "imara WASM (JS shim)";
  if (url.includes("/dist-") || url.includes("/assets/dist-"))
    return "CodeMirror / Lezer (bundle chunks)";
  if (url.includes("/index-") || url.includes("/assets/index-"))
    return "Differ app entry bundle";
  if (url.includes("@codemirror") || url.includes("/codemirror/")) return "CodeMirror";
  if (url.includes("@lezer") || url.includes("/lezer/")) return "Lezer";
  if (url.includes("/src/")) return "Differ source";
  if (url === "" && (name === "" || name === "(anonymous)")) return "V8 native";
  if (url === "") return "(unknown)";
  return "other";
}

interface Totals {
  byArea: Map<string, number>;
  byFunction: Map<string, number>;
  scenarioCount: number;
  totalSampledMs: number;
  perScenario: { name: string; sampledMs: number; topArea: string; topAreaMs: number }[];
}

function aggregate(): Totals {
  const files = readdirSync(TRACES).filter((f) => f.endsWith(".cpuprofile"));
  const byArea = new Map<string, number>();
  const byFunction = new Map<string, number>();
  let totalUs = 0;
  const perScenario: Totals["perScenario"] = [];

  for (const file of files.sort()) {
    const profile: CPUProfile = JSON.parse(readFileSync(path.join(TRACES, file), "utf8"));
    const nodeById = new Map<number, ProfileNode>(profile.nodes.map((n) => [n.id, n]));
    let scenarioUs = 0;
    const scenarioByArea = new Map<string, number>();
    for (let i = 0; i < profile.samples.length; i++) {
      const id = profile.samples[i];
      const dt = profile.timeDeltas[i] ?? 0;
      const node = nodeById.get(id);
      if (!node) continue;
      const area = areaFor(node.callFrame);
      const fn = node.callFrame.functionName || "(anonymous)";
      byArea.set(area, (byArea.get(area) ?? 0) + dt);
      byFunction.set(fn, (byFunction.get(fn) ?? 0) + dt);
      scenarioByArea.set(area, (scenarioByArea.get(area) ?? 0) + dt);
      scenarioUs += dt;
      totalUs += dt;
    }
    let topArea = "";
    let topAreaUs = 0;
    for (const [area, us] of scenarioByArea) {
      if (us > topAreaUs) {
        topAreaUs = us;
        topArea = area;
      }
    }
    perScenario.push({
      name: file.replace(".cpuprofile", ""),
      sampledMs: scenarioUs / 1000,
      topArea,
      topAreaMs: topAreaUs / 1000,
    });
  }

  return {
    byArea: new Map([...byArea].map(([k, v]) => [k, v / 1000])),
    byFunction: new Map([...byFunction].map(([k, v]) => [k, v / 1000])),
    scenarioCount: files.length,
    totalSampledMs: totalUs / 1000,
    perScenario,
  };
}

function fmt(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(2) + " s";
  if (ms >= 100) return ms.toFixed(0) + " ms";
  if (ms >= 10) return ms.toFixed(1) + " ms";
  return ms.toFixed(2) + " ms";
}

const t = aggregate();
console.log(`Aggregated across ${t.scenarioCount} cpuprofiles (every browser-bench scenario)`);
console.log(`Total sampled JS time: ${fmt(t.totalSampledMs)}`);
console.log("");
console.log("Self-time by source area, summed across all scenarios:");
const areas = [...t.byArea.entries()].sort((a, b) => b[1] - a[1]);
const areaW = Math.max(...areas.map(([k]) => k.length));
for (const [area, ms] of areas) {
  const pct = ((ms / t.totalSampledMs) * 100).toFixed(1);
  console.log(`  ${area.padEnd(areaW)} ${fmt(ms).padStart(10)}  (${pct.padStart(5)}%)`);
}
console.log("");
console.log("Top 20 functions by aggregated self-time:");
const fns = [...t.byFunction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
for (const [fn, ms] of fns) {
  console.log(`  ${fn.padEnd(40)} ${fmt(ms).padStart(10)}`);
}
console.log("");
console.log("Per-scenario top area (where each scenario spent most of its time):");
const nameW = Math.max(...t.perScenario.map((s) => s.name.length));
for (const s of t.perScenario.sort((a, b) => b.sampledMs - a.sampledMs)) {
  console.log(
    `  ${s.name.padEnd(nameW)}  ${fmt(s.sampledMs).padStart(10)}  ${s.topArea} (${fmt(s.topAreaMs)})`,
  );
}
