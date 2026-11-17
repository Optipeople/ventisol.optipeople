import { defineConfig, devices } from "@playwright/test";

// End to end tests against a fixture server: VENTISOL_FIXTURES=1 serves sample
// data and logs in as the fixture admin. Fixture mode only runs under
// `next dev` (lib/fixtures-flag.ts refuses NODE_ENV=production), so the
// server is a dev server with its own build folder, beside any dev server the
// developer already has on port 3000.
const port = Number(process.env.E2E_PORT ?? 3210);
// localhost, not 127.0.0.1: `next dev` blocks its dev resources (HMR,
// chunks) for other origins, and the pages would not hydrate.
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // One fixture database and one dev server that compiles pages on first
  // visit: running tests one at a time keeps that predictable.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Dev mode compiles each route on its first request.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL,
    locale: "da-DK",
    timezoneId: "Europe/Copenhagen",
    navigationTimeout: 90_000,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next dev --port ${port}`,
    // A route handler that answers 307 without touching the database.
    url: `${baseURL}/periode`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      VENTISOL_FIXTURES: "1",
      VENTISOL_DIST_DIR: ".next-e2e",
      NEXT_TELEMETRY_DISABLED: "1",
      // The chat page must show "AI er ikke konfigureret".
      ANTHROPIC_API_KEY: "",
    },
  },
});
