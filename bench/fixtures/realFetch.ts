// Real-world fixture loader. Pulls actual source files from public repos
// (cached locally on first run) and stitches them into diff pairs that
// represent things a Differ user would plausibly paste — version-to-version
// evolution of a big d.ts file, plus a "rename one identifier across a real
// file" case that mirrors a typical refactor.
//
// Cache lives at bench/fixtures/real/cache/ and is gitignored.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, "real", "cache");
const REPO_ROOT = path.resolve(HERE, "..", "..");

interface RemoteFile {
  url: string;
  cacheName: string;
}

const FILES: Record<string, RemoteFile> = {
  domV50: {
    url: "https://raw.githubusercontent.com/microsoft/TypeScript/v5.0.4/src/lib/dom.generated.d.ts",
    cacheName: "dom.generated.v5.0.4.d.ts",
  },
  domV54: {
    url: "https://raw.githubusercontent.com/microsoft/TypeScript/v5.4.5/src/lib/dom.generated.d.ts",
    cacheName: "dom.generated.v5.4.5.d.ts",
  },
};

async function fetchOnce(file: RemoteFile): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, file.cacheName);
  if (existsSync(cachePath)) return readFileSync(cachePath, "utf8");

  process.stderr.write(`fetching ${file.url}...\n`);
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`fetch failed ${res.status}: ${file.url}`);
  const body = await res.text();
  writeFileSync(cachePath, body);
  return body;
}

// Walk a directory tree synchronously and return all files matching the
// extension list, sorted for stability.
function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry === "target" || entry === "dist" || entry === "pkg-node" || entry === "pkg-bundler" || entry === "cache") continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

export interface RealFixture {
  name: string;
  a: string;
  b: string;
  description: string;
}

// "Rename one common identifier" edit — replaces every occurrence of `from`
// with `to` in the input. This is the cheapest single-token diff a user
// might paste: many small chunks scattered through a real file.
function renameAll(text: string, from: string, to: string): string {
  // Word boundary — only match the bare identifier, not substrings.
  const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "g");
  return text.replace(re, to);
}

// Splice an inserted block at roughly 1/3 of the way through the file,
// at a line boundary. Mirrors the "user added a new function/section"
// case — one big chunk, otherwise unchanged.
function spliceBlock(text: string, blockLines: string[]): string {
  const lines = text.split("\n");
  const at = Math.floor(lines.length / 3);
  return [...lines.slice(0, at), ...blockLines, ...lines.slice(at)].join("\n");
}

export async function loadRealFixtures(): Promise<RealFixture[]> {
  const fixtures: RealFixture[] = [];

  // 1. Project's own TypeScript — small but real. Concatenate all src/**/*.ts.
  const srcFiles = walk(path.join(REPO_ROOT, "src"), [".ts"]);
  const projectSrc = srcFiles
    .map((p) => `// === ${path.relative(REPO_ROOT, p)} ===\n${readFileSync(p, "utf8")}`)
    .join("\n\n");

  fixtures.push({
    name: "small-real/project-rename",
    description: "differ's own src/ concatenated; rename 'EditorView' → 'EditorPane' across",
    a: projectSrc,
    b: renameAll(projectSrc, "EditorView", "EditorPane"),
  });

  // 2. Real version-to-version evolution: TS 5.0 → 5.4 dom.generated.d.ts.
  const [dom50, dom54] = await Promise.all([fetchOnce(FILES.domV50), fetchOnce(FILES.domV54)]);

  fixtures.push({
    name: "huge-real/ts-dom-evolution",
    description: "TypeScript lib.dom v5.0.4 vs v5.4.5 (real evolution, ~33k lines)",
    a: dom50,
    b: dom54,
  });

  // 3. Same big file, with a one-identifier rename — many sparse chunks.
  fixtures.push({
    name: "huge-real/dom-rename",
    description: "TS lib.dom v5.4.5; rename 'Element' → 'Elem' (sparse chunks across ~30k lines)",
    a: dom54,
    b: renameAll(dom54, "Element", "Elem"),
  });

  // 4. Same big file with a new block inserted — single big chunk.
  fixtures.push({
    name: "huge-real/dom-insert-block",
    description: "TS lib.dom v5.4.5 with a 60-line block spliced in at 1/3",
    a: dom54,
    b: spliceBlock(
      dom54,
      Array.from(
        { length: 60 },
        (_, i) => `interface __BenchAdded${i} { readonly id_${i}: number; }`,
      ),
    ),
  });

  // 5–7. Tiled stress fixtures. We tile the 1.3 MB dom file to hit the
  // sizes Differ would face when a power user pastes a real giant input
  // — production SQL dumps, prod log files, full API response captures.
  // 200 MB sits near V8's per-string ceiling so the largest tier doubles
  // as a "does the tab survive" test as much as a perf test.
  const target20 = 20 * 1024 * 1024;
  const target70 = 70 * 1024 * 1024;
  const target200 = 200 * 1024 * 1024;

  for (const [label, size] of [
    ["20mb", target20],
    ["70mb", target70],
    ["200mb", target200],
  ] as const) {
    const tiled = tile(dom54, size);
    fixtures.push({
      name: `stress-${label}/rename`,
      description: `${label}: lib.dom tiled to ~${(tiled.length / 1024 / 1024).toFixed(1)} MB; rename 'Element' → 'Elem' across`,
      a: tiled,
      b: renameAll(tiled, "Element", "Elem"),
    });
    fixtures.push({
      name: `stress-${label}/insert-block`,
      description: `${label}: lib.dom tiled to ~${(tiled.length / 1024 / 1024).toFixed(1)} MB with a 60-line block spliced in`,
      a: tiled,
      b: spliceBlock(
        tiled,
        Array.from(
          { length: 60 },
          (_, i) => `interface __BenchAdded${i} { readonly id_${i}: number; }`,
        ),
      ),
    });
  }

  return fixtures;
}

// Concatenate `text` to itself enough times to land near `targetBytes`.
// Inserts a unique marker between tiles so the tiled output isn't perfectly
// periodic (otherwise diff algorithms have a much easier time than they
// would on real content).
function tile(text: string, targetBytes: number): string {
  const chunks: string[] = [];
  let total = 0;
  let i = 0;
  while (total < targetBytes) {
    const sep = `\n\n// === bench tile ${i++} ===\n\n`;
    chunks.push(sep, text);
    total += sep.length + text.length;
  }
  return chunks.join("");
}
