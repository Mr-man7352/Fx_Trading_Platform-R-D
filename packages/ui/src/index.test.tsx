import { TradingModeSchema } from '@fx/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AGENT_VOTE_STYLES,
  AgentVoteCard,
  AppShell,
  Button,
  cn,
  DISCLAIMER_TEXT,
  DisclaimerBanner,
  formatSigned,
  KillSwitchButton,
  MODE_BADGE_STYLES,
  ModeBadge,
  PnLTile,
  pnlDirection,
} from './index';

// SSR markup smoke tests — no jsdom needed; interaction tests (dialog open,
// 2FA validation) belong to Playwright/e2e when the dashboard shell lands (FE-040).

describe('cn (FE-010)', () => {
  it('merges conflicting tailwind classes, last wins', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-loss', undefined, 'font-bold')).toBe('text-loss font-bold');
  });
});

describe('Button (FE-010)', () => {
  it('renders a button with variant classes', () => {
    const html = renderToStaticMarkup(<Button variant="destructive">Halt</Button>);
    expect(html).toContain('<button');
    expect(html).toContain('bg-destructive');
    expect(html).toContain('Halt');
  });

  it('asChild renders the child element instead of a button', () => {
    const html = renderToStaticMarkup(
      <Button asChild>
        <a href="/dashboard">Go</a>
      </Button>,
    );
    expect(html).toContain('<a href="/dashboard"');
    expect(html).not.toContain('<button');
  });
});

describe('ModeBadge (FE-011)', () => {
  it('covers every TradingMode with a distinct colour token', () => {
    for (const mode of TradingModeSchema.options) {
      expect(MODE_BADGE_STYLES[mode]).toBeDefined();
      expect(MODE_BADGE_STYLES[mode].className).toContain(`mode-${mode}`);
    }
  });

  it('renders the mode label and data attribute', () => {
    const html = renderToStaticMarkup(<ModeBadge mode="live" />);
    expect(html).toContain('LIVE');
    expect(html).toContain('data-mode="live"');
  });
});

describe('PnLTile (FE-011)', () => {
  it('formatSigned is sign-aware with thousands separators', () => {
    expect(formatSigned(1234.5)).toBe('+1,234.50');
    expect(formatSigned(-87.3)).toBe('−87.30');
    expect(formatSigned(0)).toBe('0.00');
  });

  it('pnlDirection maps sign to semantic direction', () => {
    expect(pnlDirection(0.01)).toBe('profit');
    expect(pnlDirection(-0.01)).toBe('loss');
    expect(pnlDirection(0)).toBe('flat');
  });

  it('colours by direction and shows the stale indicator', () => {
    const loss = renderToStaticMarkup(<PnLTile label="Realized" value={-87.3} />);
    expect(loss).toContain('text-loss');
    expect(loss).toContain('data-direction="loss"');

    const stale = renderToStaticMarkup(<PnLTile label="Equity" value={1} stale />);
    expect(stale).toContain('STALE');
  });
});

describe('AgentVoteCard (FE-011)', () => {
  it('renders vote, clamped confidence and model id', () => {
    const html = renderToStaticMarkup(
      <AgentVoteCard agentName="Risk PM" vote="veto" confidence={1.7} modelId="m@2026-06-01" />,
    );
    expect(html).toContain('veto');
    expect(html).toContain('100%'); // clamped from 1.7
    expect(html).toContain('m@2026-06-01');
    expect(AGENT_VOTE_STYLES.buy).toContain('profit');
    expect(AGENT_VOTE_STYLES.sell).toContain('loss');
  });
});

describe('KillSwitchButton (FE-011)', () => {
  it('SSRs as a labelled destructive trigger with the dialog closed', () => {
    const html = renderToStaticMarkup(<KillSwitchButton onConfirm={() => {}} />);
    expect(html).toContain('Kill switch — halt all trading');
    expect(html).toContain('bg-destructive');
    expect(html).toContain('KILL SWITCH');
    expect(html).not.toContain('Halt all trading?'); // dialog content not mounted while closed
  });

  it('compact variant is icon-only', () => {
    const html = renderToStaticMarkup(<KillSwitchButton compact onConfirm={() => {}} />);
    expect(html).not.toContain('KILL SWITCH');
    expect(html).toContain('aria-label="Kill switch — halt all trading"');
  });
});

describe('DisclaimerBanner (FE-110)', () => {
  it('states not-financial-advice and CFD risk', () => {
    const html = renderToStaticMarkup(<DisclaimerBanner />);
    expect(DISCLAIMER_TEXT).toMatch(/not financial advice/i);
    expect(DISCLAIMER_TEXT).toMatch(/CFD/);
    expect(html).toContain('role="alert"');
  });
});

describe('AppShell (FE-011)', () => {
  it('renders header, banner, sidebar, content and mobile footer slots', () => {
    const html = renderToStaticMarkup(
      <AppShell
        brand={<span>FX</span>}
        headerRight={<span>right</span>}
        banner={<div>banner</div>}
        sidebar={<a href="/dashboard">Nav</a>}
        mobileFooter={<button type="button">kill</button>}
      >
        <p>content</p>
      </AppShell>,
    );
    for (const chunk of ['FX', 'right', 'banner', 'Nav', 'content', 'kill', '<main', '<footer']) {
      expect(html).toContain(chunk);
    }
    expect(html).toContain('md:hidden'); // mobile-only footer (FE-130 seam)
  });
});
