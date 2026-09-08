import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:43885",
    viewport: { width: 1440, height: 1000 },
    headless: true,
    screenshot: "only-on-failure",
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: [
    {
      command: "pnpm exec tsx e2e/fixture-server.ts",
      url: "http://127.0.0.1:43884/api/summary",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm exec vite --host 127.0.0.1 --port 43885 --strictPort",
      url: "http://127.0.0.1:43885",
      env: { DESS_DEV_API_TARGET: "http://127.0.0.1:43884" },
      reuseExistingServer: false,
    },
  ],
});
