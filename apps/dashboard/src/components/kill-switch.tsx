'use client';

import { Button, KillSwitchButton } from '@fx/ui';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { useKillSwitch, useKillSwitchMutation } from '@/lib/hooks';

const HALT_REASON = 'Operator manual halt from dashboard';

/**
 * FE-040 / FE-130 — the live kill-switch. Replaces the Phase-3 visible no-op:
 * `POST /settings/kill-switch` now runs behind the authenticated api-client
 * (BE-072/073). When the operator has 2FA enrolled we demand a step-up code
 * (BE-036); a missing/invalid code is handled server-side (fail-safe: a halt is
 * never blocked on 2FA infra). When already halted the button flips to a
 * deactivate affordance reading the Postgres source-of-truth state.
 */
export function KillSwitch({ compact = false }: { compact?: boolean }) {
  const { data: session } = useSession();
  const { data } = useKillSwitch();
  const mutation = useKillSwitchMutation();
  const active = data?.state.active ?? false;
  const requireCode = session?.twoFactorEnabled ?? false;

  if (active && !compact) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={mutation.isPending}
        onClick={async () => {
          try {
            await mutation.mutateAsync({ action: 'deactivate' });
            toast.success('Kill-switch deactivated', { description: 'Trading may resume.' });
          } catch (err) {
            toast.error('Deactivate failed', {
              description: err instanceof Error ? err.message : 'Retry.',
            });
          }
        }}
        className="border-destructive/60 font-mono text-xs font-bold text-destructive"
      >
        HALTED · RESUME
      </Button>
    );
  }

  return (
    <KillSwitchButton
      compact={compact}
      disabled={active || mutation.isPending}
      requireTwoFactorCode={requireCode}
      onConfirm={async ({ twoFactorCode }) => {
        const res = await mutation.mutateAsync({
          action: 'activate',
          reason: HALT_REASON,
          twoFactorCode,
        });
        toast.error('KILL-SWITCH ACTIVATED', {
          description: `Close-out ${res.closeOut?.status ?? 'requested'} in ${res.elapsedMs} ms.`,
        });
      }}
    />
  );
}
