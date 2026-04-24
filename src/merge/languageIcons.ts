// Brand SVG icons for languages, sourced from simple-icons (CC0).
// Rendered as single-color inline SVGs so they inherit the menu's fg color
// and stay visually consistent with the rest of the UI.

import {
  siApachegroovy,
  siAstro,
  siC,
  siClojure,
  siCmake,
  siCoffeescript,
  siCplusplus,
  siCrystal,
  siCss,
  siD,
  siDart,
  siDocker,
  siDotenv,
  siDotnet,
  siElixir,
  siElm,
  siErlang,
  siFsharp,
  siGnubash,
  siGo,
  siGraphql,
  siHaskell,
  siHaxe,
  siHtml5,
  siJavascript,
  siJinja,
  siJson,
  siJulia,
  siJupyter,
  siKotlin,
  siLatex,
  siLess,
  siLua,
  siMariadb,
  siMarkdown,
  siMysql,
  siNginx,
  siNim,
  siNixos,
  siOcaml,
  siPerl,
  siPhp,
  siPostgresql,
  siPrettier,
  siPrisma,
  siPug,
  siPython,
  siR,
  siReact,
  siRuby,
  siRust,
  siSass,
  siScala,
  siSharp,
  siSolidity,
  siSqlite,
  siStyledcomponents,
  siStylus,
  siSvelte,
  siSwift,
  siTerraform,
  siToml,
  siTypescript,
  siVala,
  siVuedotjs,
  siWebassembly,
  siXml,
  siYaml,
  siZig,
} from "simple-icons";

type Icon = { path: string };

// Map CodeMirror language-data ids (lowercased) to simple-icons modules.
// Anything not in the map falls back to a neutral glyph.
const ICON_MAP: Record<string, Icon> = {
  // JS family
  javascript: siJavascript,
  typescript: siTypescript,
  jsx: siReact,
  tsx: siReact,
  coffeescript: siCoffeescript,
  livescript: siCoffeescript,

  // Systems
  c: siC,
  "c++": siCplusplus,
  cpp: siCplusplus,
  "c#": siSharp,
  csharp: siSharp,
  rust: siRust,
  go: siGo,
  zig: siZig,
  nim: siNim,
  crystal: siCrystal,
  d: siD,
  vala: siVala,

  // JVM — Java has no simple-icons entry (trademark); falls back to generic.
  kotlin: siKotlin,
  scala: siScala,
  clojure: siClojure,
  clojurescript: siClojure,
  groovy: siApachegroovy,

  // Scripting / dynamic
  python: siPython,
  ruby: siRuby,
  php: siPhp,
  perl: siPerl,
  lua: siLua,
  r: siR,
  julia: siJulia,

  // Functional
  haskell: siHaskell,
  ocaml: siOcaml,
  "f#": siFsharp,
  fsharp: siFsharp,
  elm: siElm,
  elixir: siElixir,
  erlang: siErlang,

  // Apple / mobile
  swift: siSwift,
  dart: siDart,
  "objective-c": siSwift,

  // Web
  html: siHtml5,
  css: siCss,
  sass: siSass,
  scss: siSass,
  less: siLess,
  stylus: siStylus,
  vue: siVuedotjs,
  svelte: siSvelte,
  astro: siAstro,
  pug: siPug,
  haxe: siHaxe,
  jinja2: siJinja,
  "styled-components": siStyledcomponents,

  // Data / config
  markdown: siMarkdown,
  json: siJson,
  yaml: siYaml,
  toml: siToml,
  xml: siXml,
  ".env": siDotenv,
  env: siDotenv,
  graphql: siGraphql,
  prisma: siPrisma,

  // Databases
  sql: siMysql,
  mysql: siMysql,
  "mariadb sql": siMariadb,
  mariadb: siMariadb,
  postgresql: siPostgresql,
  plsql: siPostgresql,
  sqlite: siSqlite,

  // Build / infra / shell
  shell: siGnubash,
  bash: siGnubash,
  dockerfile: siDocker,
  docker: siDocker,
  nginx: siNginx,
  cmake: siCmake,
  hcl: siTerraform,
  terraform: siTerraform,
  nix: siNixos,

  // Misc
  solidity: siSolidity,
  webassembly: siWebassembly,
  wasm: siWebassembly,
  "vb.net": siDotnet,
  vbnet: siDotnet,
  latex: siLatex,
  tex: siLatex,
  bibtex: siLatex,
  stex: siLatex,
  jupyter: siJupyter,
  "jupyter notebook": siJupyter,
  prettier: siPrettier,
};

// Fallback: small code/brackets glyph.
const FALLBACK_PATH =
  "M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0L19.2 12l-4.6-4.6L16 6l6 6-6 6-1.4-1.4z";

// "Auto" — globe-ish glyph.
const AUTO_PATH =
  "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.94-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z";

export function languageIcon(id: string): string {
  if (id === "__auto__") {
    return `<svg class="lang-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${AUTO_PATH}"/></svg>`;
  }
  const icon = ICON_MAP[id.toLowerCase()];
  const path = icon?.path ?? FALLBACK_PATH;
  return `<svg class="lang-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;
}
