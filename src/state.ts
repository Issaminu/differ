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

export function resetBothDocs(): void {
  originalText.value = "";
  modifiedText.value = "";
}

export function swapSides(): void {
  const a = originalText.value;
  originalText.value = modifiedText.value;
  modifiedText.value = a;
}
