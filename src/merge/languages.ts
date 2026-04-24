import { languages as cmLanguages } from "@codemirror/language-data";
import type { LanguageDescription, LanguageSupport } from "@codemirror/language";
import type { LanguageId } from "../state";

const byName = new Map<string, LanguageDescription>();
for (const lang of cmLanguages) {
  byName.set(lang.name.toLowerCase(), lang);
  for (const alias of lang.alias) byName.set(alias.toLowerCase(), lang);
}

// Curated list tracking VSCode's built-in languages + a few of its most
// commonly-installed extensions (Vue, Svelte, Kotlin, Scala, Terraform, ...).
// Keeps the picker digestible — CodeMirror's language-data ships a lot of
// esoteric grammars (Brainfuck, Forth, Yacas, APL, ...) we don't want here.
const VSCODE_WHITELIST = new Set([
  "c",
  "c++",
  "c#",
  "clojure",
  "coffeescript",
  "css",
  "dart",
  "dockerfile",
  "elixir",
  "elm",
  "erlang",
  "f#",
  "go",
  "groovy",
  "haskell",
  "haxe",
  "html",
  "java",
  "javascript",
  "jsx",
  "json",
  "julia",
  "kotlin",
  "latex",
  "less",
  "livescript",
  "lua",
  "markdown",
  "mariadb sql",
  "mssql",
  "mysql",
  "nginx",
  "nim",
  "objective-c",
  "ocaml",
  "pascal",
  "perl",
  "php",
  "plsql",
  "postgresql",
  "powershell",
  "pug",
  "python",
  "r",
  "ruby",
  "rust",
  "sass",
  "scala",
  "scheme",
  "scss",
  "shell",
  "solidity",
  "sql",
  "sqlite",
  "stylus",
  "svelte",
  "swift",
  "tex",
  "bibtex",
  "toml",
  "typescript",
  "tsx",
  "vb.net",
  "vbscript",
  "vue",
  "webassembly",
  "xml",
  "yaml",
]);

export interface LanguageEntry {
  id: string;
  label: string;
  extensions: readonly string[];
}

// Custom entries for file types that don't have a CodeMirror grammar of their
// own but are worth surfacing in the picker (they'll fall back to plaintext
// highlighting).
const CUSTOM_ENTRIES: LanguageEntry[] = [
  { id: ".env", label: "Env", extensions: ["env"] },
];

export function availableLanguages(): LanguageEntry[] {
  const fromCm = cmLanguages
    .filter((l) => VSCODE_WHITELIST.has(l.name.toLowerCase()))
    .map((l) => ({
      id: l.name.toLowerCase(),
      label: l.name,
      extensions: l.extensions,
    }));
  return [...fromCm, ...CUSTOM_ENTRIES].sort((a, b) =>
    a.label.localeCompare(b.label),
  );
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
