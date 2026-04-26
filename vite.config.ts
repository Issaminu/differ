import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// Tauri expects a fixed port and no auto-open.
const host = process.env.TAURI_DEV_HOST;
const target = process.env.VITE_TARGET ?? "tauri";

export default defineConfig({
  // wasm-pack's --target bundler output uses `import * as wasm from
  // "./pkg/foo_bg.wasm"` and a top-level await in the init shim. The two
  // plugins below teach Vite/Rollup to consume that without per-import
  // ceremony at the call site.
  plugins: [wasm(), topLevelAwait()],
  clearScreen: false,
  define: {
    "import.meta.env.VITE_TARGET": JSON.stringify(target),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "safari15",
    minify: "oxc",
    sourcemap: false,
  },
});
