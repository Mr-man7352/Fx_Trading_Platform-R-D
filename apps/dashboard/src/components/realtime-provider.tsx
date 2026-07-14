'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useWs } from '@/lib/use-ws';
import { useConnection } from '@/stores/connection';

/**
 * FE-120 — THE dashboard-wide realtime layer, mounted once in the (dashboard)
 * layout. One WS connection subscribes to every operator channel; frames turn
 * into (a) react-query invalidations and (b) Sonner toasts with actionable
 * links (AC: signal.candidate / trade.fill / risk.halt). Individual pages no
 * longer open their own sockets — they read `useConnection` for status.
 *
 * Channels ← their producers:
 *   signals                  BE-066/067 (cycle events incl. candidates)
 *   trade.fill               BE-050 (fills, partial fills, rejections)
 *   pnl.update               BE-052 (closes with realized P&L)
 *   risk.halt / risk.resume  BE-072/073 kill-switch + reconciler + DD halts
 *   reconciliation.mismatch  BE-052
 *   backtests                BE-090 (backtest:finished / backtest:failed)
 *   notifications            BE-118 (alerting-about-alerting: send failures)
 *   settings                 BE-100 (settings:updated fan-out)
 */
const CHANNELS = [
  'signals',
  'trade.fill',
  'pnl.update',
  'risk.halt',
  'risk.resume',
  'reconciliation.mismatch',
  'backtests',
  'notifications',
  'settings',
];

/** Reconnect banner only after a real drop, and only if it lasts >2s (no flicker). */
const BANNER_DELAY_MS = 2_000;

export function RealtimeProvider() {
  const qc = useQueryClient();
  const router = useRouter();
  const { setStatus, markEvent } = useConnection();

  const onEvent = useCallback(
    (channel: string, payload: unknown, at: string) => {
      markEvent(at);
      const p = (payload ?? {}) as Record<string, unknown>;

      switch (channel) {
        case 'signals': {
          qc.invalidateQueries({ queryKey: ['signals'] });
          const event = typeof p.event === 'string' ? p.event : '';
          if (event === 'signal:debate') {
            const inner = (p.payload ?? {}) as Record<string, unknown>;
            toast.info('Agent cycle decided', {
              description: `${inner.instrument ?? ''} → ${inner.decision ?? '—'}`,
              action: { label: 'View', onClick: () => router.push('/agents') },
            });
          }
          break;
        }
        case 'trade.fill': {
          qc.invalidateQueries({ queryKey: ['trades'] });
          if (p.status === 'rejected') {
            toast.error('Order rejected', {
              description: String(p.reasonCode ?? 'see audit log'),
              action: { label: 'Trades', onClick: () => router.push('/trades') },
            });
          } else if (typeof p.remainderUnits === 'number' && p.remainderUnits > 0) {
            // FE-120 AC — partial-fill notification, explicitly.
            toast.warning('Partial fill', {
              description: `${p.instrument ?? ''}: filled ${p.filledUnits}, remainder ${p.remainderUnits}`,
              action: { label: 'Trades', onClick: () => router.push('/trades') },
            });
          } else {
            toast.success('Order filled', {
              description: `${p.instrument ?? ''} ${p.filledUnits ?? ''} @ ${p.price ?? ''}`,
              action: { label: 'Trades', onClick: () => router.push('/trades') },
            });
          }
          break;
        }
        case 'pnl.update': {
          qc.invalidateQueries({ queryKey: ['trades'] });
          toast.info('Trade closed', {
            description: `Realized P&L ${p.realizedPnl ?? '—'} (${p.reason ?? 'close'})`,
            action: { label: 'Trades', onClick: () => router.push('/trades') },
          });
          break;
        }
        case 'risk.halt': {
          qc.invalidateQueries({ queryKey: ['kill-switch'] });
          toast.error('RISK HALT', {
            description: String(p.reason ?? 'Trading paused.'),
            duration: 10_000,
          });
          break;
        }
        case 'risk.resume': {
          qc.invalidateQueries({ queryKey: ['kill-switch'] });
          toast.success('Trading resumed', { description: 'Kill-switch released.' });
          break;
        }
        case 'reconciliation.mismatch': {
          toast.error('Reconciliation mismatch', {
            description: String(p.detail ?? 'Broker ↔ DB divergence — execution halted.'),
            duration: 10_000,
            action: { label: 'Audit', onClick: () => router.push('/audit') },
          });
          break;
        }
        case 'backtests': {
          qc.invalidateQueries({ queryKey: ['backtests'] });
          qc.invalidateQueries({ queryKey: ['backtest'] });
          const event = typeof p.event === 'string' ? p.event : '';
          if (event === 'backtest:finished') {
            toast.success('Backtest finished', {
              action: { label: 'Results', onClick: () => router.push('/backtest') },
            });
          } else if (event === 'backtest:failed') {
            toast.error('Backtest failed', {
              action: { label: 'Details', onClick: () => router.push('/backtest') },
            });
          }
          break;
        }
        case 'notifications': {
          // BE-118 — alerting-about-alerting: a Telegram/SMS send failure.
          if (p.event === 'notification:send_failed') {
            toast.warning(`Alert delivery failed (${p.channel ?? 'channel'})`, {
              description: `"${p.title ?? ''}" could not be delivered — check credentials/network.`,
            });
          }
          break;
        }
        case 'settings': {
          qc.invalidateQueries({ queryKey: ['settings'] });
          break;
        }
        default:
          break;
      }
    },
    [qc, router, markEvent],
  );

  const status = useWs({ channels: CHANNELS, onEvent });
  useEffect(() => {
    setStatus(status);
  }, [status, setStatus]);

  return <ConnectionBanner />;
}

/** FE-120 AC — reconnect banner on disconnect (aria-live for screen readers). */
function ConnectionBanner() {
  const { status, hasConnected } = useConnection();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (status === 'open' || !hasConnected) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), BANNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status, hasConnected]);

  if (!visible) return null;
  return (
    <output
      aria-live="polite"
      className="fixed inset-x-0 top-14 z-50 block border-b border-warning/40 bg-warning/15 px-4 py-1.5 text-center text-xs font-medium text-warning-foreground backdrop-blur"
    >
      Live connection lost — reconnecting… Data may be stale.
    </output>
  );
}
