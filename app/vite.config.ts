import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const DEFAULT_API_PORT = 43871;
const DEFAULT_UI_PORT = 43872;
type EnvVars = Record<string, string | undefined>;
const appRoot = path.dirname(fileURLToPath(import.meta.url));
const envRoot = path.resolve(appRoot, "..");

function readPort(env: EnvVars, name: string, fallback: number): number {
  const raw = env[name] ?? String(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`${name} must be an integer in [1024, 65535], got "${raw}"`);
  }
  return parsed;
}

function readApiTarget(env: EnvVars, defaultPort: number): string {
  const explicit = (env.DESS_DEV_API_TARGET ?? "").trim();
  if (!explicit) return `http://127.0.0.1:${defaultPort}`;

  const parsed = new URL(explicit);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `DESS_DEV_API_TARGET must use http/https protocol, got "${parsed.protocol}" in "${explicit}"`,
    );
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      `DESS_DEV_API_TARGET must be an origin only (no path/query/hash), got "${explicit}"`,
    );
  }
  return parsed.origin;
}

// Dev UI runs at http://localhost:${uiPort} and proxies /api to the API backend.
// Production builds stay local to the UI package; the backend is API-only.
export default defineConfig(({ mode }) => {
  const env: EnvVars = { ...loadEnv(mode, envRoot, ""), ...process.env };
  const apiPort = readPort(env, "DESS_DASHBOARD_PORT", DEFAULT_API_PORT);
  const uiPort = readPort(env, "DESS_UI_PORT", DEFAULT_UI_PORT);
  const apiTarget = readApiTarget(env, apiPort);

  return {
    plugins: [react(), tailwindcss()],
    base: "/",
    envDir: envRoot,
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
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
