import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * FE-130 — mobile-first safety controls (Pixel-7 viewport project).
 * AC: kill-switch one tap away from ANY page via the sticky footer; the
 * positions list fits without horizontal scroll.
 */

test('kill-switch is reachable in one tap from any page (sticky footer)', async ({ page }) => {
  await signIn(page);
  for (const path of ['/dashboard', '/trades', '/agents']) {
    await page.goto(path);
    const killSwitch = page.getByRole('button', { name: /kill switch/i });
    await expect(killSwitch).toBeVisible();
    // Inside the fixed footer ⇒ within the viewport without scrolling.
    const box = await killSwitch.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    if (box && viewport) expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  }
});

test('trades page has no horizontal scroll on mobile (FE-130 AC)', async ({ page }) => {
  await signIn(page);
  await page.goto('/trades');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('realtime toasts region is announced politely (FE-120 + a11y)', async ({ page }) => {
  await signIn(page);
  // Sonner mounts an aria-live region for toasts.
  await expect(page.locator('[aria-live]').first()).toBeAttached();
});
