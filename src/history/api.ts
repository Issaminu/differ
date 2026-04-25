import type { HistoryEntry } from "../state";

export interface HistoryFile {
  version: number;
  entries: HistoryEntry[];
}

// Vite replaces `import.meta.env.VITE_TARGET` with a string literal at build
// time, so the unused branch is constant-folded and tree-shaken.
const impl =
  import.meta.env.VITE_TARGET === "web"
    ? await import("./api.web")
    : await import("./api.tauri");

export const loadHistory: () => Promise<HistoryFile> = impl.loadHistory;
export const captureHistory: (
  original: string,
  modified: string,
  language: string,
  force?: boolean,
) => Promise<HistoryFile> = impl.captureHistory;
export const deleteHistory: (id: string) => Promise<HistoryFile> = impl.deleteHistory;
export const clearHistory: () => Promise<HistoryFile> = impl.clearHistory;
