// Trace JSON analyzer — same input as Chrome DevTools' "Load profile…",
// but reports a flat ms breakdown so we don't have to interpret a flame
// chart by eye. Reports two views:
//
//   1. Time per category (JS / Layout / Style / Paint / GC / Wasm / Other)
//   2. Top-30 individual events by total duration
//
// Usage:
//   bun run bench:analyze-trace bench/browser/traces/<scenario>.trace.json

import { readFileSync } from "node:fs";

interface TraceEvent {
  cat?: string;
  name?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  args?: { data?: { url?: string; functionName?: string } };
}

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run bench:analyze-trace <path-to-trace.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(path, "utf8")) as { traceEvents?: TraceEvent[] };
const events: TraceEvent[] = Array.isArray(raw) ? (raw as unknown as TraceEvent[]) : raw.traceEvents ?? [];

// Many events nest. To get *self time* per event (not double-counting nested
// children) we'd need to walk the timeline. For a first pass just summing
// `dur` of every "complete" event by name gives a useful headline — nested
// double-counting inflates parents but the leaves are accurate, and
// sorting by dur surfaces what mattered. We tag the totals "(inclusive)"
// to be honest about what we're measuring.

interface Bucket {
  totalUs: number;
  count: number;
}

const byName = new Map<string, Bucket>();
let firstTs = Infinity;
let lastTs = 0;
for (const e of events) {
  if (e.ph !== "X" || typeof e.dur !== "number") continue;
  const name = e.name ?? "(unnamed)";
  const b = byName.get(name) ?? { totalUs: 0, count: 0 };
  b.totalUs += e.dur;
  b.count += 1;
  byName.set(name, b);
  if (typeof e.ts === "number") {
    if (e.ts < firstTs) firstTs = e.ts;
    if (e.ts + e.dur > lastTs) lastTs = e.ts + e.dur;
  }
}

const totalWallMs = (lastTs - firstTs) / 1000;

// Categorise by event name. Names come from Chrome's devtools.timeline
// instrumentation.
const CATEGORIES: { label: string; matches: (name: string) => boolean }[] = [
  { label: "JS execution", matches: (n) =>
    n === "FunctionCall" || n === "EvaluateScript" || n === "v8.run" || n === "v8.callFunction",
  },
  { label: "JS compile", matches: (n) =>
    n.startsWith("v8.compile") || n === "V8.CompileCode" || n === "ParseAuthorStyleSheet",
  },
  { label: "Microtasks", matches: (n) =>
    n === "RunMicrotasks" || n === "v8.run.microtasks" || n === "MicrotaskQueue::PerformCheckpoint",
  },
  { label: "Layout", matches: (n) =>
    n === "Layout" || n === "UpdateLayoutTree" || n === "ScheduleStyleInvalidationTracking",
  },
  { label: "Style recalc", matches: (n) =>
    n === "RecalculateStyles" || n === "ScheduleStyleRecalculation",
  },
  { label: "Paint", matches: (n) =>
    n === "Paint" || n === "PaintImage" || n === "CompositeLayers" || n === "RasterTask" ||
    n === "PrePaint" || n === "GPUTask" || n === "Pre-FCP",
  },
  { label: "GC", matches: (n) =>
    n.startsWith("V8.GC") || n.includes("GarbageCollect") || n === "MajorGC" || n === "MinorGC",
  },
  { label: "WebAssembly", matches: (n) =>
    n.startsWith("WebAssembly") || n.startsWith("v8.wasm") || n.startsWith("V8.Wasm"),
  },
  { label: "Network / fetch", matches: (n) =>
    n === "ResourceSendRequest" || n === "ResourceReceivedData" || n === "ResourceFinish" ||
    n === "ResourceWillSendRequest" || n === "ResourceReceiveResponse",
  },
  { label: "Parse HTML", matches: (n) => n === "ParseHTML" || n === "HTMLParserScriptRunner" },
];

const catTotals = new Map<string, number>();
let otherUs = 0;
for (const [name, b] of byName) {
  const cat = CATEGORIES.find((c) => c.matches(name));
  if (cat) {
    catTotals.set(cat.label, (catTotals.get(cat.label) ?? 0) + b.totalUs);
  } else {
    otherUs += b.totalUs;
  }
}

console.log(`trace: ${path}`);
console.log(`total wall: ${totalWallMs.toFixed(1)} ms (${events.length} events)`);
console.log("");
console.log("by category (inclusive ms — double-counted across nested events):");
const catRows = [
  ...Array.from(catTotals.entries()).map(([label, us]) => ({ label, ms: us / 1000 })),
  { label: "Other", ms: otherUs / 1000 },
].sort((a, b) => b.ms - a.ms);
for (const { label, ms } of catRows) {
  if (ms < 0.5) continue;
  console.log(`  ${label.padEnd(20)} ${ms.toFixed(1).padStart(10)} ms`);
}
console.log("");
console.log("top 30 events by total ms (inclusive — parents double-count children):");
console.log(
  "  " +
    "ms".padStart(10) +
    "  " +
    "count".padStart(7) +
    "  event",
);
const top = Array.from(byName.entries())
  .sort((a, b) => b[1].totalUs - a[1].totalUs)
  .slice(0, 30);
for (const [name, b] of top) {
  console.log(
    `  ${(b.totalUs / 1000).toFixed(1).padStart(10)}  ${String(b.count).padStart(7)}  ${name}`,
  );
}
