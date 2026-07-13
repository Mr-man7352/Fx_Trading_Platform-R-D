import { describe, expect, it } from 'vitest';
import { isStepUpFresh } from './guards.js';

const TTL = 15 * 60 * 1000;
const NOW = new Date('2026-07-12T12:00:00Z');

describe('BE-036 guards — step-up freshness', () => {
  it('is false when never stepped up', () => {
    expect(isStepUpFresh(null, TTL, NOW)).toBe(false);
  });

  it('is true within the window and false once stale', () => {
    const fresh = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const stale = new Date(NOW.getTime() - 16 * 60_000).toISOString();
    expect(isStepUpFresh(fresh, TTL, NOW)).toBe(true);
    expect(isStepUpFresh(stale, TTL, NOW)).toBe(false);
  });

  it('rejects an unparseable timestamp', () => {
    expect(isStepUpFresh('not-a-date', TTL, NOW)).toBe(false);
  });
});
