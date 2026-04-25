import type { HistoryEntry } from "../state";

export interface HistoryFile {
  version: number;
  entries: HistoryEntry[];
}

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 200;
const DB_NAME = "differ";
const STORE = "history";
const KEY = "file";

const MERGE_CUTOFF_MS = 10 * 60 * 1000;
const LENGTH_DELTA_APPEND = 512;
const EDGE_WINDOW = 256;

function emptyFile(): HistoryFile {
  return { version: SCHEMA_VERSION, entries: [] };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readFile(): Promise<HistoryFile> {
  const db = await openDb();
  return new Promise<HistoryFile>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => {
      const value = req.result as HistoryFile | undefined;
      resolve(value && Array.isArray(value.entries) ? value : emptyFile());
    };
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

async function writeFile(file: HistoryFile): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(file, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }).finally(() => db.close());
}

function shouldSkip(original: string, modified: string): boolean {
  if (original === "" && modified === "") return true;
  if (original === modified) return true;
  if (original.length < 2 && modified.length < 2) return true;
  return false;
}

function makePreview(original: string, modified: string): string {
  const source = modified !== "" ? modified : original;
  const firstLine = source.split("\n", 1)[0] ?? "";
  const trimmed = firstLine.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= 80) return trimmed;
  return chars.slice(0, 80).join("") + "…";
}

type Decision = "append" | "updateLast";

function decide(
  last: HistoryEntry | undefined,
  original: string,
  modified: string,
  now: number,
): Decision {
  if (!last) return "append";

  const lastUpdated = Date.parse(last.updatedAt);
  if (Number.isFinite(lastUpdated) && now - lastUpdated > MERGE_CUTOFF_MS) {
    return "append";
  }

  const deltaO = Math.abs(last.original.length - original.length);
  const deltaM = Math.abs(last.modified.length - modified.length);
  if (deltaO > LENGTH_DELTA_APPEND || deltaM > LENGTH_DELTA_APPEND) {
    return "append";
  }

  if (
    !edgesMatch(last.original, original, EDGE_WINDOW) ||
    !edgesMatch(last.modified, modified, EDGE_WINDOW)
  ) {
    return "append";
  }

  return "updateLast";
}

function edgesMatch(a: string, b: string, window: number): boolean {
  if (a.length <= window && b.length <= window) return true;
  return (
    a.slice(0, window) === b.slice(0, window) ||
    a.slice(-window) === b.slice(-window)
  );
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function loadHistory(): Promise<HistoryFile> {
  try {
    return await readFile();
  } catch {
    return emptyFile();
  }
}

export async function captureHistory(
  original: string,
  modified: string,
  language: string,
  force = false,
): Promise<HistoryFile> {
  if (shouldSkip(original, modified)) {
    return await loadHistory();
  }

  const file = await loadHistory();
  const last = file.entries[file.entries.length - 1];
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const preview = makePreview(original, modified);
  const decision: Decision = force ? "append" : decide(last, original, modified, now);

  if (decision === "updateLast" && last) {
    last.original = original;
    last.modified = modified;
    last.updatedAt = nowIso;
    last.preview = preview;
    last.language = language;
  } else {
    file.entries.push({
      id: newId(),
      createdAt: nowIso,
      updatedAt: nowIso,
      original,
      modified,
      preview,
      language,
    });
    if (file.entries.length > MAX_ENTRIES) {
      file.entries.splice(0, file.entries.length - MAX_ENTRIES);
    }
  }

  await writeFile(file);
  return file;
}

export async function deleteHistory(id: string): Promise<HistoryFile> {
  const file = await loadHistory();
  file.entries = file.entries.filter((e) => e.id !== id);
  await writeFile(file);
  return file;
}

export async function clearHistory(): Promise<HistoryFile> {
  const file = emptyFile();
  await writeFile(file);
  return file;
}
