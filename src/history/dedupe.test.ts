// Parity test for the web history dedupe decision.
//
// The same fixtures power src-tauri/src/dedupe.rs#tests::parity_fixtures —
// any divergence between the two impls fails one of the two suites in CI.
//
//   bun test src/history/dedupe.test.ts

import { describe, expect, test } from "bun:test";

import fixturesData from "../../tests/dedupe-fixtures.json";
import { decide, type Decision } from "./api.web";
import type { HistoryEntry } from "../state";

interface RawFixture {
  name: string;
  last: { original: string; modified: string; ago_min: number } | null;
  next: { original: string; modified: string };
  expected: Decision;
}

const FIXED_NOW = Date.parse("2026-04-26T12:00:00.000Z");

function buildLast(
  raw: RawFixture["last"],
): HistoryEntry | undefined {
  if (!raw) return undefined;
  const updatedAt = new Date(FIXED_NOW - raw.ago_min * 60 * 1000).toISOString();
  return {
    id: "test",
    createdAt: updatedAt,
    updatedAt,
    original: raw.original,
    modified: raw.modified,
    preview: "",
    language: "plaintext",
  };
}

describe("dedupe parity", () => {
  const fixtures = (fixturesData as { fixtures: RawFixture[] }).fixtures;

  for (const fx of fixtures) {
    test(fx.name, () => {
      const last = buildLast(fx.last);
      const got = decide(last, fx.next.original, fx.next.modified, FIXED_NOW);
      expect(got).toBe(fx.expected);
    });
  }
});
