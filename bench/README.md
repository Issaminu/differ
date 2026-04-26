# Bench

Pure-logic benchmarks for the diff editor's hot paths. Measures the same
packed imara-diff + decoration functions production runs (no DOM, no
CodeMirror view layer) so we can iterate on diff/decoration cost without
spinning up a webview.

## Run

```sh
bun run bench                      # full suite, prints a table per task
bun run bench -- --filter combined # only tasks whose name matches
```

## Flame graphs

```sh
bun run bench:flame                       # all scenarios → bench/profiles/*.cpuprofile
bun run bench:flame -- --filter large combined
```

Each `.cpuprofile` is a Chrome-DevTools-format CPU profile captured *only*
during the hot loop (no warmup, no fixture build, no Bench overhead).

View at <https://www.speedscope.app> — drop the file in. The "Left Heavy"
view is usually the right starting point: it stacks all calls of the same
function, so the top of each bar is the hot leaf.

You can also drop the file into Chrome DevTools → Performance → Load
profile…

For a quick text-only top-N, skip the GUI:

```sh
bun run bench:analyze bench/profiles/combined-production__medium_line-edits-50pct.cpuprofile
```

## What we measure

| Function | Where it runs in production |
|---|---|
| `legacy Chunk.build` | Old `@codemirror/merge` baseline, kept only for comparison |
| `DiffSession set+compute+buffers` | Paste / swap / clear / restore — push both strings into WASM, full diff, copy packed buffers |
| `DiffSession setB+compute+buffers` | Per-keystroke recompute when only the right pane changed |
| `buildDecorations full` | Diagnostic: materialise all line/char decorations |
| `buildDecorations viewport` | Production decoration overlay: chunks → visible DecorationSet |
| `buildGutterRangeSet full` | Production gutter line markers |
| `per-keystroke production combined` | Right-pane edit: set B, full imara recompute, stats, viewport decorations, gutters |
| `detectLanguage` | Debounced 500ms after typing stops |

## Fixture matrix

`bench/fixtures.ts` generates deterministic synthetic file pairs. Three
sizes (200 / 2000 / 10000 lines) crossed with four diff shapes:

- `line-edits` — rewrite every Nth line. Worst case for chunk count.
- `char-edits` — modify chars within every Nth line. Worst case for
  inner `chunk.changes` (the character-level highlight).
- `block-insert` — insert a contiguous block in B. Best case — one chunk.
- `disjoint` — totally different content. Stresses the diff core.

The seed is fixed, so numbers are comparable across runs.
