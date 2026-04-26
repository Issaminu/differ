// Quick analyzer: read a .cpuprofile and print the top-N functions by
// self-time (sum of own samples, excluding callees) and inclusive time
// (self + children). Use this when you want the headline number without
// loading speedscope — speedscope is still the right tool for visual
// flame graphs.
//
//   bun run bench:analyze bench/profiles/chunk-build__medium_line-edits-50pct.cpuprofile

import { readFileSync } from "node:fs";

interface CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}
interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount?: number;
  children?: number[];
}
interface CPUProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run bench:analyze <path-to-cpuprofile>");
  process.exit(1);
}

const profile: CPUProfile = JSON.parse(readFileSync(path, "utf8"));
const nodeById = new Map<number, ProfileNode>(profile.nodes.map((n) => [n.id, n]));

// Each sample lands at a single leaf node; that leaf gets credit for that
// time delta as "self time".
const selfTimeByNode = new Map<number, number>();
const totalTimeByNode = new Map<number, number>();
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  const dt = profile.timeDeltas[i] ?? 0;
  selfTimeByNode.set(id, (selfTimeByNode.get(id) ?? 0) + dt);
}

// Walk parents to compute total (inclusive) time. Build parent map first.
const parentOf = new Map<number, number>();
for (const n of profile.nodes) {
  if (!n.children) continue;
  for (const c of n.children) parentOf.set(c, n.id);
}
for (const [leafId, dt] of selfTimeByNode) {
  let cur: number | undefined = leafId;
  const seen = new Set<number>();
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    totalTimeByNode.set(cur, (totalTimeByNode.get(cur) ?? 0) + dt);
    cur = parentOf.get(cur);
  }
}

// Aggregate by call site (function + script + line) so identical calls
// merge across recursive frames.
type Key = string;
function keyOf(n: ProfileNode): Key {
  const fn = n.callFrame.functionName || "(anonymous)";
  const url = n.callFrame.url || "(unknown)";
  return `${fn}  ${url}:${n.callFrame.lineNumber}`;
}

const selfByKey = new Map<Key, number>();
const totalByKey = new Map<Key, number>();
for (const n of profile.nodes) {
  const k = keyOf(n);
  selfByKey.set(k, (selfByKey.get(k) ?? 0) + (selfTimeByNode.get(n.id) ?? 0));
  totalByKey.set(k, (totalByKey.get(k) ?? 0) + (totalTimeByNode.get(n.id) ?? 0));
}

const totalDuration = profile.endTime - profile.startTime;
const sortedSelf = Array.from(selfByKey.entries())
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);

console.log(`profile: ${path}`);
console.log(`total wall: ${(totalDuration / 1000).toFixed(1)}ms (${profile.samples.length} samples)`);
console.log("");
console.log("top 20 by self-time (µs and % of wall):");
console.log(
  "  self_us".padStart(10) + "  " + "self%".padStart(6) + "  " + "incl%".padStart(6) + "  function",
);
for (const [k, self] of sortedSelf) {
  const incl = totalByKey.get(k) ?? 0;
  const selfPct = ((self / totalDuration) * 100).toFixed(1);
  const inclPct = ((incl / totalDuration) * 100).toFixed(1);
  console.log(
    `${Math.round(self).toString().padStart(10)}  ${selfPct.padStart(6)}  ${inclPct.padStart(6)}  ${k}`,
  );
}
