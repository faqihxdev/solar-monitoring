import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const DEFAULT_API_PORT = 43871;
const DEFAULT_UI_PORT = 43872;

function readPort(name: string, fallback: number): number {
  const raw = process.env[name] ?? String(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`${name} must be an integer in [1024, 65535], got "${raw}"`);
  }
  return parsed;
}

const apiPort = readPort("DESS_DASHBOARD_PORT", DEFAULT_API_PORT);
const uiPort = readPort("DESS_UI_PORT", DEFAULT_UI_PORT);

// Dev UI runs at http://localhost:${uiPort} and proxies /api to the API backend.
// Production builds stay local to the UI package; the backend is API-only.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
  },
  server: {
    port: uiPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
