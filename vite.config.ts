import { defineConfig } from "vite";

// Tauri expects a fixed port and no auto-open.
const host = process.env.TAURI_DEV_HOST;
const target = process.env.VITE_TARGET ?? "tauri";

export default defineConfig({
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
    minify: "esbuild",
    sourcemap: false,
  },
});
