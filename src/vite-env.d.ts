/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TARGET: "tauri" | "web";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
