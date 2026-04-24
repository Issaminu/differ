import { languages as cmLanguages } from "@codemirror/language-data";
import type { LanguageDescription, LanguageSupport } from "@codemirror/language";
import type { LanguageId } from "../state";

const byName = new Map<string, LanguageDescription>();
for (const lang of cmLanguages) {
  byName.set(lang.name.toLowerCase(), lang);
  for (const alias of lang.alias) byName.set(alias.toLowerCase(), lang);
}

export function availableLanguages(): { id: string; label: string }[] {
  return cmLanguages
    .map((l) => ({ id: l.name.toLowerCase(), label: l.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function findLanguage(id: LanguageId): LanguageDescription | null {
  if (!id || id === "plaintext") return null;
  return byName.get(id.toLowerCase()) ?? null;
}

const loaded = new Map<string, LanguageSupport>();

export async function loadLanguage(id: LanguageId): Promise<LanguageSupport | null> {
  const desc = findLanguage(id);
  if (!desc) return null;
  const key = desc.name.toLowerCase();
  const cached = loaded.get(key);
  if (cached) return cached;
  const support = await desc.load();
  loaded.set(key, support);
  return support;
}
