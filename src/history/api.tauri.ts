import { invoke } from "@tauri-apps/api/core";
import type { HistoryEntry } from "../state";

export interface HistoryFile {
  version: number;
  entries: HistoryEntry[];
}

export async function loadHistory(): Promise<HistoryFile> {
  return await invoke<HistoryFile>("history_load");
}

export async function captureHistory(
  original: string,
  modified: string,
  language: string,
  force = false,
): Promise<HistoryFile> {
  return await invoke<HistoryFile>("history_capture", {
    original,
    modified,
    language,
    force,
  });
}

export async function deleteHistory(id: string): Promise<HistoryFile> {
  return await invoke<HistoryFile>("history_delete", { id });
}

export async function clearHistory(): Promise<HistoryFile> {
  return await invoke<HistoryFile>("history_clear");
}
