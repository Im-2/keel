import { defineConfig } from "@playwright/test"

/**
 * End-to-end link checks for the public site (landing page and docs). Runs against production by default:
 *   pnpm --filter @keel/miniapp e2e                         (https://keel-miniapp.vercel.app)
 *   E2E_URL=http://localhost:4174 pnpm --filter @keel/miniapp e2e
 * Uses the locally installed Chrome (no browser download).
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "e2e-results/results.json" }]],
  use: {
    baseURL: process.env.E2E_URL ?? "https://keel-miniapp.vercel.app",
    channel: "chrome",
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  projects: [
    { name: "mobile-375", use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: "desktop-1440", use: { viewport: { width: 1440, height: 900 } } },
  ],
})
