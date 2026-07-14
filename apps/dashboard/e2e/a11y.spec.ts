import { expect, test } from '@playwright/test';
import { expectNoCriticalA11yIssues, signIn } from './helpers';

/**
 * FE-131 — WCAG 2.2 AA on the core flows (AC: axe-core on sign-in, dashboard,
 * kill-switch ⇒ no critical issues; keyboard nav with visible focus rings).
 */

test.describe('sign-in (public)', () => {
  test('axe: no critical violations', async ({ page }) => {
    await page.goto('/sign-in');
    await expectNoCriticalA11yIssues(page);
  });

  test('keyboard: form is fully reachable with visible focus', async ({ page }) => {
    await page.goto('/sign-in');
    await page.keyboard.press('Tab');
    // Walk the tab order until the email field takes focus (max 10 stops).
    for (let i = 0; i < 10; i++) {
      const isEmail = await page.evaluate(
        () => document.activeElement?.getAttribute('type') === 'email',
      );
      if (isEmail) break;
      await page.keyboard.press('Tab');
    }
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return '';
      const style = getComputedStyle(el);
      return style.outlineStyle !== 'none' || style.boxShadow !== 'none' ? 'visible' : 'none';
    });
    expect(outline).toBe('visible');
  });
});

test.describe('dashboard (authenticated)', () => {
  test('axe: no critical violations on the operator home', async ({ page }) => {
    await signIn(page);
    await expectNoCriticalA11yIssues(page);
  });

  test('skip link is the first tabbable element and targets main content', async ({ page }) => {
    await signIn(page);
    await page.keyboard.press('Tab');
    const href = await page.evaluate(() => document.activeElement?.getAttribute('href'));
    expect(href).toBe('#main-content');
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeVisible();
  });

  test('axe: kill-switch confirm dialog has no critical violations', async ({ page }) => {
    await signIn(page);
    await page
      .getByRole('button', { name: /kill switch/i })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoCriticalA11yIssues(page);
    // Close WITHOUT confirming — never halt trading from a test.
    await page.keyboard.press('Escape');
  });
});
