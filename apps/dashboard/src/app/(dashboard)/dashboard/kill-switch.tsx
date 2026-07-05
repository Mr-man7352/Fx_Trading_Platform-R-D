'use client';

import { KillSwitchButton } from '@fx/ui';

/**
 * Client wrapper for <KillSwitchButton> (server pages can't pass callbacks).
 * Phase 3 (BE-072) wires `onConfirm` to POST /risk/kill; until then it's a
 * visible no-op so the composition and dialog flow are exercised end-to-end.
 */
export function KillSwitch({ compact = false }: { compact?: boolean }) {
  return (
    <KillSwitchButton
      compact={compact}
      onConfirm={async () => {
        // BE-072 (Phase 3): await api.post('/risk/kill'); until then, no-op.
        await new Promise((resolve) => setTimeout(resolve, 300));
      }}
    />
  );
}
