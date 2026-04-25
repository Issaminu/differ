import { signal, computed } from "@preact/signals-core";

export const originalText = signal<string>("");
export const modifiedText = signal<string>("");

export type LanguageId = string;
export const detectedLanguage = signal<LanguageId>("plaintext");
export const manualLanguage = signal<LanguageId | null>(null);
export const activeLanguage = computed<LanguageId>(
  () => manualLanguage.value ?? detectedLanguage.value,
);

export type ThemeMode = "light" | "dark";
export type ThemePreference = "system" | "light" | "dark";

const THEME_PREF_KEY = "differ.themePreference";
const storedPref = (() => {
  const raw = localStorage.getItem(THEME_PREF_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
})();

export const themePreference = signal<ThemePreference>(storedPref);
export const themeMode = signal<ThemeMode>(
  storedPref === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : storedPref,
);

export function setThemePreference(pref: ThemePreference): void {
  themePreference.value = pref;
  localStorage.setItem(THEME_PREF_KEY, pref);
}

export const historyOpen = signal<boolean>(false);

const SCROLL_LOCK_KEY = "differ.scrollLocked";
const storedScrollLocked = localStorage.getItem(SCROLL_LOCK_KEY) !== "false";
export const scrollLocked = signal<boolean>(storedScrollLocked);
export function setScrollLocked(v: boolean): void {
  scrollLocked.value = v;
  localStorage.setItem(SCROLL_LOCK_KEY, String(v));
}

export interface HistoryEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  original: string;
  modified: string;
  preview: string;
  language: LanguageId;
}

export const historyEntries = signal<HistoryEntry[]>([]);

export const diffStats = signal<{ added: number; removed: number }>({
  added: 0,
  removed: 0,
});

// Browser-style unified back/forward across both panes. Drives the toolbar
// buttons' enabled state; populated by the snapshot history in mergeView.
export const canEditBack = signal(false);
export const canEditForward = signal(false);

export function resetBothDocs(): void {
  originalText.value = "";
  modifiedText.value = "";
}

export function swapSides(): void {
  const a = originalText.value;
  originalText.value = modifiedText.value;
  modifiedText.value = a;
}
