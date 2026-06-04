import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev UI runs at http://localhost:5173 and proxies /api to the API backend.
// Production builds stay local to the UI package; the backend is API-only.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
});
