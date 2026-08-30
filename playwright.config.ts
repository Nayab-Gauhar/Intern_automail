import { defineConfig, devices } from '@playwright/test'

/**
 * E2E configuration.
 *
 * CI already invokes `bun run test:e2e`, so this file has to exist for that step
 * to mean anything. The suite drives the real app against a real database with
 * EMAIL_PROVIDER_MODE=fake, so the full send/reply loop runs without touching
 * Gmail — that seam is a design requirement on the provider abstraction, not a
 * testing convenience.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100)
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './tests/e2e',
  // Give the whole run a ceiling so a hung test cannot occupy CI indefinitely.
  timeout: 30_000,
  expect: { timeout: 5_000 },

  // A test that only passes when run alone is a test that will lie later.
  fullyParallel: true,
  // Fail the build rather than silently skipping a committed .only.
  forbidOnly: !!process.env.CI,
  // One retry in CI absorbs genuine flake from cold starts; locally, a failure
  // should stay failed so it gets fixed.
  retries: process.env.CI ? 1 : 0,
  // Spread rather than pass `undefined`: exactOptionalPropertyTypes rejects an
  // explicit undefined on an optional property, and omitting the key is what
  // "let Playwright decide" has to look like.
  ...(process.env.CI ? { workers: 2 } : {}),

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['list']]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    // Artefacts only for failures — a green run should not produce a GB of video.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Explicit so a locale- or zone-dependent assertion cannot pass on one
    // machine and fail on another. The product is timezone-sensitive.
    locale: 'en-US',
    timezoneId: 'UTC',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Build once, then serve. `next dev` would make every assertion race the
  // compiler on first hit.
  webServer: {
    command: `bunx next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'production',
      EMAIL_PROVIDER_MODE: 'fake',
    },
  },
})
