import { defineConfig, devices } from '@playwright/test';

/**
 * FE-131 / Step-5.4 DoD — Playwright E2E + axe a11y audits.
 *
 * Runs against an ALREADY-RUNNING stack (`pnpm dev` or compose):
 *   E2E_BASE_URL   (default http://localhost:3000)
 *   E2E_EMAIL / E2E_PASSWORD — a seeded operator account; the authenticated
 *   specs (dashboard, kill-switch dialog) are SKIPPED when unset, so the
 *   public sign-in audit always runs.
 *
 * One-time setup: `pnpm --filter @fx/dashboard e2e:install` (Chromium).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false, // auth flows share a session; keep ordering simple
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile-chromium', // FE-130 — kill-switch reachable on a phone
      use: { ...devices['Pixel 7'] },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
});
