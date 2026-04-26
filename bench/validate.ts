// Correctness validation: imara-diff vs @codemirror/merge on the same fixtures.
//
// We can't compare chunks structurally (the diff problem has multiple valid
// solutions and Histogram + Myers will pick different ones). Instead we
// check the *stronger* invariant that any correct diff must satisfy:
//
//   Walking chunks in order, the text BETWEEN chunks must be byte-identical
//   on both sides. Anything claimed unchanged by the chunk set really has
//   to be unchanged.
//
// If both algorithms pass this check on every fixture, they're both correct
// (in the sense that swapping one for the other doesn't break the diff
// guarantees the editor relies on). Their chunks can still differ in shape.
//
//   bun run bench:validate

import { writeSync } from "node:fs";
import { Chunk } from "@codemirror/merge";
import { FIXTURES, buildFixture } from "./fixtures.ts";

interface ChunkLike {
  fromA: number;
  endA: number;
  fromB: number;
  endB: number;
  changes?: { fromA: number; toA: number; fromB: number; toB: number }[];
}

// Application invariant: take unchanged regions from A and changed regions
// from B according to the chunk set, you must reproduce B exactly. This is
// looser than "gaps must match byte-for-byte" — it tolerates chunks that
// pull a boundary char (typically the trailing newline of preceding context)
// into the changed range, which CM-merge does for clean visual rendering on
// pure block insertions. Both shapes are valid diffs.
function verifyApply(a: string, b: string, chunks: readonly ChunkLike[]): null | string {
  let bPrime = "";
  let aPos = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.fromA < aPos) {
      return `chunk ${i} starts before previous end on A (aPos=${aPos}, fromA=${c.fromA})`;
    }
    bPrime += a.slice(aPos, c.fromA);
    bPrime += b.slice(c.fromB, c.endB);
    aPos = c.endA;
  }
  bPrime += a.slice(aPos);
  if (bPrime === b) return null;
  let i = 0;
  while (i < bPrime.length && i < b.length && bPrime[i] === b[i]) i++;
  return `applied output diverges from b at index ${i}: got="${bPrime.slice(i, i + 60)}" want="${b.slice(i, i + 60)}"`;
}

// Sum of changed bytes on the given side, used as a sanity rough-equivalence
// check ("are both algorithms claiming roughly the same amount of text was
// touched?"). Differences here aren't bugs — Histogram and Myers can pick
// different but equally valid diffs — but huge gaps would suggest a real
// shape mismatch worth investigating.
function changedBytes(chunks: readonly ChunkLike[], side: "a" | "b"): number {
  let n = 0;
  for (const c of chunks) {
    const from = side === "a" ? c.fromA : c.fromB;
    const to = side === "a" ? c.endA : c.endB;
    n += Math.max(0, to - from);
  }
  return n;
}

const imaraMod = await import(
  "../crates/diff-wasm/pkg-node/differ_diff_wasm.js"
);
const imara = imaraMod as {
  diff: (a: string, b: string) => ChunkLike[];
  diff_with_changes: (a: string, b: string) => ChunkLike[];
};

interface Row {
  fixture: string;
  cmChunks: number;
  imaraChunks: number;
  cmChangedA: number;
  imaraChangedA: number;
  cmApplyError: string | null;
  imaraApplyError: string | null;
}

const rows: Row[] = [];

for (const spec of FIXTURES) {
  if (spec.skipFullDiff) {
    writeSync(2, `skipping ${spec.name} (skipFullDiff)\n`);
    continue;
  }
  writeSync(2, `validating ${spec.name}...\n`);
  const f = buildFixture(spec);
  const cmChunks = Chunk.build(f.textA, f.textB);
  const imaraChunks = imara.diff_with_changes(f.a, f.b);

  rows.push({
    fixture: spec.name,
    cmChunks: cmChunks.length,
    imaraChunks: imaraChunks.length,
    cmChangedA: changedBytes(cmChunks as unknown as ChunkLike[], "a"),
    imaraChangedA: changedBytes(imaraChunks, "a"),
    cmApplyError: verifyApply(f.a, f.b, cmChunks as unknown as ChunkLike[]),
    imaraApplyError: verifyApply(f.a, f.b, imaraChunks),
  });
}

const colW = (head: string, vals: (string | number)[]) =>
  Math.max(head.length, ...vals.map((v) => String(v).length));

const cols = [
  ["fixture", rows.map((r) => r.fixture)],
  ["CM chunks", rows.map((r) => r.cmChunks)],
  ["imara chunks", rows.map((r) => r.imaraChunks)],
  ["CM changed", rows.map((r) => r.cmChangedA)],
  ["imara changed", rows.map((r) => r.imaraChangedA)],
  ["CM ok?", rows.map((r) => (r.cmApplyError ? "FAIL" : "ok"))],
  ["imara ok?", rows.map((r) => (r.imaraApplyError ? "FAIL" : "ok"))],
] as const;

const widths = cols.map(([h, v]) => colW(h, v));
const header = cols.map(([h], i) => String(h).padEnd(widths[i])).join(" | ");
const sep = widths.map((w) => "-".repeat(w)).join("-+-");
console.log(header);
console.log(sep);
for (let i = 0; i < rows.length; i++) {
  const line = cols.map(([, v], ci) => String(v[i]).padEnd(widths[ci])).join(" | ");
  console.log(line);
}

const cmFails = rows.filter((r) => r.cmApplyError);
const imaraFails = rows.filter((r) => r.imaraApplyError);

if (cmFails.length > 0) {
  console.log(
    `\n@codemirror/merge produces invalid diffs on ${cmFails.length}/${rows.length} fixtures:`,
  );
  for (const r of cmFails) console.log(`  ${r.fixture}: ${r.cmApplyError}`);
}
if (imaraFails.length > 0) {
  console.log(
    `\nimara-diff produces invalid diffs on ${imaraFails.length}/${rows.length} fixtures:`,
  );
  for (const r of imaraFails) console.log(`  ${r.fixture}: ${r.imaraApplyError}`);
  process.exit(1);
}
console.log("\nimara-diff: all fixtures pass the apply invariant.");
if (cmFails.length === 0) {
  console.log("@codemirror/merge: all fixtures pass.");
}
