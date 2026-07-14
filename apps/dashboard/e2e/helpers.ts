import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/** FE-131 AC — "no critical issues" from axe-core on the audited flows. */
export async function expectNoCriticalA11yIssues(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  const critical = results.violations.filter((v) => v.impact === 'critical');
  expect(
    critical,
    critical.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`).join('\n'),
  ).toEqual([]);
}

export const E2E_EMAIL = process.env.E2E_EMAIL;
export const E2E_PASSWORD = process.env.E2E_PASSWORD;

/** Sign in through the real credentials form; skips the spec without creds. */
export async function signIn(page: Page): Promise<void> {
  test.skip(!E2E_EMAIL || !E2E_PASSWORD, 'E2E_EMAIL / E2E_PASSWORD not set');
  await page.goto('/sign-in');
  await page.getByLabel(/email/i).fill(E2E_EMAIL as string);
  await page.getByLabel(/password/i).fill(E2E_PASSWORD as string);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/dashboard', { timeout: 15_000 });
}
