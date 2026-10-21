import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// A phone running `tauri android dev` or `tauri ios dev` reaches the dev server over the
// network: the Tauri CLI names the address in TAURI_DEV_HOST. Otherwise it stays on this machine.
// @ts-expect-error process is a Node.js global, and the app's types leave Node out.
const host: string | undefined = process.env.TAURI_DEV_HOST;
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // Rust writes there (build output, generated schemas), never the window's code.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: "es2022" },
});
